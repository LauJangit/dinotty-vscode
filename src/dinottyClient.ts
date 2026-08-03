import * as http from 'http';
import * as https from 'https';
import type { ResolvedDinottyConnection } from './connectionProfile';
import type { DinottySettings } from './appearance';

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface CreateTabRequest {
  cwd?: string;
  signal?: AbortSignal;
}

export interface GetSettingsRequest {
  signal?: AbortSignal;
}

export interface TestConnectionRequest {
  signal?: AbortSignal;
}

export interface CreateTabResponse {
  tab_id: string;
  pane_id: string;
  layout?: unknown;
  cwd?: string;
}

export interface PaneWsConnection {
  url: string;
  headers?: Record<string, string>;
  redactedUrl: string;
}

export interface DinottyClientOptions {
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

type ConnectionFailureReason = 'aborted' | 'timeout' | 'transport';

interface RequestOptions {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export class DinottyClient {
  private readonly connection: Readonly<ResolvedDinottyConnection>;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(connection: ResolvedDinottyConnection, options: DinottyClientOptions = {}) {
    validateConnectionUrl(connection.serverUrl);
    if (connection.accessToken !== undefined && connection.accessToken.length === 0) {
      throw new ConnectionConfigurationError();
    }

    // Copy primitive profile fields so later edits cannot retarget an existing client.
    this.connection = Object.freeze({ ...connection });
    this.requestTimeoutMs = positiveIntegerOrDefault(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxResponseBytes = positiveIntegerOrDefault(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  }

  async createTab(request: CreateTabRequest): Promise<CreateTabResponse> {
    const url = this.endpoint('/api/tabs');
    const body = JSON.stringify(request.cwd ? { cwd: request.cwd } : {});
    const headers = this.authorizationHeaders();
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body).toString();

    const response = await this.request<unknown>({
      url,
      method: 'POST',
      headers,
      body,
      signal: request.signal
    });
    if (
      !isRecord(response) ||
      !isNonBlankString(response.tab_id) ||
      !isNonBlankString(response.pane_id)
    ) {
      throw new InvalidResponseError();
    }
    return { tab_id: response.tab_id, pane_id: response.pane_id };
  }

  async buildPaneWsConnection(paneId: string): Promise<PaneWsConnection> {
    const httpUrl = new URL(this.connection.serverUrl);
    const wsProtocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = this.endpoint('/ws', wsProtocol);
    wsUrl.searchParams.set('paneId', paneId);

    const headers = this.authorizationHeaders();
    const redactedUrl = wsUrl.toString();
    return {
      url: redactedUrl,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      redactedUrl
    };
  }

  async testConnection(request: TestConnectionRequest = {}): Promise<void> {
    const url = this.endpoint('/api/tabs');
    await this.request<unknown>({
      url,
      method: 'GET',
      headers: this.authorizationHeaders(),
      signal: request.signal
    });
  }

  async getSettings(request: GetSettingsRequest = {}): Promise<DinottySettings> {
    const url = this.endpoint('/api/settings');
    const response = await this.request<unknown>({
      url,
      method: 'GET',
      headers: this.authorizationHeaders(),
      signal: request.signal
    });
    if (!isRecord(response)) {
      throw new InvalidResponseError();
    }
    return response;
  }

  private endpoint(path: string, protocol?: 'ws:' | 'wss:'): URL {
    try {
      return buildEndpointUrl(this.connection.serverUrl, path, protocol);
    } catch {
      throw new ConnectionConfigurationError();
    }
  }

  private authorizationHeaders(): Record<string, string> {
    const token = this.connection.accessToken;
    if (token === undefined) {
      return {};
    }

    const value = `Bearer ${token}`;
    try {
      http.validateHeaderValue('Authorization', value);
    } catch {
      throw new ConnectionConfigurationError();
    }
    return { Authorization: value };
  }

  private request<T>(options: RequestOptions): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new ConnectionError('aborted'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let req: http.ClientRequest | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        rejectOnce(new ConnectionError('aborted'));
        req?.destroy();
      };
      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', onAbort);
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      };
      const resolveOnce = (value: T): void => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(value);
        }
      };
      const rejectOnce = (error: DinottyClientError): void => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };

      const lib = options.url.protocol === 'https:' ? https : http;
      try {
        req = lib.request(options.url, {
          method: options.method,
          headers: options.headers
        }, (response) => {
          this.handleResponse(response, resolveOnce, rejectOnce);
        });
      } catch {
        rejectOnce(new ConnectionConfigurationError());
        return;
      }

      req.on('error', () => rejectOnce(new ConnectionError('transport')));
      req.on('upgrade', (_response, socket) => {
        rejectOnce(new HttpError(101));
        socket.destroy();
      });
      req.on('close', () => {
        if (!settled) {
          rejectOnce(new ConnectionError('transport'));
        }
      });
      timeoutHandle = setTimeout(() => {
        rejectOnce(new ConnectionError('timeout', this.requestTimeoutMs));
        req?.destroy();
      }, this.requestTimeoutMs);

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        if (options.signal.aborted) {
          onAbort();
          return;
        }
      }

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  private handleResponse<T>(
    response: http.IncomingMessage,
    resolve: (value: T) => void,
    reject: (error: DinottyClientError) => void
  ): void {
    const status = response.statusCode ?? 0;
    if (status === 401 || status === 403) {
      reject(new AuthenticationError(status));
      response.destroy();
      return;
    }
    if (status < 200 || status >= 300) {
      reject(new HttpError(status));
      response.destroy();
      return;
    }

    const contentLength = parseContentLength(response.headers['content-length']);
    if (contentLength !== undefined && contentLength > this.maxResponseBytes) {
      reject(new ResponseTooLargeError(this.maxResponseBytes));
      response.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let responseFailed = false;
    response.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > this.maxResponseBytes) {
        responseFailed = true;
        reject(new ResponseTooLargeError(this.maxResponseBytes));
        response.destroy();
        return;
      }
      chunks.push(buffer);
    });
    response.on('aborted', () => {
      responseFailed = true;
      reject(new ConnectionError('transport'));
    });
    response.on('error', () => {
      responseFailed = true;
      reject(new ConnectionError('transport'));
    });
    response.on('close', () => {
      if (!response.complete) {
        responseFailed = true;
        reject(new ConnectionError('transport'));
      }
    });
    response.on('end', () => {
      if (responseFailed) {
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (body.length === 0) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new InvalidResponseError());
      }
    });
  }
}

export function buildEndpointUrl(serverUrl: string, endpointPath: string, protocol?: 'ws:' | 'wss:'): URL {
  if (!endpointPath.startsWith('/')) {
    throw new Error('Endpoint path must be absolute.');
  }

  const url = new URL(serverUrl);
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}${endpointPath}`;
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  if (protocol) {
    url.protocol = protocol;
  }
  return url;
}

export abstract class DinottyClientError extends Error {
  protected constructor(message: string, public readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthenticationError extends DinottyClientError {
  constructor(public readonly statusCode: 401 | 403) {
    super(`Authentication failed (${statusCode}). Check the access code for this connection.`, 'authentication');
  }
}

export class ConnectionError extends DinottyClientError {
  constructor(public readonly reason: ConnectionFailureReason, timeoutMs?: number) {
    const message = reason === 'timeout'
      ? `The Dinotty request timed out after ${timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms.`
      : reason === 'aborted'
        ? 'The Dinotty request was cancelled.'
        : 'Could not connect to the Dinotty server.';
    super(message, `connection_${reason}`);
  }
}

export class HttpError extends DinottyClientError {
  constructor(public readonly statusCode: number) {
    super(`The Dinotty server returned HTTP ${statusCode}.`, 'http');
  }
}

export class InvalidResponseError extends DinottyClientError {
  constructor() {
    super('The Dinotty server returned an invalid response.', 'invalid_response');
  }
}

export class ResponseTooLargeError extends DinottyClientError {
  constructor(public readonly maxBytes: number) {
    super(`The Dinotty response exceeded the ${maxBytes}-byte safety limit.`, 'response_too_large');
  }
}

export class ConnectionConfigurationError extends DinottyClientError {
  constructor() {
    super('The selected Dinotty connection is not valid.', 'invalid_connection');
  }
}

export function formatError(error: unknown): string {
  return error instanceof DinottyClientError ? error.message : 'An unexpected Dinotty error occurred.';
}

function validateConnectionUrl(serverUrl: string): void {
  try {
    const url = new URL(serverUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid connection URL.');
    }
  } catch {
    throw new ConnectionConfigurationError();
  }
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConnectionConfigurationError();
  }
  return value;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
