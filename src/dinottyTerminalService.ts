import * as vscode from 'vscode';
import type { TerminalAppearanceMode } from './appearance';
import { ConnectionProfileStore } from './connectionProfileStore';
import { DinottyClient } from './dinottyClient';
import { DinottyPty } from './dinottyPty';
import { getWorkspaceCwd } from './cwd';
import { CancellationTokenLike, PreparedTerminalOptions } from './terminalProfileController';

interface TerminalSession {
  readonly pty: DinottyPty;
  readonly statusListener: vscode.Disposable;
}

export class DinottyTerminalService implements vscode.Disposable {
  private readonly sessions = new Map<vscode.Terminal, TerminalSession>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    private readonly store: ConnectionProfileStore,
    private readonly statusBar: vscode.StatusBarItem,
    private readonly getAppearanceMode: () => TerminalAppearanceMode,
    private readonly logger: (message: string) => void
  ) {
    this.subscriptions.push(
      vscode.window.onDidOpenTerminal((terminal) => this.handleOpenTerminal(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => this.handleCloseTerminal(terminal)),
      vscode.window.onDidChangeActiveTerminal((terminal) => this.updateActiveTerminal(terminal)),
      vscode.window.onDidChangeWindowState((state) => {
        for (const session of this.sessions.values()) {
          session.pty.setWindowFocused(state.focused);
        }
      })
    );
  }

  async createTerminalOptions(
    profileId: string,
    token?: CancellationTokenLike
  ): Promise<PreparedTerminalOptions<vscode.ExtensionTerminalOptions>> {
    this.assertActive();
    const connection = await this.store.resolve(profileId);
    this.assertActive();
    if (token?.isCancellationRequested) {
      return cancelledPreparedOptions();
    }

    const client = new DinottyClient(connection);
    const pty = new DinottyPty({
      client,
      profileId: connection.id,
      profileName: connection.name,
      cwd: getWorkspaceCwd(),
      appearanceMode: this.getAppearanceMode(),
      logger: (message) => this.logger(redactSecret(`[${connection.name}] ${message}`, connection.accessToken)),
      onAuthenticationFailure: (profile) => this.showAuthenticationFailure(profile)
    });
    pty.setWindowFocused(vscode.window.state.focused);
    const options: vscode.ExtensionTerminalOptions = {
      name: `Dinotty: ${connection.name}`,
      pty
    };
    let released = false;
    return {
      options,
      dispose: () => {
        if (released) {
          return;
        }
        released = true;
        pty.dispose();
      }
    };
  }

  async open(profileId: string): Promise<vscode.Terminal> {
    const prepared = await this.createTerminalOptions(profileId);
    if (this.disposed) {
      prepared.dispose();
      throw new TerminalServiceDisposedError();
    }
    try {
      const terminal = vscode.window.createTerminal(prepared.options);
      terminal.show();
      return terminal;
    } catch (error) {
      prepared.dispose();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of this.subscriptions.splice(0)) {
      disposable.dispose();
    }
    for (const [terminal, session] of [...this.sessions]) {
      this.sessions.delete(terminal);
      session.statusListener.dispose();
      session.pty.dispose();
    }
    this.statusBar.hide();
  }

  private handleOpenTerminal(terminal: vscode.Terminal): void {
    const creationOptions = terminal.creationOptions;
    if (!('pty' in creationOptions) || !(creationOptions.pty instanceof DinottyPty)) {
      return;
    }
    const pty = creationOptions.pty;
    const existing = this.sessions.get(terminal);
    if (existing) {
      return;
    }
    const statusListener = pty.onDidChangeStatus(() => {
      if (vscode.window.activeTerminal === terminal) {
        this.updateStatusBar(pty);
      }
    });
    this.sessions.set(terminal, { pty, statusListener });
    this.updateActiveTerminal(vscode.window.activeTerminal);
  }

  private handleCloseTerminal(terminal: vscode.Terminal): void {
    const session = this.sessions.get(terminal);
    if (!session) {
      return;
    }
    this.sessions.delete(terminal);
    session.statusListener.dispose();
    session.pty.dispose();
    this.updateActiveTerminal(vscode.window.activeTerminal);
  }

  private updateActiveTerminal(active: vscode.Terminal | undefined): void {
    let activePty: DinottyPty | undefined;
    for (const [terminal, session] of this.sessions) {
      const isActive = terminal === active;
      session.pty.setActive(isActive);
      if (isActive) {
        activePty = session.pty;
      }
    }
    this.updateStatusBar(activePty);
  }

  private updateStatusBar(pty: DinottyPty | undefined): void {
    const status = pty?.getStatus();
    if (!status || !pty) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = `$(terminal) Dinotty: ${pty.getProfileName()}: ${status}`;
    this.statusBar.tooltip = status;
    this.statusBar.show();
  }

  private showAuthenticationFailure(profile: { readonly id: string; readonly name: string }): void {
    if (this.disposed) {
      return;
    }
    void vscode.window
      .showErrorMessage(`Authentication failed for Dinotty connection "${profile.name}".`, 'Edit Connection')
      .then((choice) => {
        if (!this.disposed && choice === 'Edit Connection') {
          void vscode.commands.executeCommand('dinotty.editConnection', profile.id);
        }
      });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new TerminalServiceDisposedError();
    }
  }
}

export class TerminalServiceDisposedError extends Error {
  constructor() {
    super('The Dinotty terminal service is no longer active.');
    this.name = 'TerminalServiceDisposedError';
  }
}

function cancelledPreparedOptions(): PreparedTerminalOptions<vscode.ExtensionTerminalOptions> {
  const pty: vscode.Pseudoterminal = {
    onDidWrite: () => ({ dispose() {} }),
    open() {},
    close() {}
  };
  return {
    options: { name: 'Dinotty', pty },
    dispose() {}
  };
}

function redactSecret(message: string, secret: string | undefined): string {
  return secret ? message.split(secret).join('[redacted]') : message;
}
