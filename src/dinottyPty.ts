import * as vscode from 'vscode';
import WebSocket = require('ws');
import { AuthenticationError, ConnectionError, DinottyClient, HttpError, formatError } from './dinottyClient';
import { LocalTerminalAppearance, TerminalAppearanceMode, resolveLocalTerminalAppearance } from './appearance';
import { describeServerMessageType, encodeClientMessage, Geometry, parseServerMessage } from './protocol';
import { TerminalEffect, TerminalEvent, TerminalStateMachine } from './terminalState';

const WS_CONNECT_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_WINDOW_MS = 5 * 60_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const RIS = '\x1bc';

interface DinottyPtyOptions {
  client: DinottyClient;
  cwd?: string;
  appearanceMode?: TerminalAppearanceMode;
  logger?: (message: string) => void;
}

export class DinottyPty implements vscode.Pseudoterminal, vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  private readonly overrideDimensionsEmitter = new vscode.EventEmitter<vscode.TerminalDimensions | undefined>();
  private readonly changeNameEmitter = new vscode.EventEmitter<string>();
  private readonly statusEmitter = new vscode.EventEmitter<string>();
  private readonly machine = new TerminalStateMachine();
  private readonly timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();

  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  readonly onDidOverrideDimensions = this.overrideDimensionsEmitter.event;
  readonly onDidChangeName = this.changeNameEmitter.event;
  readonly onDidChangeStatus = this.statusEmitter.event;

  private ws?: WebSocket;
  private userClosed = false;
  private authoritativeEnd = false;
  private abortController?: AbortController;
  private paneId?: string;
  private closedFired = false;
  private connectionGeneration = 0;
  private reconnectAttempts = 0;
  private reconnectStartedAt = 0;
  private status = '';
  private appearance: LocalTerminalAppearance = resolveLocalTerminalAppearance('native');

  constructor(private readonly options: DinottyPtyOptions) {}

  open(initialDimensions?: vscode.TerminalDimensions): void {
    if (initialDimensions) {
      this.dispatch({ type: 'local_capacity', geometry: toGeometry(initialDimensions) });
    }
    this.abortController = new AbortController();
    void this.createAndConnect(this.abortController.signal);
  }

  close(): void {
    if (this.userClosed) {
      return;
    }
    this.userClosed = true;
    this.abortController?.abort();
    this.clearAllTimeouts();
    this.connectionGeneration += 1;
    this.ws?.close();
    this.disposeEmitters();
  }

  dispose(): void {
    this.close();
  }

  handleInput(data: string): void {
    this.dispatch({ type: 'user_input', data });
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dispatch({ type: 'local_capacity', geometry: toGeometry(dimensions) });
  }

  setActive(active: boolean): void {
    this.dispatch({ type: 'active_changed', active });
  }

  setWindowFocused(focused: boolean): void {
    this.dispatch({ type: 'window_focus_changed', focused });
  }

  getStatus(): string {
    return this.status;
  }

  private async createAndConnect(signal: AbortSignal): Promise<void> {
    this.applyEffects(this.machine.dispatch({ type: 'transport_connecting' }));
    try {
      const mode = this.options.appearanceMode ?? 'native';
      if (mode !== 'native') {
        try {
          const settings = await this.options.client.getSettings({ signal });
          this.appearance = resolveLocalTerminalAppearance(mode, settings);
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          this.appearance = resolveLocalTerminalAppearance('native');
          this.options.logger?.(`Appearance settings unavailable; using native mode: ${formatError(error)}`);
        }
      }

      const tab = await this.options.client.createTab({ cwd: this.options.cwd, signal });
      if (signal.aborted || this.userClosed) {
        return;
      }
      this.paneId = tab.pane_id;
      this.options.logger?.(`Created Dinotty tab and pane ${tab.pane_id}`);
      this.reconnectStartedAt = Date.now();
      this.connectWebSocket(tab.pane_id);
    } catch (error) {
      if (signal.aborted || this.userClosed) {
        return;
      }
      this.options.logger?.(`Failed to create Dinotty tab: ${formatError(error)}`);
      if (error instanceof AuthenticationError) {
        this.failAndClose('Authentication failed. Run "Dinotty: Configure Server" to update the token.');
      } else if (error instanceof ConnectionError) {
        this.failAndClose('Could not connect to the Dinotty server.');
      } else {
        this.failAndClose(`Could not create a Dinotty session: ${formatError(error)}`);
      }
    }
  }

  private connectWebSocket(paneId: string): void {
    if (this.userClosed || this.authoritativeEnd) {
      return;
    }
    const generation = ++this.connectionGeneration;
    this.applyEffects(this.machine.dispatch({ type: 'transport_connecting' }));

    void this.options.client.buildPaneWsConnection(paneId).then((connection) => {
      if (!this.isCurrentGeneration(generation)) {
        return;
      }
      this.options.logger?.(`Connecting WebSocket to ${connection.redactedUrl}`);
      const ws = new WebSocket(connection.url, connection.headers ? { headers: connection.headers } : undefined);
      this.ws = ws;
      let terminalFailure = false;

      const connectTimer = setTimeout(() => {
        if (this.isCurrentSocket(generation, ws) && ws.readyState === WebSocket.CONNECTING) {
          this.options.logger?.(`WebSocket connection timed out after ${WS_CONNECT_TIMEOUT_MS}ms`);
          ws.terminate();
        }
      }, WS_CONNECT_TIMEOUT_MS);

      ws.on('unexpected-response', (_request, response) => {
        if (!this.isCurrentSocket(generation, ws)) {
          response.resume();
          return;
        }
        terminalFailure = response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 404;
        const status = response.statusCode;
        response.resume();
        this.options.logger?.(`WebSocket upgrade rejected with HTTP ${status}`);
        if (status === 401 || status === 403) {
          this.setStatus('Dinotty authentication failed.');
        } else if (status === 404) {
          this.setStatus('The Dinotty pane no longer exists.');
        }
      });

      ws.on('open', () => {
        clearTimeout(connectTimer);
        if (!this.isCurrentSocket(generation, ws)) {
          ws.close();
          return;
        }
        this.options.logger?.('WebSocket connected; waiting for reconnected handshake');
        this.applyEffects(this.machine.dispatch({ type: 'transport_open' }));
      });

      ws.on('message', (data) => {
        if (!this.isCurrentSocket(generation, ws)) {
          return;
        }
        const raw = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
        this.handleMessage(raw);
      });

      ws.on('error', (error) => {
        clearTimeout(connectTimer);
        if (this.isCurrentSocket(generation, ws)) {
          this.options.logger?.(`WebSocket transport error: ${formatError(error)}`);
        }
      });

      ws.on('close', () => {
        clearTimeout(connectTimer);
        if (!this.isCurrentSocket(generation, ws)) {
          return;
        }
        this.ws = undefined;
        if (this.userClosed || this.authoritativeEnd) {
          return;
        }
        this.applyEffects(this.machine.dispatch({ type: 'transport_closed' }));
        if (terminalFailure) {
          this.endSession();
        } else {
          this.scheduleReconnect();
        }
      });
    }).catch((error) => {
      if (!this.isCurrentGeneration(generation)) {
        return;
      }
      this.options.logger?.(`Could not prepare WebSocket connection: ${formatError(error)}`);
      if (error instanceof AuthenticationError || (error instanceof HttpError && error.statusCode === 404)) {
        this.failAndClose(formatError(error));
      } else {
        this.scheduleReconnect();
      }
    });
  }

  private handleMessage(raw: string): void {
    const message = parseServerMessage(raw);
    if (!message) {
      this.options.logger?.(`Ignored unknown server message type: ${describeServerMessageType(raw)}`);
      return;
    }

    let event: TerminalEvent;
    switch (message.type) {
      case 'output':
        event = message;
        break;
      case 'resize':
        event = { type: 'remote_resize', cols: message.cols, rows: message.rows };
        break;
      case 'reconnected':
      case 'replay_begin':
      case 'replay_end':
      case 'sync_begin':
      case 'sync_end':
        event = message;
        break;
      case 'shell_info':
        this.options.logger?.(`Received shell information: ${message.shell_type || 'unknown'}`);
        return;
      case 'session_exit':
        this.authoritativeEnd = true;
        event = { type: 'session_exit' };
        break;
    }
    this.dispatch(event);
    if (message.type === 'replay_end') {
      const state = this.machine.snapshot().renderState;
      if (state === 'ready_local' || state === 'ready_remote') {
        this.reconnectAttempts = 0;
        this.reconnectStartedAt = 0;
      }
    }
  }

  private dispatch(event: TerminalEvent): void {
    this.applyEffects(this.machine.dispatch(event));
  }

  private applyEffects(effects: TerminalEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'send':
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(encodeClientMessage(effect.message));
          }
          break;
        case 'write':
          this.writeEmitter.fire(effect.data);
          break;
        case 'commit_replay':
          this.writeEmitter.fire(`${RIS}${this.appearance.osc}${effect.data}`);
          break;
        case 'override_dimensions':
          this.overrideDimensionsEmitter.fire(effect.dimensions ? {
            columns: effect.dimensions.cols,
            rows: effect.dimensions.rows
          } : undefined);
          break;
        case 'set_status':
          this.setStatus(effect.status);
          break;
        case 'schedule_timeout':
          this.scheduleMachineTimeout(effect.timeout, effect.ms);
          break;
        case 'cancel_timeout':
          this.clearTimeout(effect.timeout);
          break;
        case 'close_terminal':
          this.endSession();
          break;
      }
    }
  }

  private scheduleMachineTimeout(name: 'transaction' | 'snapshot', ms: number): void {
    this.clearTimeout(name);
    const generation = this.connectionGeneration;
    this.timeoutHandles.set(name, setTimeout(() => {
      this.timeoutHandles.delete(name);
      if (this.isCurrentGeneration(generation)) {
        this.dispatch({ type: name === 'transaction' ? 'transaction_timeout' : 'snapshot_timeout' });
      }
    }, ms));
  }

  private scheduleReconnect(): void {
    if (!this.paneId || this.userClosed || this.authoritativeEnd) {
      return;
    }
    if (this.reconnectAttempts === 0 || this.reconnectStartedAt === 0) {
      this.reconnectStartedAt = Date.now();
    }
    const elapsed = Date.now() - this.reconnectStartedAt;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS || elapsed >= MAX_RECONNECT_WINDOW_MS) {
      this.setStatus('Dinotty reconnect limit reached. Reopen the terminal to retry.');
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempts += 1;
    const generation = this.connectionGeneration;
    this.setStatus(`Dinotty disconnected. Reconnecting in ${Math.ceil(delay / 1000)}s...`);
    this.clearTimeout('reconnect');
    this.timeoutHandles.set('reconnect', setTimeout(() => {
      this.timeoutHandles.delete('reconnect');
      if (this.isCurrentGeneration(generation) && this.paneId) {
        this.connectWebSocket(this.paneId);
      }
    }, delay));
  }

  private failAndClose(message: string): void {
    this.setStatus(message);
    void vscode.window.showErrorMessage(`Dinotty: ${message}`);
    this.endSession();
  }

  private endSession(): void {
    if (this.closedFired || this.userClosed) {
      return;
    }
    this.closedFired = true;
    this.authoritativeEnd = true;
    this.clearAllTimeouts();
    this.connectionGeneration += 1;
    this.ws?.close();
    this.closeEmitter.fire();
  }

  private setStatus(status: string): void {
    if (status === this.status) {
      return;
    }
    this.status = status;
    this.statusEmitter.fire(status);
    this.changeNameEmitter.fire(status ? `Dinotty - ${status}` : 'Dinotty');
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.userClosed && !this.authoritativeEnd && generation === this.connectionGeneration;
  }

  private isCurrentSocket(generation: number, ws: WebSocket): boolean {
    return this.isCurrentGeneration(generation) && this.ws === ws;
  }

  private clearTimeout(name: string): void {
    const handle = this.timeoutHandles.get(name);
    if (handle) {
      clearTimeout(handle);
      this.timeoutHandles.delete(name);
    }
  }

  private clearAllTimeouts(): void {
    for (const handle of this.timeoutHandles.values()) {
      clearTimeout(handle);
    }
    this.timeoutHandles.clear();
  }

  private disposeEmitters(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.overrideDimensionsEmitter.dispose();
    this.changeNameEmitter.dispose();
    this.statusEmitter.dispose();
  }
}

function toGeometry(dimensions: vscode.TerminalDimensions): Geometry {
  return { cols: dimensions.columns, rows: dimensions.rows };
}
