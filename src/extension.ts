import * as vscode from 'vscode';
import { ConfigStore } from './config';
import { DinottyClient } from './dinottyClient';
import { DinottyPty } from './dinottyPty';
import { getWorkspaceCwd } from './cwd';

const OUTPUT_CHANNEL_NAME = 'Dinotty';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  const config = new ConfigStore(context);
  const client = new DinottyClient(config);
  const ptys = new Set<DinottyPty>();
  const terminals = new Map<vscode.Terminal, DinottyPty>();

  const logger = (message: string): void => outputChannel.appendLine(message);
  const updateActiveTerminal = (active: vscode.Terminal | undefined): void => {
    for (const pty of ptys) {
      pty.setActive(false);
    }
    const activePty = active ? terminals.get(active) : undefined;
    activePty?.setActive(true);
    updateStatusBar(statusBar, activePty);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('dinotty.configureServer', () => config.configureServer()),
    vscode.commands.registerCommand('dinotty.testConnection', () => client.testConnection()),
    vscode.window.registerTerminalProfileProvider('dinotty.terminal', {
      provideTerminalProfile(): vscode.TerminalProfile {
        const pty = new DinottyPty({
          client,
          cwd: getWorkspaceCwd(),
          appearanceMode: config.getTerminalAppearanceMode(),
          logger
        });
        pty.setWindowFocused(vscode.window.state.focused);
        ptys.add(pty);
        context.subscriptions.push(pty.onDidChangeStatus(() => {
          if (vscode.window.activeTerminal && terminals.get(vscode.window.activeTerminal) === pty) {
            updateStatusBar(statusBar, pty);
          }
        }));
        return new vscode.TerminalProfile({ name: 'Dinotty', pty });
      }
    }),
    vscode.window.onDidOpenTerminal((terminal) => {
      const options = terminal.creationOptions;
      if ('pty' in options && options.pty instanceof DinottyPty) {
        terminals.set(terminal, options.pty);
        updateActiveTerminal(vscode.window.activeTerminal);
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const pty = terminals.get(terminal);
      if (pty) {
        terminals.delete(terminal);
        ptys.delete(pty);
      }
      updateActiveTerminal(vscode.window.activeTerminal);
    }),
    vscode.window.onDidChangeActiveTerminal(updateActiveTerminal),
    vscode.window.onDidChangeWindowState((state) => {
      for (const pty of ptys) {
        pty.setWindowFocused(state.focused);
      }
    }),
    { dispose: () => {
      for (const pty of ptys) {
        pty.dispose();
      }
      ptys.clear();
      terminals.clear();
    } },
    statusBar,
    outputChannel
  );
}

function updateStatusBar(statusBar: vscode.StatusBarItem, pty: DinottyPty | undefined): void {
  const status = pty?.getStatus();
  if (!status) {
    statusBar.hide();
    return;
  }
  statusBar.text = `$(terminal) Dinotty: ${status}`;
  statusBar.tooltip = status;
  statusBar.show();
}

export function deactivate(): void {}
