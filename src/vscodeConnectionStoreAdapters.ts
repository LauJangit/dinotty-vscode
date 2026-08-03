import * as vscode from 'vscode';
import { LegacyConnectionSource, SecretStorageLike } from './connectionProfileStore';

const LEGACY_ACCESS_TOKEN_KEY = 'dinotty.accessToken';
const LEGACY_SERVER_URL_SECTION = 'dinotty';
const LEGACY_SERVER_URL_SETTING = 'serverUrl';

export class VsCodeLegacyConnectionSource implements LegacyConnectionSource {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getGlobalServerUrl(): string | undefined {
    return vscode.workspace
      .getConfiguration(LEGACY_SERVER_URL_SECTION)
      .inspect<string>(LEGACY_SERVER_URL_SETTING)
      ?.globalValue;
  }

  async getAccessToken(): Promise<string | undefined> {
    return this.context.secrets.get(LEGACY_ACCESS_TOKEN_KEY);
  }

  async clearGlobalServerUrl(): Promise<void> {
    await vscode.workspace
      .getConfiguration(LEGACY_SERVER_URL_SECTION)
      .update(LEGACY_SERVER_URL_SETTING, undefined, vscode.ConfigurationTarget.Global);
  }

  async clearAccessToken(): Promise<void> {
    await this.context.secrets.delete(LEGACY_ACCESS_TOKEN_KEY);
  }
}

export class VsCodeSecretStorage implements SecretStorageLike {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}
