import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalEffect, TerminalStateMachine } from '../src/terminalState';

function connect(machine: TerminalStateMachine): void {
  machine.dispatch({ type: 'local_capacity', geometry: { cols: 100, rows: 30 } });
  machine.dispatch({ type: 'transport_connecting' });
  machine.dispatch({ type: 'transport_open' });
}

function initialReplay(machine: TerminalStateMachine): TerminalEffect[] {
  machine.dispatch({ type: 'reconnected', cols: 80, rows: 24 });
  machine.dispatch({ type: 'replay_begin', cols: 100, rows: 30 });
  machine.dispatch({ type: 'output', data: 'frame' });
  return machine.dispatch({ type: 'replay_end' });
}

test('initial handshake requests one snapshot and atomically commits replay', () => {
  const machine = new TerminalStateMachine();
  connect(machine);
  const handshake = machine.dispatch({ type: 'reconnected', cols: 80, rows: 24 });
  assert.deepEqual(handshake[0], { type: 'send', message: { type: 'snapshot_request', cols: 100, rows: 30 } });

  machine.dispatch({ type: 'replay_begin', cols: 100, rows: 30 });
  assert.equal(machine.dispatch({ type: 'output', data: 'one' }).some((effect) => effect.type === 'write'), false);
  machine.dispatch({ type: 'output', data: 'two' });
  const effects = machine.dispatch({ type: 'replay_end' });
  const overrideIndex = effects.findIndex((effect) => effect.type === 'override_dimensions');
  const commitIndex = effects.findIndex((effect) => effect.type === 'commit_replay');
  assert.ok(overrideIndex >= 0 && commitIndex > overrideIndex);
  assert.deepEqual(effects[commitIndex], { type: 'commit_replay', data: 'onetwo' });
  assert.equal(machine.snapshot().renderState, 'ready_local');
});

test('nested sync and replay flush only at the outer boundary', () => {
  const machine = new TerminalStateMachine();
  connect(machine);
  machine.dispatch({ type: 'reconnected', cols: 80, rows: 24 });
  machine.dispatch({ type: 'sync_begin' });
  machine.dispatch({ type: 'output', data: 'a' });
  machine.dispatch({ type: 'replay_begin', cols: 100, rows: 30 });
  machine.dispatch({ type: 'output', data: 'b' });
  assert.equal(machine.dispatch({ type: 'replay_end' }).some((effect) => effect.type === 'commit_replay'), false);
  const effects = machine.dispatch({ type: 'sync_end' });
  assert.deepEqual(effects.find((effect) => effect.type === 'commit_replay'), { type: 'commit_replay', data: 'ab' });
});

test('remote geometry is overridden when fitting and suspended when capacity shrinks', () => {
  const machine = new TerminalStateMachine();
  connect(machine);
  initialReplay(machine);
  const remote = machine.dispatch({ type: 'remote_resize', cols: 90, rows: 25 });
  assert.deepEqual(remote[0], { type: 'override_dimensions', dimensions: { cols: 90, rows: 25 } });
  machine.dispatch({ type: 'local_capacity', geometry: { cols: 80, rows: 20 } });
  assert.equal(machine.snapshot().renderState, 'suspended_geometry');
  assert.equal(machine.dispatch({ type: 'output', data: 'lost' }).some((effect) => effect.type === 'write'), false);
  const resumed = machine.dispatch({ type: 'local_capacity', geometry: { cols: 100, rows: 30 } });
  assert.deepEqual(resumed[0], { type: 'send', message: { type: 'snapshot_request', cols: 90, rows: 25 } });
});

test('active focused terminal reclaims local geometry when a larger remote resize would hide startup output', () => {
  const machine = new TerminalStateMachine();
  connect(machine);
  initialReplay(machine);
  machine.dispatch({ type: 'active_changed', active: true });
  machine.dispatch({ type: 'window_focus_changed', focused: true });

  const recovery = machine.dispatch({ type: 'remote_resize', cols: 140, rows: 50 });
  assert.deepEqual(recovery[0], {
    type: 'send',
    message: { type: 'snapshot_request', cols: 100, rows: 30 }
  });
  assert.equal(recovery.some((effect) => effect.type === 'override_dimensions'), false);
  assert.deepEqual(machine.snapshot().pendingSnapshot, {
    geometry: { cols: 100, rows: 30 },
    reason: 'size_mismatch'
  });
  assert.equal(machine.snapshot().renderState, 'awaiting_replay');

  const premature = machine.dispatch({ type: 'output', data: 'not-safe-at-remote-size' });
  assert.equal(premature.some((effect) => effect.type === 'write'), false);

  machine.dispatch({ type: 'replay_begin', cols: 100, rows: 30 });
  machine.dispatch({ type: 'output', data: 'PS C:\\Users\\example> ' });
  const committed = machine.dispatch({ type: 'replay_end' });
  assert.deepEqual(committed.find((effect) => effect.type === 'commit_replay'), {
    type: 'commit_replay',
    data: 'PS C:\\Users\\example> '
  });
  const snapshot = machine.snapshot();
  assert.equal(snapshot.renderState, 'ready_local');
  assert.equal(snapshot.outputWasDropped, false);
  assert.equal(snapshot.remoteGeometry, null);
});

test('activating a suspended terminal reclaims local geometry once the window is focused', () => {
  const machine = new TerminalStateMachine();
  connect(machine);
  initialReplay(machine);
  machine.dispatch({ type: 'window_focus_changed', focused: true });

  machine.dispatch({ type: 'remote_resize', cols: 140, rows: 50 });
  assert.equal(machine.snapshot().renderState, 'suspended_geometry');

  const recovery = machine.dispatch({ type: 'active_changed', active: true });
  assert.deepEqual(recovery[0], {
    type: 'send',
    message: { type: 'snapshot_request', cols: 100, rows: 30 }
  });
  assert.equal(machine.snapshot().renderState, 'awaiting_replay');
});

test('active local input sends snapshot before input when following remote geometry', () => {
  const machine = new TerminalStateMachine();
  connect(machine);
  initialReplay(machine);
  machine.dispatch({ type: 'remote_resize', cols: 90, rows: 25 });
  machine.dispatch({ type: 'active_changed', active: true });
  machine.dispatch({ type: 'window_focus_changed', focused: true });
  const effects = machine.dispatch({ type: 'user_input', data: 'x' });
  const sends = effects.filter((effect) => effect.type === 'send');
  assert.deepEqual(sends, [
    { type: 'send', message: { type: 'snapshot_request', cols: 100, rows: 30 } },
    { type: 'send', message: { type: 'input', data: 'x' } }
  ]);
});

test('stray transaction end never makes depth negative', () => {
  const machine = new TerminalStateMachine();
  machine.dispatch({ type: 'replay_end' });
  machine.dispatch({ type: 'sync_end' });
  assert.equal(machine.snapshot().transactionDepth, 0);
});

test('remote resize queued during initial replay keeps its remote snapshot reason', () => {
  const machine = new TerminalStateMachine();
  connect(machine);
  machine.dispatch({ type: 'reconnected', cols: 80, rows: 24 });
  machine.dispatch({ type: 'remote_resize', cols: 90, rows: 25 });
  machine.dispatch({ type: 'replay_begin', cols: 100, rows: 30 });
  const effects = machine.dispatch({ type: 'replay_end' });
  assert.deepEqual(effects.find((effect) => effect.type === 'send'), {
    type: 'send',
    message: { type: 'snapshot_request', cols: 90, rows: 25 }
  });
  machine.dispatch({ type: 'replay_begin', cols: 90, rows: 25 });
  machine.dispatch({ type: 'replay_end' });
  assert.equal(machine.snapshot().renderState, 'ready_remote');
});

test('capacity shrink during a remote replay abandons the oversized frame and reclaims local geometry', () => {
  const machine = new TerminalStateMachine();
  connect(machine);
  initialReplay(machine);
  machine.dispatch({ type: 'remote_resize', cols: 90, rows: 25 });
  machine.dispatch({ type: 'local_capacity', geometry: { cols: 80, rows: 20 } });
  machine.dispatch({ type: 'local_capacity', geometry: { cols: 100, rows: 30 } });
  machine.dispatch({ type: 'active_changed', active: true });
  machine.dispatch({ type: 'window_focus_changed', focused: true });
  machine.dispatch({ type: 'replay_begin', cols: 90, rows: 25 });
  machine.dispatch({ type: 'local_capacity', geometry: { cols: 80, rows: 20 } });
  const effects = machine.dispatch({ type: 'replay_end' });
  assert.equal(effects.some((effect) => effect.type === 'commit_replay'), false);
  assert.deepEqual(effects.find((effect) => effect.type === 'send'), {
    type: 'send',
    message: { type: 'snapshot_request', cols: 80, rows: 20 }
  });
  assert.equal(machine.snapshot().renderState, 'awaiting_replay');
});

test('transaction timeout abandons the partial frame and starts recovery', () => {
  const machine = new TerminalStateMachine();
  connect(machine);
  initialReplay(machine);
  machine.dispatch({ type: 'sync_begin' });
  machine.dispatch({ type: 'output', data: 'partial' });
  const effects = machine.dispatch({ type: 'transaction_timeout' });
  assert.equal(machine.snapshot().transactionDepth, 0);
  assert.equal(effects.some((effect) => effect.type === 'write'), false);
  assert.equal(effects.some((effect) => effect.type === 'send' && effect.message.type === 'snapshot_request'), true);
});
