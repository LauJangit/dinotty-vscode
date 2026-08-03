import * as vscode from 'vscode';
import { DinottyConnectionProfile } from './connectionProfile';
import { ConnectionProfileStore } from './connectionProfileStore';

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<DinottyConnectionProfile>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<DinottyConnectionProfile | undefined>();
  private readonly storeListener: { dispose(): void };

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly store: ConnectionProfileStore,
    private readonly logger?: (message: string) => void
  ) {
    this.storeListener = store.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  async getChildren(element?: DinottyConnectionProfile): Promise<DinottyConnectionProfile[]> {
    if (element) {
      return [];
    }
    try {
      return [...await this.store.list()];
    } catch {
      this.logger?.('Connections view could not read the connection store.');
      return [];
    }
  }

  getTreeItem(profile: DinottyConnectionProfile): vscode.TreeItem {
    const isDefault = profile.id === this.store.cachedDefaultId;
    const stale = !this.store.currentStatus.writable;
    const item = new vscode.TreeItem(profile.name, vscode.TreeItemCollapsibleState.None);
    item.id = profile.id;
    item.description = [describeServer(profile.serverUrl), isDefault ? 'Default' : undefined, stale ? 'possibly stale' : undefined]
      .filter((value): value is string => Boolean(value))
      .join(' - ');
    item.tooltip = [
      profile.name,
      profile.serverUrl,
      isDefault ? 'Default connection' : undefined,
      stale ? 'The connection-store file is temporarily unavailable; this is the last validated snapshot.' : undefined,
      'Select to create a new Dinotty terminal.'
    ].filter((value): value is string => Boolean(value)).join('\n');
    item.iconPath = new vscode.ThemeIcon('server');
    item.contextValue = isDefault ? 'dinotty.connection.default' : 'dinotty.connection';
    item.command = {
      command: 'dinotty.connectProfile',
      title: 'Connect',
      arguments: [profile.id]
    };
    return item;
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    this.storeListener.dispose();
    this.changeEmitter.dispose();
  }
}

function describeServer(serverUrl: string): string {
  const url = new URL(serverUrl);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}
