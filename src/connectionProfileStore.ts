import {
  AddConnectionInput,
  ConnectionProfileValidationError,
  ConnectionStoreEnvelopeV1,
  CredentialChange,
  DinottyConnectionProfile,
  ResolvedDinottyConnection,
  StoredConnectionProfile,
  UpdateConnectionInput,
  connectionNameKey,
  isCanonicalUuid,
  normalizeAccessToken,
  normalizeConnectionName,
  normalizeServerUrl,
  validateConnectionSecurity,
  validateConnectionStoreEnvelope
} from './connectionProfile';
import { randomUUID } from 'crypto';
import {
  ConnectionStateFileLike,
  DisposableLike,
  WriterLease,
  WriterLeaseBusyError,
  WriterLeaseLike
} from './connectionStoreFile';

const CREDENTIAL_KEY_PREFIX = 'dinotty.connectionCredential.v1.';
const WATCH_DEBOUNCE_MS = 75;
const MAX_UUID_ATTEMPTS = 32;

export interface SecretStorageLike {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface LegacyConnectionSource {
  getGlobalServerUrl(): string | undefined;
  getAccessToken(): Promise<string | undefined>;
  clearGlobalServerUrl(): Promise<void>;
  clearAccessToken(): Promise<void>;
}

export interface ConnectionStoreStatus {
  readonly available: boolean;
  readonly writable: boolean;
  readonly lastError?: string;
}

export interface ConnectionStoreChangeEvent {
  readonly profilesChanged: boolean;
  readonly status: ConnectionStoreStatus;
}

export interface MigrationNotice {
  readonly kind: 'incomplete' | 'invalid';
  readonly message: string;
}

export interface ConnectionProfileStoreOptions {
  readonly stateFile: ConnectionStateFileLike;
  readonly writerLease: WriterLeaseLike;
  readonly secrets: SecretStorageLike;
  readonly legacy?: LegacyConnectionSource;
  readonly randomUuid?: () => string;
  readonly now?: () => number;
  readonly logger?: (message: string) => void;
  readonly watchDebounceMs?: number;
}

export class ConnectionStoreBusyError extends Error {
  constructor() {
    super('Connections are being updated in another VS Code window. Refresh and try again.');
    this.name = 'ConnectionStoreBusyError';
  }
}

export class ConnectionStoreUnavailableError extends Error {
  constructor(message = 'The Dinotty connection store is unavailable.') {
    super(message);
    this.name = 'ConnectionStoreUnavailableError';
  }
}

export class ConnectionStoreDisposedError extends Error {
  constructor() {
    super('The Dinotty connection store is no longer active.');
    this.name = 'ConnectionStoreDisposedError';
  }
}

export class ConnectionStoreWriteNotCommittedError extends Error {
  constructor(message = 'The connection change was not committed. Refresh and try again.') {
    super(message);
    this.name = 'ConnectionStoreWriteNotCommittedError';
  }
}

export class ConnectionStoreCommitOutcomeUnknownError extends Error {
  constructor() {
    super('The connection change may have been committed. Refresh before trying again.');
    this.name = 'ConnectionStoreCommitOutcomeUnknownError';
  }
}

export class ConnectionProfileNotFoundError extends Error {
  constructor() {
    super('The selected connection no longer exists. Refresh and try again.');
    this.name = 'ConnectionProfileNotFoundError';
  }
}

export class DuplicateConnectionNameError extends Error {
  constructor() {
    super('A connection with that name already exists.');
    this.name = 'DuplicateConnectionNameError';
  }
}

export class CredentialUnavailableError extends Error {
  constructor(public readonly profileId: string) {
    super('The saved access code is unavailable. Edit the connection to replace or clear it.');
    this.name = 'CredentialUnavailableError';
  }
}

interface MutationContext {
  readonly envelope: ConnectionStoreEnvelopeV1;
  assertLeaseActive(): void;
  storeFreshCredential(accessToken: string): Promise<string>;
}

interface MutationPlan<T> {
  readonly envelope: ConnectionStoreEnvelopeV1;
  readonly result: T;
  readonly cleanupSlots?: readonly string[];
}

export class ConnectionProfileStore implements DisposableLike {
  private envelope?: ConnectionStoreEnvelopeV1;
  private canonicalEnvelope?: string;
  private status: ConnectionStoreStatus = Object.freeze({ available: false, writable: false });
  private readonly listeners = new Set<(event: ConnectionStoreChangeEvent) => void>();
  private operationQueue: Promise<void> = Promise.resolve();
  private watcher?: DisposableLike;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private watcherRefreshRunning = false;
  private watcherDirty = false;
  private disposed = false;

  private readonly randomUuid: () => string;
  private readonly now: () => number;
  private readonly watchDebounceMs: number;

  constructor(private readonly options: ConnectionProfileStoreOptions) {
    this.randomUuid = options.randomUuid ?? defaultRandomUuid;
    this.now = options.now ?? Date.now;
    this.watchDebounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
  }

  get currentStatus(): ConnectionStoreStatus {
    return this.status;
  }

  get cachedDefaultId(): string | undefined {
    return this.envelope?.defaultId;
  }

  get cachedProfileCount(): number {
    return this.envelope?.profiles.length ?? 0;
  }

  onDidChange(listener: (event: ConnectionStoreChangeEvent) => void): DisposableLike {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async startWatching(): Promise<void> {
    if (this.watcher || this.disposed) {
      return;
    }
    this.watcher = await this.options.stateFile.watch(() => this.handleWatchEvent());
  }

  async initialize(): Promise<MigrationNotice | undefined> {
    this.assertStoreActive();
    try {
      const serialized = await this.options.stateFile.readState();
      if (serialized !== undefined) {
        const envelope = parseEnvelope(serialized);
        this.acceptEnvelope(envelope);
        await this.tryEnsureMarker();
        return undefined;
      }

      if (await this.options.stateFile.markerExists()) {
        throw new ConnectionStoreUnavailableError('The initialized connection-store file is missing.');
      }
    } catch (error) {
      this.recordReadFailure(error);
      throw asUnavailableError(error);
    }

    return this.enqueue(() => this.initializeFirstStore());
  }

  async refresh(): Promise<readonly DinottyConnectionProfile[]> {
    return this.enqueue(() => {
      this.assertStoreActive();
      return this.refreshWithoutQueue();
    });
  }

  async list(): Promise<readonly DinottyConnectionProfile[]> {
    return this.enqueue(async () => {
      this.assertStoreActive();
      const envelope = await this.readForUse();
      return publicProfiles(envelope.profiles);
    });
  }

  async get(id: string): Promise<DinottyConnectionProfile | undefined> {
    return this.enqueue(async () => {
      this.assertStoreActive();
      const envelope = await this.readForUse();
      const profile = envelope.profiles.find((candidate) => candidate.id === id);
      return profile ? publicProfile(profile) : undefined;
    });
  }

  async getDefaultId(): Promise<string | undefined> {
    return this.enqueue(async () => {
      this.assertStoreActive();
      const envelope = await this.readForUse();
      return envelope.defaultId;
    });
  }

  async resolve(id: string): Promise<ResolvedDinottyConnection> {
    return this.enqueue(() => {
      this.assertStoreActive();
      return this.resolveWithoutQueue(id);
    });
  }

  private async refreshWithoutQueue(): Promise<readonly DinottyConnectionProfile[]> {
    try {
      const envelope = await this.readEnvelopeFromDisk();
      this.acceptEnvelope(envelope);
      return publicProfiles(envelope.profiles);
    } catch (error) {
      this.recordReadFailure(error);
      throw asUnavailableError(error);
    }
  }

  private async resolveWithoutQueue(id: string): Promise<ResolvedDinottyConnection> {
    const envelope = await this.readForUse();
    const stored = envelope.profiles.find((candidate) => candidate.id === id);
    if (!stored) {
      throw new ConnectionProfileNotFoundError();
    }

    const profile = publicProfile(stored);
    if (!stored.credentialSlot) {
      return Object.freeze({ ...profile });
    }

    let accessToken: string | undefined;
    try {
      accessToken = await this.options.secrets.get(credentialKey(stored.credentialSlot));
    } catch {
      throw new CredentialUnavailableError(id);
    }
    if (accessToken === undefined) {
      throw new CredentialUnavailableError(id);
    }
    return Object.freeze({ ...profile, accessToken });
  }

  async add(input: AddConnectionInput): Promise<DinottyConnectionProfile> {
    const normalized = normalizeAddInput(input);
    return this.mutate(async (context) => {
      assertUniqueName(context.envelope, normalized.name);
      const revision = nextRevision(context.envelope.revision);
      const id = createUniqueUuid(this.randomUuid, new Set(context.envelope.profiles.map((profile) => profile.id)));
      const timestamp = validatedTimestamp(this.now());
      const credentialSlot = normalized.accessToken === undefined
        ? undefined
        : await context.storeFreshCredential(normalized.accessToken);
      const stored: StoredConnectionProfile = Object.freeze({
        id,
        name: normalized.name,
        serverUrl: normalized.serverUrl,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(credentialSlot ? { credentialSlot } : {})
      });
      const profiles = [...context.envelope.profiles, stored];
      return {
        envelope: makeEnvelope(
          revision,
          profiles,
          context.envelope.defaultId ?? id
        ),
        result: publicProfile(stored)
      };
    });
  }

  async update(id: string, input: UpdateConnectionInput): Promise<DinottyConnectionProfile> {
    const name = normalizeConnectionName(input.name);
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const credential = normalizeCredentialChange(input.credential);

    return this.mutate(async (context) => {
      const index = context.envelope.profiles.findIndex((profile) => profile.id === id);
      if (index < 0) {
        throw new ConnectionProfileNotFoundError();
      }
      assertUniqueName(context.envelope, name, id);
      const revision = nextRevision(context.envelope.revision);
      const current = context.envelope.profiles[index];
      const updatedAt = Math.max(validatedTimestamp(this.now()), current.createdAt, current.updatedAt);
      let credentialSlot = current.credentialSlot;
      let effectiveToken: string | undefined;
      let newSlot: string | undefined;

      if (credential.kind === 'keep' && current.credentialSlot) {
        try {
          effectiveToken = await this.options.secrets.get(credentialKey(current.credentialSlot));
        } catch {
          throw new CredentialUnavailableError(id);
        }
        if (effectiveToken === undefined) {
          throw new CredentialUnavailableError(id);
        }
      } else if (credential.kind === 'replace') {
        effectiveToken = credential.accessToken;
        validateConnectionSecurity(serverUrl, effectiveToken);
        newSlot = await context.storeFreshCredential(effectiveToken);
        credentialSlot = newSlot;
      } else if (credential.kind === 'clear') {
        credentialSlot = undefined;
      }

      validateConnectionSecurity(serverUrl, effectiveToken);
      const updated: StoredConnectionProfile = Object.freeze({
        id: current.id,
        name,
        serverUrl,
        createdAt: current.createdAt,
        updatedAt,
        ...(credentialSlot ? { credentialSlot } : {})
      });
      const profiles = [...context.envelope.profiles];
      profiles[index] = updated;
      const shouldCleanup = current.credentialSlot && current.credentialSlot !== newSlot && credential.kind !== 'keep';
      return {
        envelope: makeEnvelope(revision, profiles, context.envelope.defaultId),
        result: publicProfile(updated),
        cleanupSlots: shouldCleanup ? [current.credentialSlot!] : undefined
      };
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate(async (context) => {
      const index = context.envelope.profiles.findIndex((profile) => profile.id === id);
      if (index < 0) {
        throw new ConnectionProfileNotFoundError();
      }
      const revision = nextRevision(context.envelope.revision);
      const removed = context.envelope.profiles[index];
      const profiles = context.envelope.profiles.filter((profile) => profile.id !== id);
      let defaultId = context.envelope.defaultId;
      if (defaultId === id) {
        defaultId = profiles.length === 0 ? undefined : profiles[index]?.id ?? profiles[0].id;
      }
      return {
        envelope: makeEnvelope(revision, profiles, defaultId),
        result: undefined,
        cleanupSlots: removed.credentialSlot ? [removed.credentialSlot] : undefined
      };
    });
  }

  async setDefault(id: string): Promise<void> {
    await this.mutate(async (context) => {
      if (!context.envelope.profiles.some((profile) => profile.id === id)) {
        throw new ConnectionProfileNotFoundError();
      }
      const revision = nextRevision(context.envelope.revision);
      return {
        envelope: makeEnvelope(revision, context.envelope.profiles, id),
        result: undefined
      };
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
    this.watcher?.dispose();
    this.watcher = undefined;
    this.listeners.clear();
  }

  private async initializeFirstStore(): Promise<MigrationNotice | undefined> {
    const lease = await this.acquireLease();
    let stateWriteDispatched = false;
    let stateWriteSettled = false;
    let outcomeUnknown = false;
    try {
      const existing = await this.options.stateFile.readState();
      if (existing !== undefined) {
        this.acceptEnvelope(parseEnvelope(existing));
        await this.tryWriteMarker();
        return undefined;
      }
      if (await this.options.stateFile.markerExists()) {
        throw new ConnectionStoreUnavailableError('The initialized connection-store file is missing.');
      }

      const legacyUrl = this.options.legacy?.getGlobalServerUrl();
      const legacyToken = this.options.legacy ? await this.options.legacy.getAccessToken() : undefined;
      let notice: MigrationNotice | undefined;
      let envelope = makeEnvelope(0, [], undefined);
      let migratedProfile = false;

      if (!legacyUrl && legacyToken) {
        notice = {
          kind: 'incomplete',
          message: 'A legacy access code was found without an explicit global server URL. Add a connection manually.'
        };
      } else if (legacyUrl) {
        try {
          const serverUrl = normalizeServerUrl(legacyUrl);
          const accessToken = legacyToken === undefined ? undefined : normalizeRequiredToken(legacyToken);
          validateConnectionSecurity(serverUrl, accessToken);
          const timestamp = validatedTimestamp(this.now());
          const id = createUniqueUuid(this.randomUuid, new Set());
          const parsed = new URL(serverUrl);
          const name = normalizeConnectionName(parsed.hostname);
          let credentialSlot: string | undefined;
          if (accessToken !== undefined) {
            assertLeaseActive(lease);
            credentialSlot = await this.allocateFreshSlot(envelope);
          }
          const stored: StoredConnectionProfile = Object.freeze({
            id,
            name,
            serverUrl,
            createdAt: timestamp,
            updatedAt: timestamp,
            ...(credentialSlot ? { credentialSlot } : {})
          });
          const migratedEnvelope = makeEnvelope(0, [stored], id);
          if (accessToken !== undefined && credentialSlot) {
            assertLeaseActive(lease);
            await this.options.secrets.store(credentialKey(credentialSlot), accessToken);
            assertLeaseActive(lease);
          }
          envelope = migratedEnvelope;
          migratedProfile = true;
        } catch (error) {
          if (!(error instanceof ConnectionProfileValidationError)) {
            throw error;
          }
          notice = {
            kind: 'invalid',
            message: 'The legacy Dinotty connection is invalid or incomplete. Add a connection manually.'
          };
          envelope = makeEnvelope(0, [], undefined);
        }
      }

      assertLeaseActive(lease);
      stateWriteDispatched = true;
      try {
        await this.options.stateFile.writeState(serializeEnvelope(envelope));
      } catch {
        throw new ConnectionStoreWriteNotCommittedError();
      }
      stateWriteSettled = true;
      if (lease.compromised) {
        outcomeUnknown = true;
        throw new ConnectionStoreCommitOutcomeUnknownError();
      }
      this.acceptEnvelope(envelope);
      await this.tryWriteMarker();

      if (migratedProfile && this.options.legacy) {
        await this.tryLegacyCleanup(Boolean(legacyUrl), legacyToken !== undefined);
      }
      return notice;
    } catch (error) {
      if (lease.compromised) {
        if (stateWriteDispatched) {
          outcomeUnknown = true;
          throw new ConnectionStoreCommitOutcomeUnknownError();
        }
        throw new ConnectionStoreWriteNotCommittedError();
      }
      throw error;
    } finally {
      await lease.release();
      if (outcomeUnknown || (stateWriteDispatched && !stateWriteSettled)) {
        await this.refreshAfterUnknownOutcome();
      }
    }
  }

  private async mutate<T>(buildPlan: (context: MutationContext) => Promise<MutationPlan<T>>): Promise<T> {
    return this.enqueue(async () => {
      this.assertStoreActive();
      const lease = await this.acquireLease();
      let secretWriteDispatched = false;
      let stateWriteDispatched = false;
      let stateWriteSettled = false;
      let outcomeUnknown = false;
      try {
        let envelope: ConnectionStoreEnvelopeV1;
        try {
          envelope = await this.readEnvelopeFromDisk();
        } catch (error) {
          this.recordReadFailure(error);
          throw asUnavailableError(error);
        }
        this.acceptEnvelope(envelope);
        assertLeaseActive(lease);

        const context: MutationContext = {
          envelope,
          assertLeaseActive: () => assertLeaseActive(lease),
          storeFreshCredential: async (accessToken) => {
            assertLeaseActive(lease);
            const slot = await this.allocateFreshSlot(envelope);
            assertLeaseActive(lease);
            secretWriteDispatched = true;
            await this.options.secrets.store(credentialKey(slot), accessToken);
            assertLeaseActive(lease);
            return slot;
          }
        };
        const plan = await buildPlan(context);
        assertLeaseActive(lease);
        stateWriteDispatched = true;
        try {
          await this.options.stateFile.writeState(serializeEnvelope(plan.envelope));
        } catch {
          throw new ConnectionStoreWriteNotCommittedError();
        }
        stateWriteSettled = true;
        if (lease.compromised) {
          outcomeUnknown = true;
          throw new ConnectionStoreCommitOutcomeUnknownError();
        }

        this.acceptEnvelope(plan.envelope);
        for (const slot of plan.cleanupSlots ?? []) {
          if (lease.compromised) {
            this.options.logger?.('Credential cleanup skipped after the writer lease was compromised.');
            break;
          }
          await this.tryDeleteCredential(slot);
        }
        return plan.result;
      } catch (error) {
        if (lease.compromised) {
          if (stateWriteDispatched) {
            outcomeUnknown = true;
            throw new ConnectionStoreCommitOutcomeUnknownError();
          }
          if (secretWriteDispatched) {
            this.options.logger?.('Writer lease lost after a credential write; an unreachable credential may remain.');
          }
          throw new ConnectionStoreWriteNotCommittedError();
        }
        throw error;
      } finally {
        await lease.release();
        if (outcomeUnknown || (stateWriteDispatched && !stateWriteSettled)) {
          await this.refreshAfterUnknownOutcome();
        }
      }
    });
  }

  private async allocateFreshSlot(envelope: ConnectionStoreEnvelopeV1): Promise<string> {
    const referenced = new Set(envelope.profiles.flatMap((profile) => profile.credentialSlot ? [profile.credentialSlot] : []));
    for (let attempt = 0; attempt < MAX_UUID_ATTEMPTS; attempt += 1) {
      const candidate = this.randomUuid().toLowerCase();
      if (!isCanonicalUuid(candidate) || referenced.has(candidate)) {
        continue;
      }
      const existing = await this.options.secrets.get(credentialKey(candidate));
      if (existing === undefined) {
        return candidate;
      }
    }
    throw new Error('Could not allocate a fresh credential slot.');
  }

  private async readForUse(): Promise<ConnectionStoreEnvelopeV1> {
    try {
      const envelope = await this.readEnvelopeFromDisk();
      this.acceptEnvelope(envelope);
      return envelope;
    } catch (error) {
      this.recordReadFailure(error);
      if (this.envelope) {
        return this.envelope;
      }
      throw asUnavailableError(error);
    }
  }

  private async readEnvelopeFromDisk(): Promise<ConnectionStoreEnvelopeV1> {
    const serialized = await this.options.stateFile.readState();
    if (serialized === undefined) {
      throw new ConnectionStoreUnavailableError('The connection-store file is missing.');
    }
    return parseEnvelope(serialized);
  }

  private acceptEnvelope(envelope: ConnectionStoreEnvelopeV1): void {
    const canonical = canonicalizeEnvelope(envelope);
    const profilesChanged = canonical !== this.canonicalEnvelope;
    const statusChanged = !this.status.available || !this.status.writable || this.status.lastError !== undefined;
    this.envelope = envelope;
    this.canonicalEnvelope = canonical;
    this.status = Object.freeze({ available: true, writable: true });
    if (profilesChanged || statusChanged) {
      this.fireChange(profilesChanged);
    }
  }

  private recordReadFailure(error: unknown): void {
    const next = Object.freeze({
      available: this.envelope !== undefined,
      writable: false,
      lastError: safeStoreError(error)
    });
    const changed = next.available !== this.status.available || next.writable !== this.status.writable ||
      next.lastError !== this.status.lastError;
    this.status = next;
    if (changed) {
      this.fireChange(false);
    }
  }

  private fireChange(profilesChanged: boolean): void {
    const event = Object.freeze({ profilesChanged, status: this.status });
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A UI listener must not break store state transitions.
      }
    }
  }

  private handleWatchEvent(): void {
    if (this.disposed) {
      return;
    }
    this.watcherDirty = true;
    if (this.watcherRefreshRunning || this.watchTimer) {
      return;
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      void this.runWatcherRefreshLoop();
    }, this.watchDebounceMs);
  }

  private async runWatcherRefreshLoop(): Promise<void> {
    if (this.watcherRefreshRunning || this.disposed) {
      return;
    }
    this.watcherRefreshRunning = true;
    try {
      do {
        this.watcherDirty = false;
        try {
          await this.refresh();
        } catch (error) {
          if (!this.disposed) {
            this.options.logger?.(`Connection-store watcher refresh failed: ${safeStoreError(error)}`);
          }
        }
      } while (this.watcherDirty && !this.disposed);
    } finally {
      this.watcherRefreshRunning = false;
    }
  }

  private async acquireLease(): Promise<WriterLease> {
    try {
      return await this.options.writerLease.acquire();
    } catch (error) {
      if (error instanceof WriterLeaseBusyError) {
        throw new ConnectionStoreBusyError();
      }
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async tryDeleteCredential(slot: string): Promise<void> {
    try {
      await this.options.secrets.delete(credentialKey(slot));
    } catch {
      this.options.logger?.('A superseded credential could not be removed from SecretStorage.');
    }
  }

  private async tryWriteMarker(): Promise<void> {
    try {
      await this.options.stateFile.writeMarker();
    } catch {
      this.options.logger?.('The connection-store initialized marker could not be written.');
    }
  }

  private async tryEnsureMarker(): Promise<void> {
    try {
      if (!(await this.options.stateFile.markerExists())) {
        await this.tryWriteMarker();
      }
    } catch {
      this.options.logger?.('The connection-store initialized marker could not be checked.');
    }
  }

  private async tryLegacyCleanup(clearUrl: boolean, clearToken: boolean): Promise<void> {
    if (!this.options.legacy) {
      return;
    }
    if (clearUrl) {
      try {
        await this.options.legacy.clearGlobalServerUrl();
      } catch {
        this.options.logger?.('The legacy global server URL could not be cleared.');
      }
    }
    if (clearToken) {
      try {
        await this.options.legacy.clearAccessToken();
      } catch {
        this.options.logger?.('The legacy access code could not be cleared.');
      }
    }
  }

  private async refreshAfterUnknownOutcome(): Promise<void> {
    try {
      await this.refreshWithoutQueue();
    } catch (error) {
      this.options.logger?.(`Final refresh after an uncertain write failed: ${safeStoreError(error)}`);
    }
  }

  private assertStoreActive(): void {
    if (this.disposed) {
      throw new ConnectionStoreDisposedError();
    }
  }
}

function normalizeAddInput(input: AddConnectionInput): {
  readonly name: string;
  readonly serverUrl: string;
  readonly accessToken?: string;
} {
  const name = normalizeConnectionName(input.name);
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const accessToken = input.accessToken === undefined ? undefined : normalizeAccessToken(input.accessToken, true);
  validateConnectionSecurity(serverUrl, accessToken);
  return { name, serverUrl, ...(accessToken ? { accessToken } : {}) };
}

function normalizeCredentialChange(change: CredentialChange): CredentialChange {
  if (change.kind !== 'replace') {
    return change;
  }
  return Object.freeze({ kind: 'replace', accessToken: normalizeRequiredToken(change.accessToken) });
}

function normalizeRequiredToken(value: string): string {
  const token = normalizeAccessToken(value, false);
  if (token === undefined) {
    throw new Error('A replacement access code cannot be empty. Choose Clear instead.');
  }
  return token;
}

function assertUniqueName(envelope: ConnectionStoreEnvelopeV1, name: string, exceptId?: string): void {
  const key = connectionNameKey(name);
  if (envelope.profiles.some((profile) => profile.id !== exceptId && connectionNameKey(profile.name) === key)) {
    throw new DuplicateConnectionNameError();
  }
}

function nextRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw new ConnectionStoreWriteNotCommittedError('The connection store has reached its revision limit.');
  }
  return revision + 1;
}

function validatedTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConnectionStoreWriteNotCommittedError('The system clock cannot produce a valid connection timestamp.');
  }
  return value;
}

function assertLeaseActive(lease: WriterLease): void {
  if (lease.compromised) {
    throw new ConnectionStoreWriteNotCommittedError();
  }
}

function makeEnvelope(
  revision: number,
  profiles: readonly StoredConnectionProfile[],
  defaultId: string | undefined
): ConnectionStoreEnvelopeV1 {
  return validateConnectionStoreEnvelope({
    version: 1,
    revision,
    profiles,
    ...(defaultId ? { defaultId } : {})
  });
}

function parseEnvelope(serialized: string): ConnectionStoreEnvelopeV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new ConnectionStoreUnavailableError('The connection-store file contains invalid JSON.');
  }
  try {
    return validateConnectionStoreEnvelope(value);
  } catch {
    throw new ConnectionStoreUnavailableError('The connection-store file failed schema validation.');
  }
}

function serializeEnvelope(envelope: ConnectionStoreEnvelopeV1): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function canonicalizeEnvelope(envelope: ConnectionStoreEnvelopeV1): string {
  return JSON.stringify(envelope);
}

function publicProfiles(profiles: readonly StoredConnectionProfile[]): readonly DinottyConnectionProfile[] {
  return Object.freeze(profiles.map(publicProfile));
}

function publicProfile(profile: StoredConnectionProfile): DinottyConnectionProfile {
  return Object.freeze({
    id: profile.id,
    name: profile.name,
    serverUrl: profile.serverUrl,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  });
}

function credentialKey(slot: string): string {
  if (!isCanonicalUuid(slot)) {
    throw new ConnectionStoreUnavailableError('The connection store contains an invalid credential slot.');
  }
  return `${CREDENTIAL_KEY_PREFIX}${slot}`;
}

function createUniqueUuid(randomUuid: () => string, existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < MAX_UUID_ATTEMPTS; attempt += 1) {
    const candidate = randomUuid().toLowerCase();
    if (isCanonicalUuid(candidate) && !existing.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not allocate a unique connection id.');
}

function defaultRandomUuid(): string {
  return randomUUID();
}

function asUnavailableError(error: unknown): ConnectionStoreUnavailableError {
  return error instanceof ConnectionStoreUnavailableError
    ? error
    : new ConnectionStoreUnavailableError(safeStoreError(error));
}

function safeStoreError(error: unknown): string {
  if (error instanceof ConnectionStoreUnavailableError) {
    return error.message;
  }
  return 'The Dinotty connection store could not be read.';
}

export function connectionCredentialKey(slot: string): string {
  return credentialKey(slot);
}
