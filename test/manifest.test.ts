import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as {
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string; enablement?: string }>;
    configuration: { properties: Record<string, unknown> };
    menus: Record<string, Array<{ command: string; when?: string }>>;
    views: Record<string, Array<{ id: string }>>;
    viewsContainers: { activitybar: Array<{ id: string; icon: string }> };
    viewsWelcome: Array<{ view: string; when?: string }>;
  };
};

const commandIds = [
  'dinotty.addConnection',
  'dinotty.connect',
  'dinotty.connectProfile',
  'dinotty.editConnection',
  'dinotty.deleteConnection',
  'dinotty.testProfile',
  'dinotty.setDefaultConnection',
  'dinotty.refreshConnections',
  'dinotty.showLog'
];

test('contributes the Dinotty activity container, connections view, and recovery welcome states', () => {
  assert.deepEqual(manifest.contributes.viewsContainers.activitybar[0], {
    id: 'dinotty',
    title: 'Dinotty',
    icon: 'media/dinotty-activity.svg'
  });
  assert.equal(manifest.contributes.views.dinotty[0].id, 'dinotty.connections');
  assert.equal(manifest.contributes.viewsWelcome.length, 3);
  assert.ok(manifest.contributes.viewsWelcome.some((entry) => entry.when?.includes('!dinotty.connectionStoreAvailable')));
  assert.ok(manifest.activationEvents.includes('onView:dinotty.connections'));
});

test('declares every new command and removes the legacy connection surface', () => {
  assert.deepEqual(manifest.contributes.commands.map((command) => command.command), commandIds);
  assert.equal('dinotty.serverUrl' in manifest.contributes.configuration.properties, false);
  assert.equal(manifest.activationEvents.some((event) => event.includes('configureServer')), false);
  assert.equal(manifest.activationEvents.some((event) => event.includes('testConnection')), false);
});

test('guards item actions for ordinary and default nodes and hides targeted commands from the palette', () => {
  const itemMenus = manifest.contributes.menus['view/item/context'];
  for (const command of ['dinotty.connectProfile', 'dinotty.testProfile', 'dinotty.editConnection', 'dinotty.deleteConnection']) {
    const menu = itemMenus.find((entry) => entry.command === command);
    assert.match(menu?.when ?? '', /viewItem == dinotty\.connection/);
    assert.match(menu?.when ?? '', /viewItem == dinotty\.connection\.default/);
  }
  const setDefault = itemMenus.find((entry) => entry.command === 'dinotty.setDefaultConnection');
  assert.match(setDefault?.when ?? '', /viewItem == dinotty\.connection/);
  assert.doesNotMatch(setDefault?.when ?? '', /connection\.default/);

  const hidden = manifest.contributes.menus.commandPalette
    .filter((entry) => entry.when === 'false')
    .map((entry) => entry.command);
  assert.deepEqual(hidden, [
    'dinotty.connectProfile',
    'dinotty.editConnection',
    'dinotty.deleteConnection',
    'dinotty.testProfile',
    'dinotty.setDefaultConnection'
  ]);
});

test('uses available/writable context keys without disabling recovery commands', () => {
  const byId = new Map(manifest.contributes.commands.map((command) => [command.command, command]));
  assert.equal(byId.get('dinotty.connect')?.enablement, 'dinotty.connectionStoreAvailable');
  assert.equal(byId.get('dinotty.addConnection')?.enablement, 'dinotty.connectionStoreWritable');
  assert.equal(byId.get('dinotty.editConnection')?.enablement, 'dinotty.connectionStoreWritable');
  assert.equal(byId.get('dinotty.refreshConnections')?.enablement, undefined);
  assert.equal(byId.get('dinotty.showLog')?.enablement, undefined);
});
