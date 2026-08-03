import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeConnectionStoreFile, WriterLeaseBusyError } from '../src/connectionStoreFile';

test('real file adapter atomically persists state and initialization marker', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'dinotty-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = new NodeConnectionStoreFile(directory);

  assert.equal(await file.readState(), undefined);
  assert.equal(await file.markerExists(), false);
  await file.writeState('{"version":1}\n');
  await file.writeMarker();
  assert.equal(await file.readState(), '{"version":1}\n');
  assert.equal(await file.stateExists(), true);
  assert.equal(await file.markerExists(), true);

  await file.writeState('{"version":2}\n');
  assert.equal(await file.readState(), '{"version":2}\n');
});

test('real writer target allows one lease and reports bounded contention as busy', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'dinotty-lease-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const firstAdapter = new NodeConnectionStoreFile(directory);
  const secondAdapter = new NodeConnectionStoreFile(directory);

  const first = await firstAdapter.acquire();
  await assert.rejects(() => secondAdapter.acquire(), WriterLeaseBusyError);
  await first.release();

  const second = await secondAdapter.acquire();
  assert.equal(second.compromised, false);
  await second.release();
});

test('state watcher observes an atomic replacement on a best-effort basis', async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'dinotty-watch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = new NodeConnectionStoreFile(directory);
  let resolveEvent: (() => void) | undefined;
  const observed = new Promise<void>((resolve) => {
    resolveEvent = resolve;
  });
  const watcher = await file.watch(() => resolveEvent?.());
  t.after(() => watcher.dispose());

  await file.writeState('{"version":1}\n');
  await Promise.race([
    observed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('watcher event timed out')), 2_000))
  ]);
});
