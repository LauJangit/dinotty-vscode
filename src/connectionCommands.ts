import * as vscode from 'vscode';
import {
  CredentialChange,
  DinottyConnectionProfile,
  ConnectionProfileValidationError,
  isRemotePlainHttp,
  normalizeAccessToken,
  normalizeConnectionName,
  normalizeServerUrl,
  validateConnectionSecurity
} from './connectionProfile';
import {
  ConnectionProfileNotFoundError,
  ConnectionProfileStore,
  ConnectionStoreBusyError,
  ConnectionStoreCommitOutcomeUnknownError,
  ConnectionStoreDisposedError,
  ConnectionStoreUnavailableError,
  ConnectionStoreWriteNotCommittedError,
  CredentialUnavailableError,
  DuplicateConnectionNameError
} from './connectionProfileStore';
import { DinottyClient, DinottyClientError, formatError } from './dinottyClient';
import { DinottyTerminalService, TerminalServiceDisposedError } from './dinottyTerminalService';
import { CancellationTokenLike } from './terminalProfileController';

interface CredentialChoice extends vscode.QuickPickItem {
  readonly change: 'keep' | 'replace' | 'clear';
}

export class ConnectionCommands implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lifetimeCancellation = new vscode.CancellationTokenSource();
  private disposed = false;

  constructor(
    private readonly store: ConnectionProfileStore,
    private readonly terminals: DinottyTerminalService,
    private readonly output: vscode.OutputChannel
  ) {}

  register(): readonly vscode.Disposable[] {
    if (this.disposables.length > 0) {
      return this.disposables;
    }
    this.disposables.push(
      vscode.commands.registerCommand('dinotty.addConnection', () =>
        this.run(() => this.addConnection(this.lifetimeCancellation.token))),
      vscode.commands.registerCommand('dinotty.connect', () => this.run(async () => {
        const id = await this.selectProfileId(this.lifetimeCancellation.token);
        if (id) {
          await this.terminals.open(id);
        }
      })),
      vscode.commands.registerCommand('dinotty.connectProfile', (target: unknown) => this.run(async () => {
        const id = profileIdFromTarget(target);
        if (id) {
          await this.terminals.open(id);
        }
      })),
      vscode.commands.registerCommand('dinotty.editConnection', (target: unknown) => this.run(async () => {
        const id = profileIdFromTarget(target);
        if (id) {
          await this.editConnection(id, this.lifetimeCancellation.token);
        }
      })),
      vscode.commands.registerCommand('dinotty.deleteConnection', (target: unknown) => this.run(async () => {
        const id = profileIdFromTarget(target);
        if (id) {
          await this.deleteConnection(id);
        }
      })),
      vscode.commands.registerCommand('dinotty.testProfile', (target: unknown) => this.run(async () => {
        const id = profileIdFromTarget(target);
        if (id) {
          await this.testProfile(id);
        }
      })),
      vscode.commands.registerCommand('dinotty.setDefaultConnection', (target: unknown) => this.run(async () => {
        const id = profileIdFromTarget(target);
        if (id) {
          await this.requireWritable();
          await this.store.setDefault(id);
        }
      })),
      vscode.commands.registerCommand('dinotty.refreshConnections', () => this.run(async () => {
        await this.store.refresh();
      })),
      vscode.commands.registerCommand('dinotty.showLog', () => this.output.show(true))
    );
    return this.disposables;
  }

  async addConnection(token?: CancellationTokenLike): Promise<string | undefined> {
    await this.requireWritable();
    const serverUrlValue = await showInput({
      title: 'Add Dinotty Connection (1/3)',
      prompt: 'Dinotty server URL',
      value: 'http://127.0.0.1:8999',
      ignoreFocusOut: true,
      validate: validateUrlInput
    }, token);
    if (serverUrlValue === undefined) {
      return undefined;
    }
    const serverUrl = normalizeServerUrl(serverUrlValue);
    const suggestedName = new URL(serverUrl).hostname.replace(/^\[|\]$/g, '');
    const nameValue = await showInput({
      title: 'Add Dinotty Connection (2/3)',
      prompt: 'Connection name',
      value: suggestedName,
      ignoreFocusOut: true,
      validate: validateNameInput
    }, token);
    if (nameValue === undefined) {
      return undefined;
    }
    const name = normalizeConnectionName(nameValue);
    const accessTokenValue = await showInput({
      title: 'Add Dinotty Connection (3/3)',
      prompt: 'Access code (leave empty for no authentication)',
      password: true,
      ignoreFocusOut: true,
      validate: (value) => validateTokenInput(serverUrl, value, true)
    }, token);
    if (accessTokenValue === undefined) {
      return undefined;
    }
    const accessToken = normalizeAccessToken(accessTokenValue, true);

    if (isRemotePlainHttp(serverUrl)) {
      const choice = await vscode.window.showWarningMessage(
        'This connection uses unencrypted HTTP. Any access code and terminal traffic can be observed or changed in transit.',
        { modal: true },
        'Save Anyway'
      );
      if (choice !== 'Save Anyway' || token?.isCancellationRequested || this.disposed) {
        return undefined;
      }
    }
    if (token?.isCancellationRequested || this.disposed) {
      return undefined;
    }

    const profile = await this.store.add({ name, serverUrl, accessToken });
    return profile.id;
  }

  async editConnection(profileId: string, token?: CancellationTokenLike): Promise<void> {
    await this.requireWritable();
    const profile = await this.requireProfile(profileId);
    const serverUrlValue = await showInput({
      title: `Edit ${profile.name} (1/3)`,
      prompt: 'Dinotty server URL',
      value: profile.serverUrl,
      ignoreFocusOut: true,
      validate: validateUrlInput
    }, token);
    if (serverUrlValue === undefined) {
      return;
    }
    const serverUrl = normalizeServerUrl(serverUrlValue);
    const nameValue = await showInput({
      title: `Edit ${profile.name} (2/3)`,
      prompt: 'Connection name',
      value: profile.name,
      ignoreFocusOut: true,
      validate: validateNameInput
    }, token);
    if (nameValue === undefined) {
      return;
    }
    const name = normalizeConnectionName(nameValue);

    const choices: CredentialChoice[] = [
      { label: 'Keep existing access code', change: 'keep' },
      { label: 'Replace access code', change: 'replace' },
      { label: 'Clear access code', change: 'clear' }
    ];
    const selected = await showQuickPick(choices, {
      title: `Edit ${profile.name} (3/3)`,
      placeholder: 'Choose how to update the saved access code'
    }, token);
    if (!selected) {
      return;
    }

    let credential: CredentialChange;
    if (selected.change === 'replace') {
      const value = await showInput({
        title: `Replace Access Code for ${profile.name}`,
        prompt: 'New access code',
        password: true,
        ignoreFocusOut: true,
        validate: (candidate) => validateTokenInput(serverUrl, candidate, false)
      }, token);
      if (value === undefined) {
        return;
      }
      credential = { kind: 'replace', accessToken: value };
    } else {
      credential = { kind: selected.change };
    }
    if (isRemotePlainHttp(serverUrl)) {
      const choice = await vscode.window.showWarningMessage(
        'This connection uses unencrypted HTTP. Any access code and terminal traffic can be observed or changed in transit.',
        { modal: true },
        'Save Anyway'
      );
      if (choice !== 'Save Anyway') {
        return;
      }
    }
    if (token?.isCancellationRequested || this.disposed) {
      return;
    }
    await this.store.update(profileId, { name, serverUrl, credential });
  }

  async deleteConnection(profileId: string): Promise<void> {
    await this.requireWritable();
    const profile = await this.requireProfile(profileId);
    const confirmed = await vscode.window.showWarningMessage(
      `Delete Dinotty connection "${profile.name}"? Existing terminals will remain connected.`,
      { modal: true },
      'Delete'
    );
    if (confirmed === 'Delete' && !this.disposed) {
      await this.store.delete(profileId);
    }
  }

  async testProfile(profileId: string): Promise<void> {
    const connection = await this.store.resolve(profileId);
    if (this.disposed) {
      return;
    }
    const abortController = new AbortController();
    const cancellation = this.lifetimeCancellation.token.onCancellationRequested(() => abortController.abort());
    if (this.lifetimeCancellation.token.isCancellationRequested) {
      abortController.abort();
    }
    try {
      await new DinottyClient(connection).testConnection({ signal: abortController.signal });
      if (!this.disposed) {
        void vscode.window.showInformationMessage(`Dinotty connection "${connection.name}" succeeded.`);
      }
    } finally {
      cancellation.dispose();
    }
  }

  async selectProfileId(token?: CancellationTokenLike): Promise<string | undefined> {
    try {
      await this.store.refresh();
    } catch {
      // A validated cached snapshot remains usable in read-only degraded mode.
    }
    if (!this.store.currentStatus.available) {
      throw new ConnectionStoreUnavailableError();
    }
    const profiles = await this.store.list();
    if (token?.isCancellationRequested) {
      return undefined;
    }
    if (profiles.length === 0) {
      if (!this.store.currentStatus.writable) {
        void vscode.window.showWarningMessage('Connections are temporarily read-only. Refresh before adding a connection.');
        return undefined;
      }
      return this.addConnection(token);
    }
    if (profiles.length === 1) {
      return profiles[0].id;
    }

    const defaultId = await this.store.getDefaultId();
    const sorted = [...profiles].sort((left, right) => Number(right.id === defaultId) - Number(left.id === defaultId));
    const items = sorted.map((profile) => ({
      label: profile.name,
      description: profile.id === defaultId ? 'Default' : undefined,
      detail: profile.serverUrl,
      profileId: profile.id
    }));
    const selected = await showQuickPick(items, {
      title: 'Connect to Dinotty',
      placeholder: 'Choose a connection'
    }, token);
    return selected?.profileId;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifetimeCancellation.cancel();
    this.lifetimeCancellation.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  reportError(error: unknown): void {
    if (this.disposed || error instanceof TerminalServiceDisposedError || error instanceof ConnectionStoreDisposedError) {
      return;
    }
    this.output.appendLine(describeErrorForLog(error));
    void vscode.window.showErrorMessage(describeErrorForUser(error));
  }

  private async requireWritable(): Promise<void> {
    if (!this.store.currentStatus.writable) {
      throw new ConnectionStoreUnavailableError('Connections are temporarily read-only. Refresh and try again.');
    }
  }

  private async requireProfile(id: string): Promise<DinottyConnectionProfile> {
    const profile = await this.store.get(id);
    if (!profile) {
      throw new ConnectionProfileNotFoundError();
    }
    return profile;
  }

  private async run(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (!this.disposed) {
        this.reportError(error);
      }
    }
  }
}

interface InputOptions {
  readonly title: string;
  readonly prompt: string;
  readonly value?: string;
  readonly password?: boolean;
  readonly ignoreFocusOut?: boolean;
  readonly validate: (value: string) => string | undefined;
}

async function showInput(options: InputOptions, token?: CancellationTokenLike): Promise<string | undefined> {
  if (token?.isCancellationRequested) {
    return undefined;
  }
  const input = vscode.window.createInputBox();
  input.title = options.title;
  input.prompt = options.prompt;
  input.value = options.value ?? '';
  input.password = options.password ?? false;
  input.ignoreFocusOut = options.ignoreFocusOut ?? false;
  input.validationMessage = options.validate(input.value);
  return new Promise((resolve) => {
    let settled = false;
    const disposables: vscode.Disposable[] = [];
    const finish = (value: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      input.dispose();
      resolve(value);
    };
    disposables.push(
      input.onDidChangeValue((value) => {
        input.validationMessage = options.validate(value);
      }),
      input.onDidAccept(() => {
        const validation = options.validate(input.value);
        input.validationMessage = validation;
        if (!validation) {
          finish(input.value);
        }
      }),
      input.onDidHide(() => finish(undefined))
    );
    const cancellation = cancellationEvent(token);
    if (cancellation) {
      disposables.push(cancellation(() => finish(undefined)));
    }
    input.show();
  });
}

async function showQuickPick<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options: { readonly title: string; readonly placeholder: string },
  token?: CancellationTokenLike
): Promise<T | undefined> {
  if (token?.isCancellationRequested) {
    return undefined;
  }
  const quickPick = vscode.window.createQuickPick<T>();
  quickPick.title = options.title;
  quickPick.placeholder = options.placeholder;
  quickPick.items = items;
  quickPick.ignoreFocusOut = true;
  return new Promise((resolve) => {
    let settled = false;
    const disposables: vscode.Disposable[] = [];
    const finish = (value: T | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      quickPick.dispose();
      resolve(value);
    };
    disposables.push(
      quickPick.onDidAccept(() => finish(quickPick.selectedItems[0])),
      quickPick.onDidHide(() => finish(undefined))
    );
    const cancellation = cancellationEvent(token);
    if (cancellation) {
      disposables.push(cancellation(() => finish(undefined)));
    }
    quickPick.show();
  });
}

function cancellationEvent(token: CancellationTokenLike | undefined): vscode.Event<unknown> | undefined {
  const candidate = token as { readonly onCancellationRequested?: vscode.Event<unknown> } | undefined;
  return candidate?.onCancellationRequested;
}

function validateUrlInput(value: string): string | undefined {
  try {
    normalizeServerUrl(value);
    return undefined;
  } catch (error) {
    return validationMessage(error);
  }
}

function validateNameInput(value: string): string | undefined {
  try {
    normalizeConnectionName(value);
    return undefined;
  } catch (error) {
    return validationMessage(error);
  }
}

function validateTokenInput(serverUrl: string, value: string, allowEmpty: boolean): string | undefined {
  try {
    const token = normalizeAccessToken(value, allowEmpty);
    validateConnectionSecurity(serverUrl, token);
    return undefined;
  } catch (error) {
    return validationMessage(error);
  }
}

function validationMessage(error: unknown): string {
  return error instanceof ConnectionProfileValidationError ? error.message : 'The value is invalid.';
}

function profileIdFromTarget(target: unknown): string | undefined {
  if (typeof target === 'string') {
    return target;
  }
  if (typeof target === 'object' && target !== null && typeof (target as { id?: unknown }).id === 'string') {
    return (target as { id: string }).id;
  }
  return undefined;
}

function describeErrorForUser(error: unknown): string {
  if (
    error instanceof ConnectionProfileValidationError ||
    error instanceof DuplicateConnectionNameError ||
    error instanceof ConnectionStoreBusyError ||
    error instanceof ConnectionStoreUnavailableError ||
    error instanceof ConnectionStoreWriteNotCommittedError ||
    error instanceof ConnectionStoreCommitOutcomeUnknownError ||
    error instanceof ConnectionProfileNotFoundError ||
    error instanceof CredentialUnavailableError ||
    error instanceof DinottyClientError
  ) {
    return error.message;
  }
  return 'Dinotty could not complete the operation. See the Dinotty output for details.';
}

function describeErrorForLog(error: unknown): string {
  if (error instanceof DinottyClientError) {
    return `Dinotty operation failed: ${formatError(error)}`;
  }
  if (error instanceof Error && describeErrorForUser(error) === error.message) {
    return `Dinotty operation failed: ${error.message}`;
  }
  return 'Dinotty operation failed with an unexpected error.';
}
