import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConnectionProfileValidationError,
  connectionNameKey,
  isCanonicalUuid,
  isRemotePlainHttp,
  normalizeAccessToken,
  normalizeConnectionName,
  normalizeServerUrl,
  validateConnectionSecurity,
  validateConnectionStoreEnvelope
} from '../src/connectionProfile';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const SLOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('normalizes absolute HTTP(S) URLs and preserves a non-root base path', () => {
  assert.equal(normalizeServerUrl(' HTTPS://Example.COM:443/proxy/dinotty/// '), 'https://example.com/proxy/dinotty');
  assert.equal(normalizeServerUrl('http://127.1:80/'), 'http://127.0.0.1');
  assert.equal(normalizeServerUrl('https://[::1]:443/base/'), 'https://[::1]/base');
});

test('rejects unsafe or ambiguous server URLs', () => {
  for (const value of [
    '',
    'example.com',
    'http:example.com',
    'ftp://example.com',
    'http://',
    'http://user@example.com',
    'http://:password@example.com',
    'http://@example.com',
    'http://example.com?',
    'http://example.com#',
    'http://example.com/path?query=1',
    'http://example.com/path#fragment',
    'http://example.com/line\nbreak',
    'http://example.com/hidden\u200bvalue',
    'http://example.com/line\u2028break'
  ]) {
    assert.throws(() => normalizeServerUrl(value), ConnectionProfileValidationError);
  }

  const oversized = `http://example.com/${'a'.repeat(2049)}`;
  assert.throws(() => normalizeServerUrl(oversized), (error: unknown) => hasCode(error, 'server_url_too_long'));
});

test('normalizes names, counts Unicode code points, and builds a compatibility key', () => {
  assert.equal(normalizeConnectionName('  Home Server  '), 'Home Server');
  assert.equal(normalizeConnectionName('🦖'.repeat(80)), '🦖'.repeat(80));
  assert.equal(connectionNameKey(' ＤＩＮＯＴＴＹ '), 'dinotty');
  assert.equal(connectionNameKey('Home'), connectionNameKey('home'));

  assert.throws(() => normalizeConnectionName(''), (error: unknown) => hasCode(error, 'connection_name_required'));
  assert.throws(() => normalizeConnectionName('🦖'.repeat(81)), (error: unknown) => hasCode(error, 'connection_name_too_long'));
  for (const value of ['line\nbreak', 'hidden\u200bname', 'line\u2028break', 'paragraph\u2029break']) {
    assert.throws(() => normalizeConnectionName(value), ConnectionProfileValidationError);
  }
});

test('normalizes optional tokens and enforces replacement, byte, character, and header limits', () => {
  assert.equal(normalizeAccessToken('  token-value  '), 'token-value');
  assert.equal(normalizeAccessToken('   '), undefined);
  assert.throws(() => normalizeAccessToken('   ', false), (error: unknown) => hasCode(error, 'access_token_required'));

  const exactUtf8Boundary = 'é'.repeat(2048);
  assert.equal(Buffer.byteLength(exactUtf8Boundary, 'utf8'), 4096);
  assert.equal(normalizeAccessToken(exactUtf8Boundary), exactUtf8Boundary);
  assert.throws(() => normalizeAccessToken(`${exactUtf8Boundary}a`), (error: unknown) => hasCode(error, 'access_token_too_long'));

  for (const value of ['two words', 'tab\tvalue', 'line\nvalue', 'delete\x7fvalue', 'hidden\u200bvalue']) {
    assert.throws(() => normalizeAccessToken(value), ConnectionProfileValidationError);
  }
  assert.throws(() => normalizeAccessToken('令牌'), (error: unknown) => {
    return hasCode(error, 'access_token_invalid_header_value') && !error.message.includes('令牌');
  });
});

test('allows access tokens over HTTP and HTTPS while preserving token validation', () => {
  for (const url of [
    'http://localhost:8999',
    'http://127.0.0.1',
    'http://127.255.255.255',
    'http://[::1]',
    'http://192.168.1.10:8999',
    'http://example.com',
    'https://example.com'
  ]) {
    assert.doesNotThrow(() => validateConnectionSecurity(url, 'token'));
  }
  assert.doesNotThrow(() => validateConnectionSecurity('http://example.com'));
  assert.throws(
    () => validateConnectionSecurity('http://example.com', 'invalid token'),
    ConnectionProfileValidationError
  );
});

test('identifies non-loopback plain HTTP connections for transport warnings', () => {
  for (const url of ['https://example.com', 'http://localhost:8999', 'http://127.0.0.1', 'http://127.255.255.255', 'http://[::1]']) {
    assert.equal(isRemotePlainHttp(url), false);
  }
  for (const url of ['http://192.168.1.10:8999', 'http://example.com', 'http://localhost.', 'http://128.0.0.1']) {
    assert.equal(isRemotePlainHttp(url), true);
  }
});

test('recognizes only canonical lowercase random UUID values', () => {
  assert.equal(isCanonicalUuid(PROFILE_ID), true);
  assert.equal(isCanonicalUuid(SLOT_ID.toUpperCase()), false);
  assert.equal(isCanonicalUuid('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(isCanonicalUuid('not-a-uuid'), false);
  assert.equal(isCanonicalUuid(undefined), false);
});

test('validates, copies, and freezes a complete connection store envelope', () => {
  const input = {
    version: 1,
    revision: 7,
    profiles: [
      {
        id: PROFILE_ID,
        name: 'Local',
        serverUrl: 'http://192.168.1.10:8999',
        createdAt: 1,
        updatedAt: 2,
        credentialSlot: SLOT_ID
      },
      {
        id: SECOND_PROFILE_ID,
        name: 'Remote',
        serverUrl: 'https://example.com/base',
        createdAt: 3,
        updatedAt: 3
      }
    ],
    defaultId: PROFILE_ID
  };

  const envelope = validateConnectionStoreEnvelope(input);
  assert.deepEqual(envelope, input);
  assert.notEqual(envelope, input);
  assert.notEqual(envelope.profiles, input.profiles);
  assert.notEqual(envelope.profiles[0], input.profiles[0]);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.profiles), true);
  assert.equal(Object.isFrozen(envelope.profiles[0]), true);

  input.profiles[0].name = 'Changed';
  assert.equal(envelope.profiles[0].name, 'Local');
});

test('rejects malformed store envelopes and cross-profile invariant violations', () => {
  const validProfile = {
    id: PROFILE_ID,
    name: 'Local',
    serverUrl: 'http://127.0.0.1:8999',
    createdAt: 1,
    updatedAt: 1,
    credentialSlot: SLOT_ID
  };
  const validEnvelope = { version: 1, revision: 0, profiles: [validProfile], defaultId: PROFILE_ID };

  const invalidValues: unknown[] = [
    null,
    {},
    { ...validEnvelope, version: 2 },
    { ...validEnvelope, revision: -1 },
    { ...validEnvelope, revision: 1.5 },
    { ...validEnvelope, defaultId: SECOND_PROFILE_ID },
    { ...validEnvelope, token: 'must-not-be-persisted' },
    { ...validEnvelope, profiles: [{ ...validProfile, name: ' Local ' }] },
    { ...validEnvelope, profiles: [{ ...validProfile, serverUrl: 'HTTP://127.0.0.1:8999/' }] },
    { ...validEnvelope, profiles: [{ ...validProfile, updatedAt: 0 }] },
    { ...validEnvelope, profiles: [validProfile, { ...validProfile }] },
    {
      ...validEnvelope,
      profiles: [validProfile, { ...validProfile, id: SECOND_PROFILE_ID, name: 'ＬＯＣＡＬ', credentialSlot: undefined }]
    },
    {
      ...validEnvelope,
      profiles: [validProfile, { ...validProfile, id: SECOND_PROFILE_ID, name: 'Remote' }]
    }
  ];

  for (const value of invalidValues) {
    assert.throws(() => validateConnectionStoreEnvelope(value), (error: unknown) => {
      return hasCode(error, 'connection_store_invalid') && error.message === 'Connection store data is invalid.';
    });
  }
});

function hasCode(error: unknown, code: ConnectionProfileValidationError['code']): error is ConnectionProfileValidationError {
  return error instanceof ConnectionProfileValidationError && error.code === code;
}
