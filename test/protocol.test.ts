import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeClientMessage, parseServerMessage } from '../src/protocol';

test('encodes every client message type', () => {
  assert.equal(encodeClientMessage({ type: 'input', data: 'hello' }), '{"type":"input","data":"hello"}');
  assert.equal(encodeClientMessage({ type: 'resize', cols: 80, rows: 24 }), '{"type":"resize","cols":80,"rows":24}');
  assert.equal(encodeClientMessage({ type: 'snapshot_request', cols: 100, rows: 30 }), '{"type":"snapshot_request","cols":100,"rows":30}');
});

test('parses replay, sync, output, and session exit messages', () => {
  assert.deepEqual(parseServerMessage('{"type":"replay_begin","cols":80,"rows":24}'), { type: 'replay_begin', cols: 80, rows: 24 });
  assert.deepEqual(parseServerMessage('{"type":"replay_end"}'), { type: 'replay_end' });
  assert.deepEqual(parseServerMessage('{"type":"sync_begin"}'), { type: 'sync_begin' });
  assert.deepEqual(parseServerMessage('{"type":"sync_end"}'), { type: 'sync_end' });
  assert.deepEqual(parseServerMessage('{"type":"output","data":"text"}'), { type: 'output', data: 'text' });
  assert.deepEqual(parseServerMessage('{"type":"output","data":"{\\"type\\":\\"session_exit\\",\\"pane_id\\":\\"p1\\"}"}'), { type: 'session_exit', pane_id: 'p1' });
});

test('rejects malformed and unsafe geometry without throwing', () => {
  for (const value of [-1, 0, 1, 1.5, 1001, null, '80']) {
    assert.equal(parseServerMessage(JSON.stringify({ type: 'resize', cols: value, rows: 24 })), undefined);
  }
  assert.equal(parseServerMessage('{not json'), undefined);
  assert.equal(parseServerMessage('{"type":"output","data":2}'), undefined);
  assert.equal(parseServerMessage('{"type":"future_message","data":"secret"}'), undefined);
});
