import * as vscode from 'vscode';
import type { TerminalAppearanceMode } from './appearance';
import { resolveTerminalAppearanceMode } from './appearanceConfig';

const ACCESS_TOKEN_SECRET_KEY = 'dinotty.accessToken';
const SERVER_URL_SETTING = 'dinotty.serverUrl';
const SYNC_APPEARANCE_SETTING = 'dinotty.syncAppearanceFromDinotty';
const APPEARANCE_MODE_SETTING = 'dinotty.terminalAppearanceMode';

export interface DinottyConfig {
  serverUrl: string;
  accessToken?: string;
}

export class ConfigStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getConfig(): Promise<DinottyConfig> {
    const serverUrl = this.getServerUrl();
    const accessToken = await this.getToken();
    return { serverUrl, accessToken };
  }

  async configureServer(): Promise<void> {
    const currentUrl = vscode.workspace.getConfiguration().get<string>(SERVER_URL_SETTING) ?? 'http://127.0.0.1:8999';
    const serverUrl = await vscode.window.showInputBox({
      prompt: 'Dinotty Server URL',
      value: currentUrl,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Server URL is required.';
        }
        try {
          normalizeServerUrl(value);
          return undefined;
        } catch {
          return 'Invalid URL. Use http:// or https://';
        }
      }
    });

    if (serverUrl === undefined) {
      return;
    }

    const normalized = normalizeServerUrl(serverUrl);
    await vscode.workspace.getConfiguration().update(SERVER_URL_SETTING, normalized, true);

    const token = await vscode.window.showInputBox({
      prompt: 'Access Token (leave empty if no auth)',
      password: true,
      ignoreFocusOut: true
    });

    if (token === undefined) {
      return;
    }

    if (token.trim().length === 0) {
      await this.clearToken();
    } else {
      await this.setToken(token.trim());
    }

    vscode.window.showInformationMessage('Dinotty server configured.');
  }

  async getToken(): Promise<string | undefined> {
    return this.context.secrets.get(ACCESS_TOKEN_SECRET_KEY);
  }

  async setToken(token: string): Promise<void> {
    await this.context.secrets.store(ACCESS_TOKEN_SECRET_KEY, token);
  }

  async clearToken(): Promise<void> {
    await this.context.secrets.delete(ACCESS_TOKEN_SECRET_KEY);
  }

  getTerminalAppearanceMode(): TerminalAppearanceMode {
    const configuration = vscode.workspace.getConfiguration();
    return resolveTerminalAppearanceMode(
      configuration.inspect<TerminalAppearanceMode>(APPEARANCE_MODE_SETTING),
      configuration.inspect<boolean>(SYNC_APPEARANCE_SETTING)
    );
  }

  private getServerUrl(): string {
    const value = vscode.workspace.getConfiguration().get<string>(SERVER_URL_SETTING);
    return value ? normalizeServerUrl(value) : 'http://127.0.0.1:8999';
  }
}

export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Server URL is empty');
  }
  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Server URL must be http:// or https://');
  }
  if (url.search || url.hash) {
    throw new Error('Server URL must not include query string or fragment');
  }
  return url.toString().replace(/\/$/, '');
}
