import * as vscode from 'vscode';
import { ConnectionCommands } from './connectionCommands';
import { ConnectionProfileStore } from './connectionProfileStore';
import { NodeConnectionStoreFile } from './connectionStoreFile';
import { ConnectionsTreeProvider } from './connectionsTreeProvider';
import { getTerminalAppearanceMode } from './config';
import { DinottyTerminalService } from './dinottyTerminalService';
import { TerminalProfileController } from './terminalProfileController';
import { VsCodeLegacyConnectionSource, VsCodeSecretStorage } from './vscodeConnectionStoreAdapters';

const OUTPUT_CHANNEL_NAME = 'Dinotty';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  const ownedResources: vscode.Disposable[] = [output, statusBar];
  let resourcesDisposed = false;
  context.subscriptions.push({
    dispose: () => {
      if (resourcesDisposed) {
        return;
      }
      resourcesDisposed = true;
      for (let index = ownedResources.length - 1; index >= 0; index -= 1) {
        try {
          ownedResources[index].dispose();
        } catch {
          // Continue releasing independent extension resources.
        }
      }
      ownedResources.length = 0;
    }
  });
  const logger = (message: string): void => output.appendLine(message);
  const stateFile = new NodeConnectionStoreFile(context.globalStorageUri.fsPath);
  const store = new ConnectionProfileStore({
    stateFile,
    writerLease: stateFile,
    secrets: new VsCodeSecretStorage(context.secrets),
    legacy: new VsCodeLegacyConnectionSource(context),
    logger
  });

  let contextUpdate = Promise.resolve();
  const scheduleContextUpdate = (): Promise<void> => {
    contextUpdate = contextUpdate
      .then(() => updateStoreContexts(store))
      .catch(() => {
        if (!resourcesDisposed) {
          logger('Dinotty context keys could not be updated.');
        }
      });
    return contextUpdate;
  };

  await scheduleContextUpdate();
  const storeContextListener = store.onDidChange(() => {
    void scheduleContextUpdate();
  });
  ownedResources.push(store, storeContextListener);
  try {
    await store.startWatching();
  } catch {
    logger('The connection-store watcher could not start. Manual Refresh remains available.');
  }

  let migrationMessage: string | undefined;
  try {
    migrationMessage = (await store.initialize())?.message;
  } catch {
    logger('Connection-store initialization failed. Use Refresh after resolving the storage problem.');
  }

  const terminalService = new DinottyTerminalService(store, statusBar, getTerminalAppearanceMode, logger);
  ownedResources.push(terminalService);
  const commands = new ConnectionCommands(store, terminalService, output);
  ownedResources.push(commands);
  commands.register();
  const treeProvider = new ConnectionsTreeProvider(store, logger);
  ownedResources.push(treeProvider);
  const treeView = vscode.window.createTreeView('dinotty.connections', { treeDataProvider: treeProvider });
  ownedResources.push(treeView);
  const profileController = new TerminalProfileController({
    selectProfileId: (token) => commands.selectProfileId(token),
    createTerminalOptions: (profileId: string, token) =>
      terminalService.createTerminalOptions(profileId, token),
    createTerminalProfile: (options: vscode.ExtensionTerminalOptions) => new vscode.TerminalProfile(options)
  });
  const terminalProfileProvider = vscode.window.registerTerminalProfileProvider('dinotty.terminal', {
    async provideTerminalProfile(token): Promise<vscode.TerminalProfile | undefined> {
      try {
        return await profileController.provideTerminalProfile(token);
      } catch (error) {
        if (!token.isCancellationRequested) {
          commands.reportError(error);
        }
        return undefined;
      }
    }
  });

  ownedResources.push(terminalProfileProvider);

  await scheduleContextUpdate();
  if (migrationMessage) {
    void vscode.window.showWarningMessage(migrationMessage, 'Add Connection').then((choice) => {
      if (!resourcesDisposed && choice === 'Add Connection') {
        void vscode.commands.executeCommand('dinotty.addConnection');
      }
    });
  } else if (!store.currentStatus.available) {
    void vscode.window
      .showErrorMessage('Dinotty connections could not be loaded.', 'Refresh', 'Show Log')
      .then((choice) => {
        if (resourcesDisposed) {
          return;
        }
        if (choice === 'Refresh') {
          void vscode.commands.executeCommand('dinotty.refreshConnections');
        } else if (choice === 'Show Log') {
          output.show(true);
        }
      });
  }
}

async function updateStoreContexts(store: ConnectionProfileStore): Promise<void> {
  await Promise.all([
    vscode.commands.executeCommand('setContext', 'dinotty.connectionStoreAvailable', store.currentStatus.available),
    vscode.commands.executeCommand('setContext', 'dinotty.connectionStoreWritable', store.currentStatus.writable),
    vscode.commands.executeCommand('setContext', 'dinotty.connectionCount', store.cachedProfileCount)
  ]);
}

export function deactivate(): void {}
