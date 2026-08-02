import type { ClientToServerMessage, Geometry } from './protocol';
import { isValidGeometry, sameGeometry } from './protocol';

export type TransportState = 'idle' | 'connecting' | 'open' | 'reconnect_wait' | 'closed';
export type RenderState =
  | 'creating'
  | 'awaiting_reconnected'
  | 'awaiting_replay'
  | 'replaying'
  | 'ready_local'
  | 'ready_remote'
  | 'suspended_geometry'
  | 'renderer_invalid'
  | 'ended';

export type SnapshotReason = 'initial' | 'input_barrier' | 'resume_remote' | 'size_mismatch';

export type TerminalEvent =
  | { type: 'transport_connecting' }
  | { type: 'transport_open' }
  | { type: 'transport_closed' }
  | { type: 'local_capacity'; geometry: Geometry }
  | { type: 'active_changed'; active: boolean }
  | { type: 'window_focus_changed'; focused: boolean }
  | ({ type: 'reconnected' } & Geometry)
  | ({ type: 'remote_resize' } & Geometry)
  | ({ type: 'replay_begin' } & Geometry)
  | { type: 'output'; data: string }
  | { type: 'replay_end' }
  | { type: 'sync_begin' }
  | { type: 'sync_end' }
  | { type: 'user_input'; data: string }
  | { type: 'transaction_timeout' }
  | { type: 'snapshot_timeout' }
  | { type: 'session_exit' };

export type TerminalEffect =
  | { type: 'send'; message: ClientToServerMessage }
  | { type: 'write'; data: string }
  | { type: 'commit_replay'; data: string }
  | { type: 'override_dimensions'; dimensions?: Geometry }
  | { type: 'set_status'; status: string }
  | { type: 'schedule_timeout'; timeout: 'transaction' | 'snapshot'; ms: number }
  | { type: 'cancel_timeout'; timeout: 'transaction' | 'snapshot' }
  | { type: 'close_terminal' };

export interface TerminalStateSnapshot {
  transportState: TransportState;
  renderState: RenderState;
  localCapacity: Geometry | null;
  renderGeometry: Geometry | null;
  remoteGeometry: Geometry | null;
  pendingSnapshot: { geometry: Geometry; reason: SnapshotReason } | null;
  transactionDepth: number;
  outputWasDropped: boolean;
}

const MAX_TRANSACTION_BYTES = 8 * 1024 * 1024;
const MAX_TRANSACTION_DEPTH = 8;
const TRANSACTION_TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 15_000;
const MAX_INPUT_BYTES = 256 * 1024;

export class TerminalStateMachine {
  private transportState: TransportState = 'idle';
  private renderState: RenderState = 'creating';
  private localCapacity: Geometry | null = null;
  private renderGeometry: Geometry | null = null;
  private remoteGeometry: Geometry | null = null;
  private lastResizeSent: Geometry | null = null;
  private needsInputGeometryBarrier = false;
  private outputWasDropped = false;
  private reconnectedReceived = false;
  private pendingSnapshot: { geometry: Geometry; reason: SnapshotReason } | null = null;
  private nextSnapshot: { geometry: Geometry; reason: SnapshotReason } | null = null;
  private transactionDepth = 0;
  private transactionContainsReplay = false;
  private transactionBuffer: string[] = [];
  private transactionBytes = 0;
  private transactionInvalid = false;
  private replayGeometry: Geometry | null = null;
  private active = false;
  private windowFocused = false;
  private inputQueue: string[] = [];
  private inputBytes = 0;
  private consecutiveRecoveryFailures = 0;

  dispatch(event: TerminalEvent): TerminalEffect[] {
    const effects: TerminalEffect[] = [];
    switch (event.type) {
      case 'transport_connecting':
        this.transportState = 'connecting';
        effects.push({ type: 'set_status', status: 'Connecting to Dinotty...' });
        break;
      case 'transport_open':
        this.transportState = 'open';
        this.renderState = 'awaiting_reconnected';
        effects.push({ type: 'set_status', status: 'Waiting for terminal snapshot...' });
        break;
      case 'transport_closed':
        this.transportState = 'reconnect_wait';
        this.reconnectedReceived = false;
        this.pendingSnapshot = null;
        this.resetTransaction(effects);
        effects.push({ type: 'cancel_timeout', timeout: 'snapshot' });
        this.outputWasDropped = true;
        if (this.renderState !== 'ended') {
          this.renderState = 'awaiting_reconnected';
        }
        break;
      case 'local_capacity':
        this.handleLocalCapacity(event.geometry, effects);
        break;
      case 'active_changed':
        this.active = event.active;
        break;
      case 'window_focus_changed':
        this.windowFocused = event.focused;
        break;
      case 'reconnected':
        this.reconnectedReceived = true;
        if (this.localCapacity) {
          this.requestSnapshot(this.localCapacity, 'initial', effects);
        } else {
          effects.push({ type: 'set_status', status: 'Waiting for terminal panel dimensions...' });
        }
        break;
      case 'remote_resize':
        this.handleRemoteResize({ cols: event.cols, rows: event.rows }, effects);
        break;
      case 'replay_begin':
        this.replayGeometry = { cols: event.cols, rows: event.rows };
        this.transactionContainsReplay = true;
        this.renderState = 'replaying';
        this.beginTransaction(effects);
        break;
      case 'sync_begin':
        this.beginTransaction(effects);
        break;
      case 'output':
        this.handleOutput(event.data, effects);
        break;
      case 'replay_end':
      case 'sync_end':
        this.endTransaction(effects);
        break;
      case 'user_input':
        this.handleInput(event.data, effects);
        break;
      case 'transaction_timeout':
        if (this.transactionDepth > 0) {
          this.transactionInvalid = true;
          this.invalidateRenderer(effects, 'Terminal update timed out; requesting a fresh snapshot...');
          effects.push({ type: 'cancel_timeout', timeout: 'transaction' });
          if (this.transactionContainsReplay) {
            this.pendingSnapshot = null;
            effects.push({ type: 'cancel_timeout', timeout: 'snapshot' });
          }
          this.finishInvalidTransaction(effects);
        }
        break;
      case 'snapshot_timeout':
        if (this.pendingSnapshot) {
          const retry = this.pendingSnapshot;
          this.pendingSnapshot = null;
          this.consecutiveRecoveryFailures += 1;
          this.renderState = 'renderer_invalid';
          this.outputWasDropped = true;
          if (this.consecutiveRecoveryFailures < 2) {
            this.requestSnapshot(retry.geometry, retry.reason, effects);
          } else {
            effects.push({ type: 'set_status', status: 'Terminal snapshot repeatedly timed out. Reopen the terminal to retry.' });
          }
        }
        break;
      case 'session_exit':
        this.transportState = 'closed';
        this.renderState = 'ended';
        this.inputQueue = [];
        this.inputBytes = 0;
        this.resetTransaction(effects);
        effects.push({ type: 'cancel_timeout', timeout: 'snapshot' }, { type: 'close_terminal' });
        break;
    }
    return effects;
  }

  snapshot(): TerminalStateSnapshot {
    return {
      transportState: this.transportState,
      renderState: this.renderState,
      localCapacity: this.localCapacity,
      renderGeometry: this.renderGeometry,
      remoteGeometry: this.remoteGeometry,
      pendingSnapshot: this.pendingSnapshot,
      transactionDepth: this.transactionDepth,
      outputWasDropped: this.outputWasDropped
    };
  }

  private handleLocalCapacity(geometry: Geometry, effects: TerminalEffect[]): void {
    if (!isValidGeometry(geometry)) {
      return;
    }
    const changed = !sameGeometry(this.localCapacity, geometry);
    this.localCapacity = geometry;

    if (this.reconnectedReceived && !this.pendingSnapshot && (this.renderState === 'awaiting_reconnected' || this.renderState === 'creating')) {
      this.requestSnapshot(geometry, 'initial', effects);
      return;
    }
    if (this.pendingSnapshot) {
      if (!sameGeometry(this.pendingSnapshot.geometry, geometry) && this.pendingSnapshot.reason !== 'resume_remote') {
        this.nextSnapshot = { geometry, reason: 'size_mismatch' };
      }
      return;
    }
    if (this.renderState === 'ready_local' && changed && this.transportState === 'open') {
      if (!sameGeometry(this.lastResizeSent, geometry)) {
        effects.push({ type: 'send', message: { type: 'resize', ...geometry } });
        this.lastResizeSent = geometry;
      }
      this.needsInputGeometryBarrier = true;
      return;
    }
    if (this.renderState === 'ready_remote' && this.remoteGeometry && !this.fits(this.remoteGeometry)) {
      this.suspend(effects);
      return;
    }
    if (this.renderState === 'suspended_geometry' && this.remoteGeometry && this.fits(this.remoteGeometry)) {
      this.requestSnapshot(this.remoteGeometry, 'resume_remote', effects);
    }
  }

  private handleRemoteResize(geometry: Geometry, effects: TerminalEffect[]): void {
    this.remoteGeometry = geometry;
    if (this.transactionDepth > 0) {
      this.transactionInvalid = true;
      this.invalidateRenderer(effects, 'Terminal resized during an update; requesting a fresh snapshot...');
      return;
    }
    if (!this.fits(geometry)) {
      this.suspend(effects);
      return;
    }
    if (this.outputWasDropped || this.renderState === 'suspended_geometry' || this.renderState === 'renderer_invalid') {
      this.requestSnapshot(geometry, 'resume_remote', effects);
      return;
    }
    this.renderGeometry = geometry;
    this.renderState = 'ready_remote';
    this.needsInputGeometryBarrier = true;
    effects.push(
      { type: 'override_dimensions', dimensions: geometry },
      { type: 'set_status', status: `Following remote terminal ${geometry.cols}x${geometry.rows}` }
    );
  }

  private handleOutput(data: string, effects: TerminalEffect[]): void {
    if (this.transactionDepth > 0) {
      if (this.transactionInvalid) {
        return;
      }
      const bytes = Buffer.byteLength(data);
      if (this.transactionBytes + bytes > MAX_TRANSACTION_BYTES) {
        this.transactionInvalid = true;
        this.invalidateRenderer(effects, 'Terminal update was too large; requesting a fresh snapshot...');
        return;
      }
      this.transactionBytes += bytes;
      this.transactionBuffer.push(data);
      return;
    }
    if (this.renderState === 'ready_local' || this.renderState === 'ready_remote') {
      effects.push({ type: 'write', data });
    } else {
      this.outputWasDropped = true;
    }
  }

  private handleInput(data: string, effects: TerminalEffect[]): void {
    if (!data || this.renderState === 'ended') {
      return;
    }
    if (this.transportState !== 'open') {
      this.queueInput(data, effects);
      return;
    }

    if (!this.active || !this.windowFocused) {
      effects.push({ type: 'send', message: { type: 'input', data } });
      return;
    }

    const barrierRequired = this.localCapacity !== null &&
      (this.renderState === 'ready_remote' || this.renderState === 'suspended_geometry' || this.renderState === 'renderer_invalid' ||
        this.renderState === 'awaiting_reconnected' || this.needsInputGeometryBarrier);

    if (barrierRequired && !this.pendingSnapshot) {
      this.requestSnapshot(this.localCapacity!, 'input_barrier', effects);
    }
    if (this.pendingSnapshot || this.renderState === 'ready_local' || this.renderState === 'ready_remote') {
      effects.push({ type: 'send', message: { type: 'input', data } });
    } else {
      this.queueInput(data, effects);
    }
  }

  private queueInput(data: string, effects: TerminalEffect[]): void {
    const bytes = Buffer.byteLength(data);
    if (this.inputBytes + bytes > MAX_INPUT_BYTES) {
      effects.push({ type: 'set_status', status: 'Input was not sent because the reconnect queue is full.' });
      return;
    }
    this.inputQueue.push(data);
    this.inputBytes += bytes;
    effects.push({ type: 'set_status', status: 'Input queued while Dinotty reconnects...' });
  }

  private requestSnapshot(geometry: Geometry, reason: SnapshotReason, effects: TerminalEffect[]): void {
    if (this.transportState !== 'open' || this.renderState === 'ended') {
      return;
    }
    if (this.pendingSnapshot) {
      this.nextSnapshot = { geometry, reason };
      return;
    }
    this.pendingSnapshot = { geometry, reason };
    this.renderState = 'awaiting_replay';
    this.outputWasDropped = true;
    effects.push(
      { type: 'send', message: { type: 'snapshot_request', ...geometry } },
      { type: 'schedule_timeout', timeout: 'snapshot', ms: SNAPSHOT_TIMEOUT_MS },
      { type: 'set_status', status: 'Synchronizing terminal snapshot...' }
    );
    for (const data of this.inputQueue) {
      effects.push({ type: 'send', message: { type: 'input', data } });
    }
    this.inputQueue = [];
    this.inputBytes = 0;
  }

  private beginTransaction(effects: TerminalEffect[]): void {
    if (this.transactionDepth === 0) {
      this.transactionBuffer = [];
      this.transactionBytes = 0;
      this.transactionInvalid = false;
      effects.push({ type: 'schedule_timeout', timeout: 'transaction', ms: TRANSACTION_TIMEOUT_MS });
    }
    this.transactionDepth += 1;
    if (this.transactionDepth > MAX_TRANSACTION_DEPTH) {
      this.transactionInvalid = true;
      this.invalidateRenderer(effects, 'Terminal update nesting limit exceeded; requesting a fresh snapshot...');
    }
  }

  private endTransaction(effects: TerminalEffect[]): void {
    if (this.transactionDepth === 0) {
      return;
    }
    this.transactionDepth -= 1;
    if (this.transactionDepth > 0) {
      return;
    }
    effects.push({ type: 'cancel_timeout', timeout: 'transaction' });
    if (this.transactionInvalid) {
      this.finishInvalidTransaction(effects);
      return;
    }

    const data = this.transactionBuffer.join('');
    if (this.transactionContainsReplay && this.replayGeometry) {
      const geometry = this.replayGeometry;
      const reason = this.pendingSnapshot?.reason ?? 'size_mismatch';
      effects.push({ type: 'cancel_timeout', timeout: 'snapshot' });

      if (!this.fits(geometry)) {
        this.pendingSnapshot = null;
        this.outputWasDropped = true;
        const next = this.nextSnapshot;
        this.nextSnapshot = null;
        this.clearTransactionFields();
        if (reason === 'resume_remote') {
          this.suspend(effects);
        } else if (next) {
          this.requestSnapshot(next.geometry, next.reason, effects);
        } else if (this.localCapacity) {
          this.requestSnapshot(this.localCapacity, 'size_mismatch', effects);
        }
        return;
      }

      if (reason === 'input_barrier' || reason === 'initial' || reason === 'size_mismatch') {
        effects.push({ type: 'override_dimensions', dimensions: undefined });
        this.renderState = 'ready_local';
        this.remoteGeometry = null;
      } else {
        effects.push({ type: 'override_dimensions', dimensions: geometry });
        this.renderState = 'ready_remote';
      }
      effects.push({ type: 'commit_replay', data });
      this.renderGeometry = geometry;
      this.outputWasDropped = false;
      this.needsInputGeometryBarrier = false;
      this.pendingSnapshot = null;
      this.consecutiveRecoveryFailures = 0;
      effects.push({ type: 'set_status', status: this.renderState === 'ready_local' ? '' : `Following remote terminal ${geometry.cols}x${geometry.rows}` });

      const next = this.nextSnapshot;
      this.nextSnapshot = null;
      if (next && !sameGeometry(next.geometry, geometry)) {
        this.requestSnapshot(next.geometry, next.reason, effects);
      }
    } else if (this.renderState === 'ready_local' || this.renderState === 'ready_remote') {
      effects.push({ type: 'write', data });
    } else {
      this.outputWasDropped = true;
    }
    this.clearTransactionFields();
  }

  private invalidateRenderer(effects: TerminalEffect[], status: string): void {
    this.outputWasDropped = true;
    this.renderState = 'renderer_invalid';
    this.transactionBuffer = [];
    this.transactionBytes = 0;
    effects.push({ type: 'set_status', status });
  }

  private finishInvalidTransaction(effects: TerminalEffect[]): void {
    this.clearTransactionFields();
    this.consecutiveRecoveryFailures += 1;
    if (this.consecutiveRecoveryFailures >= 2) {
      effects.push({ type: 'set_status', status: 'Terminal synchronization repeatedly failed. Reopen the terminal to retry.' });
      return;
    }
    if (this.remoteGeometry && !this.fits(this.remoteGeometry)) {
      this.suspend(effects);
      return;
    }
    const geometry = this.remoteGeometry ?? this.localCapacity;
    if (geometry) {
      this.requestSnapshot(geometry, this.remoteGeometry === geometry ? 'resume_remote' : 'size_mismatch', effects);
    }
  }

  private suspend(effects: TerminalEffect[]): void {
    this.renderState = 'suspended_geometry';
    this.outputWasDropped = true;
    effects.push({ type: 'set_status', status: 'Remote terminal is larger than this panel. Type to switch to the local size.' });
  }

  private fits(geometry: Geometry): boolean {
    return this.localCapacity !== null && geometry.cols <= this.localCapacity.cols && geometry.rows <= this.localCapacity.rows;
  }

  private resetTransaction(effects: TerminalEffect[]): void {
    if (this.transactionDepth > 0) {
      effects.push({ type: 'cancel_timeout', timeout: 'transaction' });
    }
    this.clearTransactionFields();
  }

  private clearTransactionFields(): void {
    this.transactionDepth = 0;
    this.transactionContainsReplay = false;
    this.transactionBuffer = [];
    this.transactionBytes = 0;
    this.transactionInvalid = false;
    this.replayGeometry = null;
  }
}
