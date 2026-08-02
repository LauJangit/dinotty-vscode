export interface Geometry {
  cols: number;
  rows: number;
}

export type ClientToServerMessage =
  | { type: 'input'; data: string }
  | ({ type: 'resize' } & Geometry)
  | ({ type: 'snapshot_request' } & Geometry);

export type ServerToClientMessage =
  | { type: 'output'; data: string }
  | ({ type: 'resize' } & Geometry)
  | { type: 'shell_info'; shell_type: string }
  | ({ type: 'reconnected' } & Geometry)
  | { type: 'sync_begin' }
  | { type: 'sync_end' }
  | ({ type: 'replay_begin' } & Geometry)
  | { type: 'replay_end' }
  | { type: 'session_exit'; pane_id?: string };

const MIN_DIMENSION = 2;
const MAX_DIMENSION = 1000;

export function encodeClientMessage(message: ClientToServerMessage): string {
  return JSON.stringify(message);
}

export function parseServerMessage(raw: string): ServerToClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return undefined;
  }

  switch (parsed.type) {
    case 'session_exit':
      return { type: 'session_exit', pane_id: asString(parsed.pane_id) };
    case 'output': {
      if (typeof parsed.data !== 'string') {
        return undefined;
      }
      return parseSessionExitSentinel(parsed.data) ?? { type: 'output', data: parsed.data };
    }
    case 'resize':
    case 'reconnected':
    case 'replay_begin': {
      const geometry = parseGeometry(parsed);
      return geometry ? { type: parsed.type, ...geometry } : undefined;
    }
    case 'shell_info':
      return { type: 'shell_info', shell_type: asString(parsed.shell_type) ?? '' };
    case 'sync_begin':
    case 'sync_end':
    case 'replay_end':
      return { type: parsed.type };
    default:
      return undefined;
  }
}

export function describeServerMessageType(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.type === 'string' ? parsed.type : 'invalid';
  } catch {
    return 'invalid';
  }
}

export function isValidGeometry(geometry: Geometry): boolean {
  return isValidDimension(geometry.cols) && isValidDimension(geometry.rows);
}

export function sameGeometry(left: Geometry | null, right: Geometry | null): boolean {
  return left !== null && right !== null && left.cols === right.cols && left.rows === right.rows;
}

function parseGeometry(value: Record<string, unknown>): Geometry | undefined {
  if (!isValidDimension(value.cols) || !isValidDimension(value.rows)) {
    return undefined;
  }
  return { cols: value.cols, rows: value.rows };
}

function isValidDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION;
}

function parseSessionExitSentinel(data: string): { type: 'session_exit'; pane_id?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== 'session_exit') {
    return undefined;
  }
  return { type: 'session_exit', pane_id: asString(parsed.pane_id) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
