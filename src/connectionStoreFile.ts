import { promises as fs, watch as watchDirectory, type FSWatcher } from 'fs';
import * as path from 'path';
import lockfile = require('proper-lockfile');
import writeFileAtomic = require('write-file-atomic');

const STATE_FILE_NAME = 'connection-store-v1.json';
const INITIALIZED_MARKER_NAME = 'connection-store-v1.initialized';
const WRITER_TARGET_NAME = 'connection-store-v1.writer-target';
const READ_RETRY_DELAYS_MS = [0, 20, 50, 100];

export interface DisposableLike {
  dispose(): void;
}

export interface ConnectionStateFileLike {
  readState(): Promise<string | undefined>;
  writeState(serializedEnvelope: string): Promise<void>;
  stateExists(): Promise<boolean>;
  markerExists(): Promise<boolean>;
  writeMarker(): Promise<void>;
  watch(listener: () => void): Promise<DisposableLike>;
}

export interface WriterLease {
  readonly compromised: boolean;
  onDidCompromise(listener: (error: Error) => void): DisposableLike;
  release(): Promise<void>;
}

export interface WriterLeaseLike {
  acquire(): Promise<WriterLease>;
}

export class WriterLeaseBusyError extends Error {
  constructor(message = 'The connection store is busy in another VS Code window.') {
    super(message);
    this.name = 'WriterLeaseBusyError';
  }
}

export class NodeConnectionStoreFile implements ConnectionStateFileLike, WriterLeaseLike {
  private readonly statePath: string;
  private readonly markerPath: string;
  private readonly writerTargetPath: string;

  constructor(private readonly storageDirectory: string) {
    this.statePath = path.join(storageDirectory, STATE_FILE_NAME);
    this.markerPath = path.join(storageDirectory, INITIALIZED_MARKER_NAME);
    this.writerTargetPath = path.join(storageDirectory, WRITER_TARGET_NAME);
  }

  async readState(): Promise<string | undefined> {
    let lastError: unknown;
    for (const delay of READ_RETRY_DELAYS_MS) {
      if (delay > 0) {
        await wait(delay);
      }
      try {
        return await fs.readFile(this.statePath, 'utf8');
      } catch (error) {
        if (isMissingFileError(error)) {
          lastError = error;
          continue;
        }
        if (isTransientReadError(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    if (isMissingFileError(lastError)) {
      return undefined;
    }
    throw lastError;
  }

  async writeState(serializedEnvelope: string): Promise<void> {
    await this.ensureStorageDirectory();
    await writeFileAtomic(this.statePath, serializedEnvelope, {
      encoding: 'utf8',
      fsync: true
    });
  }

  async stateExists(): Promise<boolean> {
    return pathExists(this.statePath);
  }

  async markerExists(): Promise<boolean> {
    return pathExists(this.markerPath);
  }

  async writeMarker(): Promise<void> {
    await this.ensureStorageDirectory();
    await writeFileAtomic(this.markerPath, 'initialized\n', {
      encoding: 'utf8',
      fsync: true
    });
  }

  async watch(listener: () => void): Promise<DisposableLike> {
    await this.ensureStorageDirectory();
    let watcher: FSWatcher | undefined;
    try {
      watcher = watchDirectory(this.storageDirectory, { persistent: false }, (_event, fileName) => {
        if (fileName === null || fileName.toString() === STATE_FILE_NAME) {
          listener();
        }
      });
      watcher.on('error', listener);
    } catch {
      // Manual refresh remains available on hosts where the platform watcher cannot start.
    }
    return { dispose: () => watcher?.close() };
  }

  async acquire(): Promise<WriterLease> {
    await this.ensureStorageDirectory();
    const target = await fs.open(this.writerTargetPath, 'a');
    await target.close();

    let compromised = false;
    const listeners = new Set<(error: Error) => void>();
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      releaseLock = await lockfile.lock(this.writerTargetPath, {
        realpath: false,
        stale: 10_000,
        update: 2_000,
        retries: {
          retries: 5,
          factor: 1.5,
          minTimeout: 75,
          maxTimeout: 250,
          randomize: true
        },
        onCompromised: (error) => {
          compromised = true;
          const normalized = error instanceof Error ? error : new Error('The writer lease was compromised.');
          for (const listener of [...listeners]) {
            listener(normalized);
          }
        }
      });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ELOCKED') {
        throw new WriterLeaseBusyError();
      }
      throw error;
    }

    let released = false;
    return {
      get compromised(): boolean {
        return compromised;
      },
      onDidCompromise(listener: (error: Error) => void): DisposableLike {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      async release(): Promise<void> {
        if (released) {
          return;
        }
        released = true;
        listeners.clear();
        try {
          await releaseLock?.();
        } catch {
          // A compromised lease may already have been removed by the lock adapter.
        }
      }
    };
  }

  private async ensureStorageDirectory(): Promise<void> {
    await fs.mkdir(this.storageDirectory, { recursive: true });
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isTransientReadError(error: unknown): boolean {
  return isNodeError(error) && ['EACCES', 'EBUSY', 'EPERM'].includes(error.code ?? '');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

export const CONNECTION_STATE_FILE_NAME = STATE_FILE_NAME;
