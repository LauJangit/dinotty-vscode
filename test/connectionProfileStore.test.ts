import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConnectionStoreEnvelopeV1,
  StoredConnectionProfile
} from '../src/connectionProfile';
import {
  ConnectionProfileNotFoundError,
  ConnectionProfileStore,
  ConnectionStoreBusyError,
  ConnectionStoreCommitOutcomeUnknownError,
  ConnectionStoreDisposedError,
  ConnectionStoreUnavailableError,
  ConnectionStoreWriteNotCommittedError,
  CredentialUnavailableError,
  DuplicateConnectionNameError,
  LegacyConnectionSource,
  SecretStorageLike,
  connectionCredentialKey
} from '../src/connectionProfileStore';
import {
  ConnectionStateFileLike,
  DisposableLike,
  WriterLease,
  WriterLeaseBusyError,
  WriterLeaseLike
} from '../src/connectionStoreFile';

const PROFILE_1 = '11111111-1111-4111-8111-111111111111';
const PROFILE_2 = '22222222-2222-4222-8222-222222222222';
const PROFILE_3 = '33333333-3333-4333-8333-333333333333';
const SLOT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SLOT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SLOT_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('initializes a fresh empty store and marks it available for writes', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets();
  const store = createStore(stateFile, leases, secrets);

  assert.equal(await store.initialize(), undefined);

  assert.deepEqual(readEnvelope(stateFile), {
    version: 1,
    revision: 0,
    profiles: []
  });
  assert.equal(stateFile.marker, true);
  assert.equal(stateFile.markerWrites, 1);
  assert.equal(leases.acquireCount, 1);
  assert.equal(leases.leases[0].released, true);
  assert.deepEqual(store.currentStatus, { available: true, writable: true });
  assert.equal(store.cachedProfileCount, 0);
  assert.equal(store.cachedDefaultId, undefined);
});

test('loads valid existing state without a writer lease and repairs a missing marker', async () => {
  const profile = storedProfile(PROFILE_1, 'Existing', 'https://existing.example.com');
  const stateFile = new MemoryStateFile(serializeEnvelope([profile], PROFILE_1, 4));
  const leases = new FakeLeaseProvider();
  const store = createStore(stateFile, leases, new MemorySecrets());

  assert.equal(await store.initialize(), undefined);

  assert.equal(leases.acquireCount, 0);
  assert.equal(stateFile.writes.length, 0);
  assert.equal(stateFile.marker, true);
  assert.equal(stateFile.markerWrites, 1);
  assert.equal(store.cachedProfileCount, 1);
  assert.equal(store.cachedDefaultId, PROFILE_1);
  assert.deepEqual(store.currentStatus, { available: true, writable: true });
});

test('migrates an explicit legacy URL and token before clearing legacy values', async () => {
  const events: string[] = [];
  const stateFile = new MemoryStateFile(undefined, events);
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets(events);
  const legacy = new FakeLegacyConnectionSource(events);
  legacy.url = ' HTTPS://Legacy.Example.com/base/ ';
  legacy.token = ' legacy-token ';
  const store = createStore(stateFile, leases, secrets, {
    legacy,
    uuids: [PROFILE_1, SLOT_1]
  });

  assert.equal(await store.initialize(), undefined);

  const envelope = readEnvelope(stateFile);
  assert.equal(envelope.revision, 0);
  assert.equal(envelope.defaultId, PROFILE_1);
  assert.deepEqual(envelope.profiles, [
    {
      id: PROFILE_1,
      name: 'legacy.example.com',
      serverUrl: 'https://legacy.example.com/base',
      createdAt: 1_000,
      updatedAt: 1_000,
      credentialSlot: SLOT_1
    }
  ]);
  assert.equal(secrets.values.get(connectionCredentialKey(SLOT_1)), 'legacy-token');
  assert.equal(stateFile.state?.includes('legacy-token'), false);
  assert.equal(legacy.clearUrlCalls, 1);
  assert.equal(legacy.clearTokenCalls, 1);
  assertBefore(events, `secret:store:${connectionCredentialKey(SLOT_1)}`, 'state:write');
  assertBefore(events, 'state:write', 'legacy:clear-url');
  assertBefore(events, 'state:write', 'legacy:clear-token');
});

test('migrates a legacy URL without inventing a credential', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets();
  const legacy = new FakeLegacyConnectionSource();
  legacy.url = 'http://127.0.0.1:8999/';
  const store = createStore(stateFile, leases, secrets, {
    legacy,
    uuids: [PROFILE_1]
  });

  assert.equal(await store.initialize(), undefined);

  const envelope = readEnvelope(stateFile);
  assert.equal(envelope.profiles.length, 1);
  assert.equal(envelope.profiles[0].serverUrl, 'http://127.0.0.1:8999');
  assert.equal(envelope.profiles[0].credentialSlot, undefined);
  assert.equal(secrets.gets.length, 0);
  assert.equal(secrets.stores.length, 0);
  assert.equal(legacy.clearUrlCalls, 1);
  assert.equal(legacy.clearTokenCalls, 0);
});

test('leaves token-only legacy settings untouched and reports incomplete migration', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets();
  const legacy = new FakeLegacyConnectionSource();
  legacy.token = 'orphan-token';
  const store = createStore(stateFile, leases, secrets, { legacy });

  const notice = await store.initialize();

  assert.equal(notice?.kind, 'incomplete');
  assert.deepEqual(readEnvelope(stateFile), {
    version: 1,
    revision: 0,
    profiles: []
  });
  assert.equal(secrets.gets.length, 0);
  assert.equal(secrets.stores.length, 0);
  assert.equal(legacy.clearUrlCalls, 0);
  assert.equal(legacy.clearTokenCalls, 0);
});

test('does not initialize state when reading the legacy secret fails transiently', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets();
  const legacy = new FakeLegacyConnectionSource();
  legacy.url = 'https://legacy.example.com';
  legacy.tokenError = new Error('secret service is temporarily unavailable');
  const store = createStore(stateFile, leases, secrets, { legacy });

  await assert.rejects(store.initialize(), /secret service is temporarily unavailable/);

  assert.equal(stateFile.state, undefined);
  assert.equal(stateFile.marker, false);
  assert.equal(stateFile.writes.length, 0);
  assert.equal(stateFile.markerWrites, 0);
  assert.equal(secrets.stores.length, 0);
  assert.equal(leases.leases[0].released, true);
});

test('validates the derived legacy profile before writing a migrated credential', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets();
  const legacy = new FakeLegacyConnectionSource();
  legacy.url = `https://${'a'.repeat(40)}.${'b'.repeat(40)}.com`;
  legacy.token = 'must-not-be-copied';
  const store = createStore(stateFile, leases, secrets, {
    legacy,
    uuids: [PROFILE_1, SLOT_1]
  });

  const notice = await store.initialize();

  assert.equal(notice?.kind, 'invalid');
  assert.deepEqual(readEnvelope(stateFile).profiles, []);
  assert.deepEqual(secrets.gets, []);
  assert.deepEqual(secrets.stores, []);
  assert.equal(legacy.clearUrlCalls, 0);
  assert.equal(legacy.clearTokenCalls, 0);
});

test('supports CRUD and selects the successor or wraps when deleting the default', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const store = createStore(stateFile, leases, new MemorySecrets(), {
    uuids: [PROFILE_1, PROFILE_2, PROFILE_3]
  });
  await store.initialize();

  const first = await store.add({
    name: 'Local',
    serverUrl: 'http://127.0.0.1:8999'
  });
  assert.equal(first.id, PROFILE_1);
  assert.equal(await store.getDefaultId(), PROFILE_1);
  assert.deepEqual(await store.get(PROFILE_1), first);

  await store.add({ name: 'Staging', serverUrl: 'https://staging.example.com' });
  await store.add({ name: 'Production', serverUrl: 'https://production.example.com' });
  const updated = await store.update(PROFILE_1, {
    name: 'Local renamed',
    serverUrl: 'http://localhost:8999/base/',
    credential: { kind: 'keep' }
  });
  assert.equal(updated.name, 'Local renamed');
  assert.equal(updated.serverUrl, 'http://localhost:8999/base');
  assert.equal(updated.createdAt, first.createdAt);
  assert.ok(updated.updatedAt > first.updatedAt);

  await store.setDefault(PROFILE_2);
  await store.delete(PROFILE_2);
  assert.equal(await store.getDefaultId(), PROFILE_3);

  await store.delete(PROFILE_3);
  assert.equal(await store.getDefaultId(), PROFILE_1);

  await store.delete(PROFILE_1);
  assert.equal(await store.getDefaultId(), undefined);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get(PROFILE_1), undefined);
  await assert.rejects(store.setDefault(PROFILE_1), ConnectionProfileNotFoundError);
});

test('keeps the operation queue usable after a normalized duplicate-name rejection', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const store = createStore(stateFile, leases, new MemorySecrets(), {
    uuids: [PROFILE_1, PROFILE_2]
  });
  await store.initialize();
  stateFile.writes.length = 0;

  await store.add({ name: 'Local', serverUrl: 'http://127.0.0.1:8999' });
  await assert.rejects(
    store.add({ name: ' ＬＯＣＡＬ ', serverUrl: 'https://duplicate.example.com' }),
    DuplicateConnectionNameError
  );
  const second = await store.add({ name: 'Remote', serverUrl: 'https://remote.example.com' });

  assert.equal(second.id, PROFILE_2);
  assert.deepEqual((await store.list()).map((profile) => profile.name), ['Local', 'Remote']);
  assert.equal(stateFile.writes.length, 2);
  assert.equal(leases.leases.every((lease) => lease.released), true);
});

test('stores, keeps, replaces, and clears credentials in commit-safe order', async () => {
  const events: string[] = [];
  const stateFile = new MemoryStateFile(undefined, events);
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets(events);
  const store = createStore(stateFile, leases, secrets, {
    uuids: [PROFILE_1, SLOT_1, SLOT_2]
  });
  await store.initialize();
  resetActivity(stateFile, secrets, events);

  await store.add({
    name: 'Remote',
    serverUrl: 'http://remote.example.com',
    accessToken: 'first-token'
  });
  assert.equal(readEnvelope(stateFile).profiles[0].serverUrl, 'http://remote.example.com');
  assert.equal(readEnvelope(stateFile).profiles[0].credentialSlot, SLOT_1);
  assert.deepEqual(secrets.stores, [[connectionCredentialKey(SLOT_1), 'first-token']]);
  assertBefore(events, `secret:store:${connectionCredentialKey(SLOT_1)}`, 'state:write');

  resetActivity(stateFile, secrets, events);
  await store.update(PROFILE_1, {
    name: 'Remote kept',
    serverUrl: 'http://remote.example.com/v2',
    credential: { kind: 'keep' }
  });
  assert.equal(readEnvelope(stateFile).profiles[0].serverUrl, 'http://remote.example.com/v2');
  assert.equal(readEnvelope(stateFile).profiles[0].credentialSlot, SLOT_1);
  assert.deepEqual(secrets.gets, [connectionCredentialKey(SLOT_1)]);
  assert.deepEqual(secrets.stores, []);
  assert.deepEqual(secrets.deletes, []);

  resetActivity(stateFile, secrets, events);
  await store.update(PROFILE_1, {
    name: 'Remote replaced',
    serverUrl: 'https://remote.example.com/v3',
    credential: { kind: 'replace', accessToken: 'second-token' }
  });
  assert.equal(readEnvelope(stateFile).profiles[0].credentialSlot, SLOT_2);
  assert.equal(secrets.values.get(connectionCredentialKey(SLOT_2)), 'second-token');
  assert.equal(secrets.values.has(connectionCredentialKey(SLOT_1)), false);
  assertBefore(events, `secret:store:${connectionCredentialKey(SLOT_2)}`, 'state:write');
  assertBefore(events, 'state:write', `secret:delete:${connectionCredentialKey(SLOT_1)}`);

  resetActivity(stateFile, secrets, events);
  await store.update(PROFILE_1, {
    name: 'Remote cleared',
    serverUrl: 'https://remote.example.com/v4',
    credential: { kind: 'clear' }
  });
  assert.equal(readEnvelope(stateFile).profiles[0].credentialSlot, undefined);
  assert.equal(secrets.values.has(connectionCredentialKey(SLOT_2)), false);
  assert.deepEqual(secrets.stores, []);
  assertBefore(events, 'state:write', `secret:delete:${connectionCredentialKey(SLOT_2)}`);
  assert.equal('accessToken' in await store.resolve(PROFILE_1), false);
});

test('keeps updatedAt monotonic when the system clock moves backwards', async () => {
  const profile: StoredConnectionProfile = {
    id: PROFILE_1,
    name: 'Future',
    serverUrl: 'https://future.example.com',
    createdAt: 5_000,
    updatedAt: 5_000
  };
  const stateFile = new MemoryStateFile(serializeEnvelope([profile], PROFILE_1));
  stateFile.marker = true;
  const secrets = new MemorySecrets();
  const store = createStore(stateFile, new FakeLeaseProvider(), secrets, { uuids: [SLOT_1] });
  await store.initialize();

  await store.update(PROFILE_1, {
    name: 'Future',
    serverUrl: 'https://future.example.com',
    credential: { kind: 'replace', accessToken: 'new-token' }
  });

  assert.equal(readEnvelope(stateFile).profiles[0].updatedAt, 5_000);
  assert.equal(secrets.values.get(connectionCredentialKey(SLOT_1)), 'new-token');
});

test('skips slots referenced by metadata or occupied by an orphan secret', async () => {
  const existing = storedProfile(PROFILE_1, 'Existing', 'https://existing.example.com', SLOT_1);
  const stateFile = new MemoryStateFile(serializeEnvelope([existing], PROFILE_1));
  stateFile.marker = true;
  const secrets = new MemorySecrets();
  secrets.values.set(connectionCredentialKey(SLOT_1), 'existing-token');
  secrets.values.set(connectionCredentialKey(SLOT_2), 'orphan-token');
  const store = createStore(stateFile, new FakeLeaseProvider(), secrets, {
    uuids: [PROFILE_2, SLOT_1, SLOT_2, SLOT_3]
  });
  await store.initialize();

  await store.add({
    name: 'New',
    serverUrl: 'https://new.example.com',
    accessToken: 'new-token'
  });

  assert.equal(readEnvelope(stateFile).profiles[1].credentialSlot, SLOT_3);
  assert.equal(secrets.values.get(connectionCredentialKey(SLOT_2)), 'orphan-token');
  assert.equal(secrets.values.get(connectionCredentialKey(SLOT_3)), 'new-token');
});

test('keeps a freshly written credential as an orphan when metadata commit is not completed', async () => {
  const stateFile = new MemoryStateFile();
  const secrets = new MemorySecrets();
  const store = createStore(stateFile, new FakeLeaseProvider(), secrets, {
    uuids: [PROFILE_1, SLOT_1]
  });
  await store.initialize();
  const originalState = stateFile.state;
  stateFile.writeError = new Error('atomic replace failed');

  await assert.rejects(
    store.add({
      name: 'Orphaned',
      serverUrl: 'https://orphaned.example.com',
      accessToken: 'orphan-token'
    }),
    ConnectionStoreWriteNotCommittedError
  );

  assert.equal(stateFile.state, originalState);
  assert.equal(secrets.values.get(connectionCredentialKey(SLOT_1)), 'orphan-token');
  assert.deepEqual(secrets.deletes, []);
  assert.equal(store.cachedProfileCount, 0);
});

test('rejects a saturated revision before allocating or writing a credential', async () => {
  const stateFile = new MemoryStateFile(serializeEnvelope([], undefined, Number.MAX_SAFE_INTEGER));
  stateFile.marker = true;
  const secrets = new MemorySecrets();
  const store = createStore(stateFile, new FakeLeaseProvider(), secrets);
  await store.initialize();

  await assert.rejects(
    store.add({
      name: 'No write',
      serverUrl: 'https://no-write.example.com',
      accessToken: 'must-not-be-written'
    }),
    ConnectionStoreWriteNotCommittedError
  );
  assert.deepEqual(secrets.gets, []);
  assert.deepEqual(secrets.stores, []);
  assert.equal(stateFile.writes.length, 0);
});

test('rejects keep when the declared credential is missing without changing metadata', async () => {
  const profile = storedProfile(PROFILE_1, 'Remote', 'https://remote.example.com', SLOT_1);
  const stateFile = new MemoryStateFile(serializeEnvelope([profile], PROFILE_1));
  stateFile.marker = true;
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets();
  const store = createStore(stateFile, leases, secrets);
  await store.initialize();
  const originalState = stateFile.state;

  await assert.rejects(
    store.update(PROFILE_1, {
      name: 'Remote renamed',
      serverUrl: 'https://remote.example.com',
      credential: { kind: 'keep' }
    }),
    (error: unknown) => error instanceof CredentialUnavailableError && error.profileId === PROFILE_1
  );

  assert.equal(stateFile.state, originalState);
  assert.equal(stateFile.writes.length, 0);
  assert.deepEqual(secrets.stores, []);
  assert.deepEqual(secrets.deletes, []);
  assert.equal(leases.leases[0].released, true);
});

test('isolates a missing secret to the affected profile during resolution', async () => {
  const profiles = [
    storedProfile(PROFILE_1, 'Missing', 'https://missing.example.com', SLOT_1),
    storedProfile(PROFILE_2, 'Working', 'https://working.example.com', SLOT_2)
  ];
  const stateFile = new MemoryStateFile(serializeEnvelope(profiles, PROFILE_1));
  stateFile.marker = true;
  const secrets = new MemorySecrets();
  secrets.values.set(connectionCredentialKey(SLOT_2), 'working-token');
  const store = createStore(stateFile, new FakeLeaseProvider(), secrets);
  await store.initialize();

  await assert.rejects(
    store.resolve(PROFILE_1),
    (error: unknown) => error instanceof CredentialUnavailableError && error.profileId === PROFILE_1
  );
  assert.equal((await store.resolve(PROFILE_2)).accessToken, 'working-token');
  assert.deepEqual(store.currentStatus, { available: true, writable: true });
});

test('maps a busy writer lease without state, secret, or status side effects', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets();
  const store = createStore(stateFile, leases, secrets);
  await store.initialize();
  const originalState = stateFile.state;
  stateFile.writes.length = 0;
  leases.busy = true;

  await assert.rejects(
    store.add({
      name: 'Busy',
      serverUrl: 'https://busy.example.com',
      accessToken: 'unused-token'
    }),
    ConnectionStoreBusyError
  );

  assert.equal(stateFile.state, originalState);
  assert.equal(stateFile.writes.length, 0);
  assert.deepEqual(secrets.gets, []);
  assert.deepEqual(secrets.stores, []);
  assert.deepEqual(secrets.deletes, []);
  assert.deepEqual(store.currentStatus, { available: true, writable: true });
});

test('rejects operations that have not started when the store is disposed', async () => {
  const stateFile = new MemoryStateFile();
  const secrets = new MemorySecrets();
  const store = createStore(stateFile, new FakeLeaseProvider(), secrets, { uuids: [PROFILE_1] });
  await store.initialize();
  stateFile.writes.length = 0;
  store.dispose();

  await assert.rejects(store.list(), ConnectionStoreDisposedError);
  await assert.rejects(
    store.add({ name: 'Too late', serverUrl: 'https://late.example.com', accessToken: 'unused' }),
    ConnectionStoreDisposedError
  );
  assert.equal(stateFile.writes.length, 0);
  assert.deepEqual(secrets.stores, []);
});

test('serves the last valid cache while degraded and returns to writable after recovery', async () => {
  const profile = storedProfile(PROFILE_1, 'Cached', 'https://cached.example.com');
  const stateFile = new MemoryStateFile(serializeEnvelope([profile], PROFILE_1));
  stateFile.marker = true;
  const store = createStore(stateFile, new FakeLeaseProvider(), new MemorySecrets());
  await store.initialize();

  stateFile.readError = new Error('temporary read failure');
  assert.deepEqual((await store.list()).map((candidate) => candidate.id), [PROFILE_1]);
  assert.equal(store.currentStatus.available, true);
  assert.equal(store.currentStatus.writable, false);
  assert.equal(store.currentStatus.lastError, 'The Dinotty connection store could not be read.');

  stateFile.readError = undefined;
  assert.deepEqual((await store.refresh()).map((candidate) => candidate.id), [PROFILE_1]);
  assert.deepEqual(store.currentStatus, { available: true, writable: true });

  const coldStateFile = new MemoryStateFile();
  coldStateFile.readError = new Error('cold read failure');
  const coldStore = createStore(coldStateFile, new FakeLeaseProvider(), new MemorySecrets());
  await assert.rejects(coldStore.list(), ConnectionStoreUnavailableError);
  assert.equal(coldStore.currentStatus.available, false);
  assert.equal(coldStore.currentStatus.writable, false);
});

test('reports an uncommitted write when the lease is compromised before state-write dispatch', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const secrets = new MemorySecrets();
  const store = createStore(stateFile, leases, secrets, {
    uuids: [PROFILE_1, SLOT_1]
  });
  await store.initialize();
  const originalState = stateFile.state;
  stateFile.writes.length = 0;
  const compromisedLease = new FakeLease();
  leases.nextLease = compromisedLease;
  secrets.onStore = () => compromisedLease.compromise();

  await assert.rejects(
    store.add({
      name: 'Uncommitted',
      serverUrl: 'https://uncommitted.example.com',
      accessToken: 'orphaned-token'
    }),
    ConnectionStoreWriteNotCommittedError
  );

  assert.equal(stateFile.state, originalState);
  assert.equal(stateFile.writes.length, 0);
  assert.equal(secrets.values.get(connectionCredentialKey(SLOT_1)), 'orphaned-token');
  assert.equal(compromisedLease.released, true);
  assert.equal(store.cachedProfileCount, 0);
});

test('reports an unknown outcome and refreshes committed state after post-dispatch compromise', async () => {
  const stateFile = new MemoryStateFile();
  const leases = new FakeLeaseProvider();
  const store = createStore(stateFile, leases, new MemorySecrets(), {
    uuids: [PROFILE_1]
  });
  await store.initialize();
  stateFile.writes.length = 0;
  const compromisedLease = new FakeLease();
  leases.nextLease = compromisedLease;
  const dispatched = deferred<void>();
  const allowWriteToSettle = deferred<void>();
  stateFile.onWrite = async () => {
    compromisedLease.compromise();
    dispatched.resolve();
    await allowWriteToSettle.promise;
  };

  const pendingAdd = store.add({
    name: 'Possibly committed',
    serverUrl: 'https://committed.example.com'
  });
  await dispatched.promise;
  assert.equal(readEnvelope(stateFile).profiles[0].id, PROFILE_1);
  assert.equal(compromisedLease.released, false);

  allowWriteToSettle.resolve();
  await assert.rejects(pendingAdd, ConnectionStoreCommitOutcomeUnknownError);

  assert.equal(compromisedLease.released, true);
  assert.equal(stateFile.writes.length, 1);
  assert.equal(store.cachedProfileCount, 1);
  assert.equal(store.cachedDefaultId, PROFILE_1);
  assert.deepEqual(store.currentStatus, { available: true, writable: true });
  assert.deepEqual((await store.list()).map((profile) => profile.id), [PROFILE_1]);
});

class MemoryStateFile implements ConnectionStateFileLike {
  state: string | undefined;
  marker = false;
  readError?: Error;
  writeError?: Error;
  markerError?: Error;
  readonly writes: string[] = [];
  markerWrites = 0;
  readCalls = 0;
  listener?: () => void;
  onWrite?: (serializedEnvelope: string) => Promise<void> | void;

  constructor(state?: string, private readonly events?: string[]) {
    this.state = state;
  }

  async readState(): Promise<string | undefined> {
    this.readCalls += 1;
    if (this.readError) {
      throw this.readError;
    }
    return this.state;
  }

  async writeState(serializedEnvelope: string): Promise<void> {
    this.writes.push(serializedEnvelope);
    this.events?.push('state:write');
    if (this.writeError) {
      throw this.writeError;
    }
    this.state = serializedEnvelope;
    await this.onWrite?.(serializedEnvelope);
  }

  async stateExists(): Promise<boolean> {
    return this.state !== undefined;
  }

  async markerExists(): Promise<boolean> {
    return this.marker;
  }

  async writeMarker(): Promise<void> {
    this.markerWrites += 1;
    this.events?.push('state:marker');
    if (this.markerError) {
      throw this.markerError;
    }
    this.marker = true;
  }

  async watch(listener: () => void): Promise<DisposableLike> {
    this.listener = listener;
    return {
      dispose: () => {
        if (this.listener === listener) {
          this.listener = undefined;
        }
      }
    };
  }

  emitWatch(): void {
    this.listener?.();
  }
}

class MemorySecrets implements SecretStorageLike {
  readonly values = new Map<string, string>();
  readonly gets: string[] = [];
  readonly stores: Array<[string, string]> = [];
  readonly deletes: string[] = [];
  getError?: Error;
  storeError?: Error;
  deleteError?: Error;
  onStore?: (key: string, value: string) => Promise<void> | void;

  constructor(private readonly events?: string[]) {}

  async get(key: string): Promise<string | undefined> {
    this.gets.push(key);
    this.events?.push(`secret:get:${key}`);
    if (this.getError) {
      throw this.getError;
    }
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.stores.push([key, value]);
    this.events?.push(`secret:store:${key}`);
    if (this.storeError) {
      throw this.storeError;
    }
    this.values.set(key, value);
    await this.onStore?.(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.events?.push(`secret:delete:${key}`);
    if (this.deleteError) {
      throw this.deleteError;
    }
    this.values.delete(key);
  }
}

class FakeLease implements WriterLease {
  compromised = false;
  released = false;
  releaseCalls = 0;
  private readonly listeners = new Set<(error: Error) => void>();

  onDidCompromise(listener: (error: Error) => void): DisposableLike {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  compromise(error = new Error('writer lease compromised')): void {
    this.compromised = true;
    for (const listener of [...this.listeners]) {
      listener(error);
    }
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    this.released = true;
    this.listeners.clear();
  }
}

class FakeLeaseProvider implements WriterLeaseLike {
  busy = false;
  nextLease?: FakeLease;
  acquireCount = 0;
  readonly leases: FakeLease[] = [];

  async acquire(): Promise<WriterLease> {
    this.acquireCount += 1;
    if (this.busy) {
      throw new WriterLeaseBusyError();
    }
    const lease = this.nextLease ?? new FakeLease();
    this.nextLease = undefined;
    this.leases.push(lease);
    return lease;
  }
}

class FakeLegacyConnectionSource implements LegacyConnectionSource {
  url?: string;
  token?: string;
  tokenError?: Error;
  clearUrlCalls = 0;
  clearTokenCalls = 0;

  constructor(private readonly events?: string[]) {}

  getGlobalServerUrl(): string | undefined {
    this.events?.push('legacy:get-url');
    return this.url;
  }

  async getAccessToken(): Promise<string | undefined> {
    this.events?.push('legacy:get-token');
    if (this.tokenError) {
      throw this.tokenError;
    }
    return this.token;
  }

  async clearGlobalServerUrl(): Promise<void> {
    this.clearUrlCalls += 1;
    this.events?.push('legacy:clear-url');
  }

  async clearAccessToken(): Promise<void> {
    this.clearTokenCalls += 1;
    this.events?.push('legacy:clear-token');
  }
}

interface StoreOptions {
  readonly legacy?: LegacyConnectionSource;
  readonly uuids?: readonly string[];
}

function createStore(
  stateFile: MemoryStateFile,
  writerLease: FakeLeaseProvider,
  secrets: MemorySecrets,
  options: StoreOptions = {}
): ConnectionProfileStore {
  let timestamp = 1_000;
  return new ConnectionProfileStore({
    stateFile,
    writerLease,
    secrets,
    ...(options.legacy ? { legacy: options.legacy } : {}),
    randomUuid: uuidSequence(options.uuids ?? []),
    now: () => timestamp++
  });
}

function uuidSequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    assert.ok(value, `Unexpected UUID allocation at index ${index}.`);
    index += 1;
    return value;
  };
}

function storedProfile(
  id: string,
  name: string,
  serverUrl: string,
  credentialSlot?: string
): StoredConnectionProfile {
  return {
    id,
    name,
    serverUrl,
    createdAt: 100,
    updatedAt: 100,
    ...(credentialSlot ? { credentialSlot } : {})
  };
}

function serializeEnvelope(
  profiles: readonly StoredConnectionProfile[],
  defaultId?: string,
  revision = 0
): string {
  return `${JSON.stringify({
    version: 1,
    revision,
    profiles,
    ...(defaultId ? { defaultId } : {})
  }, null, 2)}\n`;
}

function readEnvelope(stateFile: MemoryStateFile): ConnectionStoreEnvelopeV1 {
  const serialized = stateFile.state;
  assert.ok(serialized, 'Expected the in-memory state file to exist.');
  return JSON.parse(serialized) as ConnectionStoreEnvelopeV1;
}

function resetActivity(stateFile: MemoryStateFile, secrets: MemorySecrets, events: string[]): void {
  stateFile.writes.length = 0;
  secrets.gets.length = 0;
  secrets.stores.length = 0;
  secrets.deletes.length = 0;
  events.length = 0;
}

function assertBefore(events: readonly string[], earlier: string, later: string): void {
  const earlierIndex = events.indexOf(earlier);
  const laterIndex = events.indexOf(later);
  assert.notEqual(earlierIndex, -1, `Missing event: ${earlier}`);
  assert.notEqual(laterIndex, -1, `Missing event: ${later}`);
  assert.ok(earlierIndex < laterIndex, `Expected ${earlier} before ${later}: ${events.join(', ')}`);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
