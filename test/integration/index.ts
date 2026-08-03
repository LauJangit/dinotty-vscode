import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

const PUBLIC_COMMANDS = [
  'dinotty.addConnection',
  'dinotty.connect',
  'dinotty.refreshConnections',
  'dinotty.showLog'
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('dinotty.dinotty-vscode');
  assert.ok(extension, 'The Dinotty extension is installed in the extension host.');
  assert.equal(
    vscode.workspace.getConfiguration('dinotty').inspect<string>('serverUrl')?.globalValue,
    'https://legacy.example.com/base/',
    'An existing unregistered legacy global value remains inspectable.'
  );
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of PUBLIC_COMMANDS) {
    assert.ok(commands.includes(command), `${command} is registered after activation.`);
  }

  const userDataDirectory = process.env.DINOTTY_TEST_USER_DATA;
  assert.ok(userDataDirectory);
  const statePath = path.join(
    userDataDirectory,
    'User',
    'globalStorage',
    'dinotty.dinotty-vscode',
    'connection-store-v1.json'
  );
  const serialized = readFileSync(statePath, 'utf8');
  const envelope = JSON.parse(serialized) as {
    profiles: Array<{ serverUrl: string; credentialSlot?: string }>;
  };
  assert.equal(envelope.profiles.length, 1);
  assert.equal(envelope.profiles[0].serverUrl, 'https://legacy.example.com/base');
  assert.equal(envelope.profiles[0].credentialSlot, undefined);
}
