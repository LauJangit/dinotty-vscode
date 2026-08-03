import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';
import {
  AuthenticationError,
  ConnectionError,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DinottyClient,
  HttpError,
  InvalidResponseError,
  ResponseTooLargeError,
  formatError
} from '../src/dinottyClient';

interface MutableResolvedConnection {
  id: string;
  name: string;
  serverUrl: string;
  createdAt: number;
  updatedAt: number;
  accessToken?: string;
}

interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

function connection(serverUrl: string, accessToken?: string): MutableResolvedConnection {
  return {
    id: `profile-${Math.random()}`,
    name: 'Test connection',
    serverUrl,
    createdAt: 1,
    updatedAt: 1,
    accessToken
  };
}

async function startServer(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

test('preserves the base path and testConnection never creates a tab', async (t) => {
  const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = [];
  const server = await startServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8')
      });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') {
        response.end(JSON.stringify({ tab_id: 'tab-1', pane_id: 'pane-1' }));
      } else if (request.url?.endsWith('/api/settings')) {
        response.end(JSON.stringify({ theme: { preset: 'dark' } }));
      } else {
        response.end('[]');
      }
    });
  });
  t.after(() => server.close());

  const client = new DinottyClient(connection(`${server.url}/proxy/dinotty/`, 'token-a'));
  await client.testConnection();
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: '/proxy/dinotty/api/tabs' }
  ]);

  const tab = await client.createTab({ cwd: '/workspace' });
  assert.equal(tab.pane_id, 'pane-1');
  const settings = await client.getSettings();
  assert.equal(settings.theme?.preset, 'dark');
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: '/proxy/dinotty/api/tabs' },
    { method: 'POST', url: '/proxy/dinotty/api/tabs' },
    { method: 'GET', url: '/proxy/dinotty/api/settings' }
  ]);
  assert.equal(requests[1].body, '{"cwd":"/workspace"}');
  assert.ok(requests.every((request) => request.authorization === 'Bearer token-a'));

  const ws = await client.buildPaneWsConnection('pane /?#');
  const wsUrl = new URL(ws.url);
  assert.equal(wsUrl.protocol, 'ws:');
  assert.equal(wsUrl.pathname, '/proxy/dinotty/ws');
  assert.equal(wsUrl.searchParams.get('paneId'), 'pane /?#');
  assert.deepEqual(ws.headers, { Authorization: 'Bearer token-a' });
  assert.equal(ws.redactedUrl, ws.url);
});

test('each client keeps an immutable server and Bearer snapshot', async (t) => {
  const authorizationsA: Array<string | undefined> = [];
  const authorizationsB: Array<string | undefined> = [];
  const serverA = await startServer((request, response) => {
    authorizationsA.push(request.headers.authorization);
    response.end('[]');
  });
  const serverB = await startServer((request, response) => {
    authorizationsB.push(request.headers.authorization);
    response.end('[]');
  });
  t.after(async () => {
    await Promise.all([serverA.close(), serverB.close()]);
  });

  const profileA = connection(serverA.url, 'secret-a');
  const profileB = connection(serverB.url, 'secret-b');
  const clientA = new DinottyClient(profileA);
  const clientB = new DinottyClient(profileB);

  profileA.serverUrl = serverB.url;
  profileA.accessToken = 'mutated-a';
  profileB.serverUrl = serverA.url;
  profileB.accessToken = 'mutated-b';

  await Promise.all([clientA.testConnection(), clientB.testConnection()]);
  assert.deepEqual(authorizationsA, ['Bearer secret-a']);
  assert.deepEqual(authorizationsB, ['Bearer secret-b']);
});

test('rejects successful responses that do not match endpoint contracts', async (t) => {
  const createTabResponses = [
    { status: 204, body: '' },
    { status: 200, body: 'null' },
    { status: 200, body: '{}' },
    { status: 200, body: '{"tab_id":1,"pane_id":"pane-1"}' },
    { status: 200, body: '{"tab_id":"tab-1","pane_id":false}' },
    { status: 200, body: '{"tab_id":"   ","pane_id":"pane-1"}' },
    { status: 200, body: '{"tab_id":"tab-1","pane_id":"\\t"}' }
  ];
  const settingsResponses = ['null', '[]'];
  const server = await startServer((request, response) => {
    if (request.url?.endsWith('/api/settings')) {
      response.end(settingsResponses.shift());
      return;
    }
    const next = createTabResponses.shift();
    assert.ok(next);
    response.statusCode = next.status;
    response.end(next.body);
  });
  t.after(() => server.close());

  const client = new DinottyClient(connection(server.url));
  for (let index = 0; index < 7; index += 1) {
    await assert.rejects(client.createTab({}), InvalidResponseError);
  }
  await assert.rejects(client.getSettings(), InvalidResponseError);
  await assert.rejects(client.getSettings(), InvalidResponseError);
});

test('classifies and redacts authentication, HTTP, oversized, and invalid responses', async (t) => {
  const leakedValue = 'server-echoed-secret';
  let settingsMode: 'large' | 'invalid' = 'large';
  const server = await startServer((request, response) => {
    if (request.url?.endsWith('/api/settings')) {
      if (settingsMode === 'large') {
        response.end(JSON.stringify({ value: leakedValue.repeat(20) }));
      } else {
        response.end(`{"value":"${leakedValue}`);
      }
      return;
    }
    if (request.method === 'POST') {
      response.statusCode = 503;
      response.end(leakedValue);
      return;
    }
    response.statusCode = 401;
    response.end(leakedValue);
  });
  t.after(() => server.close());

  const client = new DinottyClient(connection(server.url, 'request-secret'), { maxResponseBytes: 64 });
  await assert.rejects(client.testConnection(), (error: unknown) => {
    assert.ok(error instanceof AuthenticationError);
    assert.equal(error.statusCode, 401);
    assert.equal(formatError(error).includes(leakedValue), false);
    assert.equal(formatError(error).includes('request-secret'), false);
    return true;
  });
  await assert.rejects(client.createTab({}), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 503);
    assert.equal(formatError(error).includes(leakedValue), false);
    return true;
  });
  await assert.rejects(client.getSettings(), (error: unknown) => {
    assert.ok(error instanceof ResponseTooLargeError);
    assert.equal(error.maxBytes, 64);
    assert.equal(formatError(error).includes(leakedValue), false);
    return true;
  });

  settingsMode = 'invalid';
  const invalidClient = new DinottyClient(connection(server.url), { maxResponseBytes: 1024 });
  await assert.rejects(invalidClient.getSettings(), InvalidResponseError);
});

test('uses the 15 second default timeout and classifies timeouts without endpoint details', async (t) => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 15_000);
  assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 1024 * 1024);

  const server = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const interval = setInterval(() => response.write(' '), 5);
    response.on('close', () => clearInterval(interval));
  });
  t.after(() => server.close());
  const client = new DinottyClient(connection(server.url, 'timeout-secret'), { requestTimeoutMs: 25 });

  await assert.rejects(client.testConnection(), (error: unknown) => {
    assert.ok(error instanceof ConnectionError);
    assert.equal(error.reason, 'timeout');
    assert.equal(formatError(error).includes('timeout-secret'), false);
    assert.equal(formatError(error).includes(server.url), false);
    return true;
  });
});

test('rejects protocol upgrades instead of leaving the request pending', async (t) => {
  const server = await startServer((_request, response) => {
    response.writeHead(101, {
      Connection: 'Upgrade',
      Upgrade: 'unexpected'
    });
    response.end();
  });
  t.after(() => server.close());
  const client = new DinottyClient(connection(server.url), { requestTimeoutMs: 100 });

  await assert.rejects(client.testConnection(), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 101);
    return true;
  });
});
