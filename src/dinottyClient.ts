import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { ConfigStore, normalizeServerUrl } from './config';
import type { DinottySettings } from './appearance';

const REQUEST_TIMEOUT_MS = 15_000;

export interface CreateTabRequest {
  cwd?: string;
  signal?: AbortSignal;
}

export interface GetSettingsRequest {
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

export class DinottyClient {
  constructor(private readonly configStore: ConfigStore) {}

  async createTab(request: CreateTabRequest): Promise<CreateTabResponse> {
    const { serverUrl, accessToken } = await this.configStore.getConfig();
    const url = buildEndpointUrl(serverUrl, '/api/tabs');
    const body = JSON.stringify(request.cwd ? { cwd: request.cwd } : {});

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString()
    };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    return this.request<CreateTabResponse>({
      url,
      method: 'POST',
      headers,
      body,
      signal: request.signal
    });
  }

  async buildPaneWsConnection(paneId: string): Promise<PaneWsConnection> {
    const { serverUrl, accessToken } = await this.configStore.getConfig();
    const httpUrl = new URL(serverUrl);
    const wsProtocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = buildEndpointUrl(serverUrl, '/ws', wsProtocol);
    wsUrl.searchParams.set('paneId', paneId);

    const headers: Record<string, string> = {};
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const redactedUrl = wsUrl.toString();
    return {
      url: redactedUrl,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      redactedUrl
    };
  }

  async testConnection(): Promise<void> {
    const { serverUrl, accessToken } = await this.configStore.getConfig();
    const url = buildEndpointUrl(serverUrl, '/api/tabs');

    const headers: Record<string, string> = {};
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    try {
      await this.request<unknown[]>({ url, method: 'GET', headers });
      vscode.window.showInformationMessage('Dinotty connection succeeded.');
    } catch (error) {
      vscode.window.showErrorMessage(`Dinotty connection failed: ${formatError(error)}`);
      throw error;
    }
  }

  async getSettings(request: GetSettingsRequest = {}): Promise<DinottySettings> {
    const { serverUrl, accessToken } = await this.configStore.getConfig();
    const url = buildEndpointUrl(serverUrl, '/api/settings');

    const headers: Record<string, string> = {};
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    return this.request<DinottySettings>({ url, method: 'GET', headers, signal: request.signal });
  }

  private request<T>(options: {
    url: URL;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value: T): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const rejectOnce = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      const lib = options.url.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: options.url.hostname,
          port: options.url.port || (options.url.protocol === 'https:' ? '443' : '80'),
          path: `${options.url.pathname}${options.url.search}`,
          method: options.method,
          headers: options.headers
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              try {
                resolveOnce(data ? JSON.parse(data) : ({} as T));
              } catch (error) {
                rejectOnce(new Error(`Invalid JSON response: ${formatError(error)}`));
              }
            } else if (status === 401 || status === 403) {
              rejectOnce(new AuthenticationError(`Authentication failed (${status}). Check your access token.`));
            } else {
              rejectOnce(new HttpError(status, data || `HTTP ${status}`));
            }
          });
        }
      );

      req.on('error', (error) => {
        rejectOnce(new ConnectionError(`Cannot connect to Dinotty server: ${formatError(error)}`));
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy();
        rejectOnce(new ConnectionError(`Request timed out after ${REQUEST_TIMEOUT_MS}ms.`));
      });

      if (options.signal) {
        if (options.signal.aborted) {
          req.destroy();
          rejectOnce(new Error('Request aborted'));
          return;
        }
        options.signal.addEventListener('abort', () => {
          req.destroy();
          rejectOnce(new Error('Request aborted'));
        });
      }

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}

function buildEndpointUrl(serverUrl: string, endpointPath: string, protocol?: string): URL {
  const base = new URL(serverUrl);
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  return new URL(`${basePath}${endpointPath}`, `${protocol ?? base.protocol}//${base.host}`);
}

export class AuthenticationError extends Error {}
export class ConnectionError extends Error {}
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export { normalizeServerUrl };
