import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionProfileStore, ConnectionStoreBusyError, SecretStorageLike } from '../src/connectionProfileStore';
import {
  ConnectionStateFileLike,
  DisposableLike,
  WriterLease,
  WriterLeaseBusyError,
  WriterLeaseLike
} from '../src/connectionStoreFile';

const PROFILE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const PROFILE_B = 'bbbbbbbb-2222-4222-8222-222222222222';

test('a competing writer returns busy, then rereads the committed envelope before retrying', async () => {
  const file = new SharedStateFile(emptyEnvelope());
  const leases = new ExclusiveLeaseProvider();
  const storeA = createStore(file, leases, PROFILE_A);
  const storeB = createStore(file, leases, PROFILE_B);
  await storeA.initialize();
  await storeB.initialize();

  const writeStarted = deferred();
  const allowWrite = deferred();
  file.beforeNextWrite = async () => {
    writeStarted.resolve();
    await allowWrite.promise;
  };
  const addA = storeA.add({ name: 'A', serverUrl: 'https://a.example.com' });
  await writeStarted.promise;
  await assert.rejects(
    storeB.add({ name: 'B', serverUrl: 'https://b.example.com' }),
    ConnectionStoreBusyError
  );
  allowWrite.resolve();
  await addA;

  await storeB.add({ name: 'B', serverUrl: 'https://b.example.com' });
  assert.deepEqual(JSON.parse(file.state).profiles.map((profile: { id: string }) => profile.id), [PROFILE_A, PROFILE_B]);
});

test('stale-owner overlap accepts the last completed atomic envelope and Refresh converges both stores', async () => {
  const file = new OverlapStateFile(emptyEnvelope());
  const leases = new AlwaysLeaseProvider();
  const storeA = createStore(file, leases, PROFILE_A);
  const storeB = createStore(file, leases, PROFILE_B);
  await storeA.initialize();
  await storeB.initialize();

  const addA = storeA.add({ name: 'A', serverUrl: 'https://a.example.com' });
  const addB = storeB.add({ name: 'B', serverUrl: 'https://b.example.com' });
  await file.twoWritesDispatched.promise;
  file.settle(PROFILE_A);
  await addA;
  file.settle(PROFILE_B);
  await addB;

  const disk = JSON.parse(file.state) as { revision: number; profiles: Array<{ id: string }> };
  assert.equal(disk.revision, 1);
  assert.deepEqual(disk.profiles.map((profile) => profile.id), [PROFILE_B]);
  assert.deepEqual((await storeA.refresh()).map((profile) => profile.id), [PROFILE_B]);
  assert.deepEqual((await storeB.refresh()).map((profile) => profile.id), [PROFILE_B]);
});

test('watcher dirty-loop handles a change during refresh and accepts revision rollback', async () => {
  const file = new ControlledReadStateFile(emptyEnvelope());
  const store = createStore(file, new AlwaysLeaseProvider(), PROFILE_A, 0);
  await store.startWatching();
  await store.initialize();

  file.state = oneProfileEnvelope(PROFILE_A, 'A', 8);
  file.blockNextRead();
  file.emitWatch();
  await file.blockedReadStarted.promise;

  file.state = oneProfileEnvelope(PROFILE_B, 'B', 2);
  file.emitWatch();
  file.releaseBlockedRead();
  await eventually(() => store.cachedDefaultId === PROFILE_B && store.currentStatus.writable);
  assert.deepEqual((await store.list()).map((profile) => profile.id), [PROFILE_B]);

  file.state = undefined as unknown as string;
  file.emitWatch();
  await eventually(() => store.currentStatus.available && !store.currentStatus.writable);

  file.state = oneProfileEnvelope(PROFILE_A, 'A restored', 1);
  await store.refresh();
  assert.deepEqual(store.currentStatus, { available: true, writable: true });
  assert.deepEqual((await store.list()).map((profile) => profile.id), [PROFILE_A]);
});

class SharedStateFile implements ConnectionStateFileLike {
  marker = true;
  listener?: () => void;
  beforeNextWrite?: () => Promise<void>;

  constructor(public state: string) {}

  async readState(): Promise<string | undefined> {
    return this.state;
  }

  async writeState(serializedEnvelope: string): Promise<void> {
    const beforeWrite = this.beforeNextWrite;
    this.beforeNextWrite = undefined;
    await beforeWrite?.();
    this.state = serializedEnvelope;
  }

  async stateExists(): Promise<boolean> {
    return this.state !== undefined;
  }

  async markerExists(): Promise<boolean> {
    return this.marker;
  }

  async writeMarker(): Promise<void> {
    this.marker = true;
  }

  async watch(listener: () => void): Promise<DisposableLike> {
    this.listener = listener;
    return { dispose: () => { this.listener = undefined; } };
  }

  emitWatch(): void {
    this.listener?.();
  }
}

class ControlledReadStateFile extends SharedStateFile {
  blockedReadStarted = deferred();
  private readGate?: ReturnType<typeof deferred>;

  blockNextRead(): void {
    this.blockedReadStarted = deferred();
    this.readGate = deferred();
  }

  releaseBlockedRead(): void {
    this.readGate?.resolve();
  }

  override async readState(): Promise<string | undefined> {
    const gate = this.readGate;
    if (!gate) {
      return this.state;
    }
    const snapshot = this.state;
    this.blockedReadStarted.resolve();
    await gate.promise;
    if (this.readGate === gate) {
      this.readGate = undefined;
    }
    return snapshot;
  }
}

class OverlapStateFile extends SharedStateFile {
  readonly twoWritesDispatched = deferred();
  private readonly pending = new Map<string, { serialized: string; done: ReturnType<typeof deferred> }>();

  override async writeState(serializedEnvelope: string): Promise<void> {
    const parsed = JSON.parse(serializedEnvelope) as { profiles: Array<{ id: string }> };
    const id = parsed.profiles[0]?.id;
    assert.ok(id);
    const done = deferred();
    this.pending.set(id, { serialized: serializedEnvelope, done });
    if (this.pending.size === 2) {
      this.twoWritesDispatched.resolve();
    }
    await done.promise;
  }

  settle(profileId: string): void {
    const pending = this.pending.get(profileId);
    assert.ok(pending, `No pending write for ${profileId}.`);
    this.state = pending.serialized;
    this.pending.delete(profileId);
    pending.done.resolve();
  }
}

class ExclusiveLeaseProvider implements WriterLeaseLike {
  private held = false;

  async acquire(): Promise<WriterLease> {
    if (this.held) {
      throw new WriterLeaseBusyError();
    }
    this.held = true;
    return lease(() => { this.held = false; });
  }
}

class AlwaysLeaseProvider implements WriterLeaseLike {
  async acquire(): Promise<WriterLease> {
    return lease(() => undefined);
  }
}

function lease(onRelease: () => void): WriterLease {
  let released = false;
  return {
    compromised: false,
    onDidCompromise: () => ({ dispose() {} }),
    async release(): Promise<void> {
      if (!released) {
        released = true;
        onRelease();
      }
    }
  };
}

const secrets: SecretStorageLike = {
  async get(): Promise<string | undefined> { return undefined; },
  async store(): Promise<void> {},
  async delete(): Promise<void> {}
};

function createStore(
  file: ConnectionStateFileLike,
  writerLease: WriterLeaseLike,
  uuid: string,
  watchDebounceMs = 75
): ConnectionProfileStore {
  return new ConnectionProfileStore({
    stateFile: file,
    writerLease,
    secrets,
    randomUuid: () => uuid,
    now: () => 100,
    watchDebounceMs
  });
}

function emptyEnvelope(): string {
  return '{"version":1,"revision":0,"profiles":[]}\n';
}

function oneProfileEnvelope(id: string, name: string, revision: number): string {
  return `${JSON.stringify({
    version: 1,
    revision,
    profiles: [{
      id,
      name,
      serverUrl: `https://${name[0].toLowerCase()}.example.com`,
      createdAt: 100,
      updatedAt: 100
    }],
    defaultId: id
  })}\n`;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function eventually(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail('Condition was not met before timeout.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
