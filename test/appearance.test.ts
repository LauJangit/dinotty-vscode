import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHexColor, resolveLocalTerminalAppearance } from '../src/appearance';
import { resolveTerminalAppearanceMode } from '../src/appearanceConfig';

const settings = {
  theme: {
    preset: 'dark',
    custom: { foreground: '#abc', background: '#123456', cursor: '#fed', ansi: ['#010203'] }
  }
};

test('native mode emits no OSC sequences', () => {
  assert.deepEqual(resolveLocalTerminalAppearance('native', settings), { mode: 'native', osc: '' });
});

test('base and exact modes emit their documented color sets', () => {
  const base = resolveLocalTerminalAppearance('base', settings).osc;
  const exact = resolveLocalTerminalAppearance('exact', settings).osc;
  assert.match(base, /\x1b\]10;#AABBCC\x07/);
  assert.match(base, /\x1b\]11;#123456\x07/);
  assert.match(base, /\x1b\]12;#FFEEDD\x07/);
  assert.doesNotMatch(base, /\x1b\]4;/);
  assert.match(exact, /\x1b\]4;0;#010203/);
});

test('normalizes only supported hex colors', () => {
  assert.equal(normalizeHexColor(' #a1B2c3 '), '#A1B2C3');
  assert.equal(normalizeHexColor('#abc'), '#AABBCC');
  assert.equal(normalizeHexColor('rgb(0,0,0)'), undefined);
});

test('new appearance mode wins and only explicit legacy true maps to exact', () => {
  assert.equal(resolveTerminalAppearanceMode({ workspaceValue: 'base' }, { globalValue: true }), 'base');
  assert.equal(resolveTerminalAppearanceMode(undefined, { globalValue: true }), 'exact');
  assert.equal(resolveTerminalAppearanceMode(undefined, { globalValue: false }), 'native');
  assert.equal(resolveTerminalAppearanceMode(undefined, undefined), 'native');
});
