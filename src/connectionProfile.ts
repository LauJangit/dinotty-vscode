import { validateHeaderValue } from 'node:http';

const MAX_SERVER_URL_LENGTH = 2048;
const MAX_CONNECTION_NAME_CODE_POINTS = 80;
const MAX_ACCESS_TOKEN_BYTES = 4096;
const FORBIDDEN_UNICODE_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ASCII_WHITESPACE_OR_DEL_PATTERN = /[\x09-\x0d\x20\x7f]/;
const CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface DinottyConnectionProfile {
  readonly id: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ResolvedDinottyConnection extends DinottyConnectionProfile {
  readonly accessToken?: string;
}

export type CredentialChange =
  | { readonly kind: 'keep' }
  | { readonly kind: 'replace'; readonly accessToken: string }
  | { readonly kind: 'clear' };

export interface StoredConnectionProfile extends DinottyConnectionProfile {
  readonly credentialSlot?: string;
}

export interface ConnectionStoreEnvelopeV1 {
  readonly version: 1;
  readonly revision: number;
  readonly profiles: readonly StoredConnectionProfile[];
  readonly defaultId?: string;
}

export interface AddConnectionInput {
  readonly name: string;
  readonly serverUrl: string;
  readonly accessToken?: string;
}

export interface UpdateConnectionInput {
  readonly name: string;
  readonly serverUrl: string;
  readonly credential: CredentialChange;
}

export type ConnectionProfileValidationCode =
  | 'server_url_required'
  | 'server_url_too_long'
  | 'server_url_invalid'
  | 'server_url_unsupported_protocol'
  | 'server_url_forbidden_characters'
  | 'server_url_userinfo_not_allowed'
  | 'server_url_query_or_fragment_not_allowed'
  | 'connection_name_required'
  | 'connection_name_too_long'
  | 'connection_name_forbidden_characters'
  | 'access_token_required'
  | 'access_token_too_long'
  | 'access_token_forbidden_characters'
  | 'access_token_invalid_header_value'
  | 'access_token_requires_secure_transport'
  | 'connection_store_invalid';

export class ConnectionProfileValidationError extends Error {
  constructor(
    readonly code: ConnectionProfileValidationCode,
    message: string
  ) {
    super(message);
    this.name = 'ConnectionProfileValidationError';
  }
}

export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw validationError('server_url_required', 'Server URL is required.');
  }
  if (trimmed.length > MAX_SERVER_URL_LENGTH) {
    throw validationError('server_url_too_long', 'Server URL is too long.');
  }
  if (FORBIDDEN_UNICODE_PATTERN.test(trimmed)) {
    throw validationError('server_url_forbidden_characters', 'Server URL contains unsupported characters.');
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw validationError(
      'server_url_query_or_fragment_not_allowed',
      'Server URL must not include a query string or fragment.'
    );
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    throw validationError('server_url_invalid', 'Server URL must be an absolute HTTP(S) URL.');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw validationError('server_url_invalid', 'Server URL must be an absolute HTTP(S) URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw validationError('server_url_unsupported_protocol', 'Server URL must use HTTP or HTTPS.');
  }
  if (url.hostname.length === 0) {
    throw validationError('server_url_invalid', 'Server URL must include a hostname.');
  }

  const authorityStart = trimmed.indexOf('://') + 3;
  const authorityEndOffset = trimmed.slice(authorityStart).search(/[\/\\]/);
  const authorityEnd = authorityEndOffset === -1 ? trimmed.length : authorityStart + authorityEndOffset;
  if (url.username.length > 0 || url.password.length > 0 || trimmed.slice(authorityStart, authorityEnd).includes('@')) {
    throw validationError('server_url_userinfo_not_allowed', 'Server URL must not include user information.');
  }

  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  const normalized = url.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function normalizeConnectionName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw validationError('connection_name_required', 'Connection name is required.');
  }
  if (Array.from(trimmed).length > MAX_CONNECTION_NAME_CODE_POINTS) {
    throw validationError('connection_name_too_long', 'Connection name is too long.');
  }
  if (FORBIDDEN_UNICODE_PATTERN.test(trimmed)) {
    throw validationError(
      'connection_name_forbidden_characters',
      'Connection name contains unsupported characters.'
    );
  }
  return trimmed;
}

export function connectionNameKey(name: string): string {
  return normalizeConnectionName(name).normalize('NFKC').toLowerCase();
}

export function normalizeAccessToken(value: string, allowEmpty = true): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (allowEmpty) {
      return undefined;
    }
    throw validationError('access_token_required', 'Access token is required.');
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_ACCESS_TOKEN_BYTES) {
    throw validationError('access_token_too_long', 'Access token is too long.');
  }
  if (ASCII_WHITESPACE_OR_DEL_PATTERN.test(trimmed) || FORBIDDEN_UNICODE_PATTERN.test(trimmed)) {
    throw validationError('access_token_forbidden_characters', 'Access token contains unsupported characters.');
  }

  try {
    validateHeaderValue('Authorization', `Bearer ${trimmed}`);
  } catch {
    throw validationError('access_token_invalid_header_value', 'Access token is not a valid HTTP header value.');
  }
  return trimmed;
}

export function validateConnectionSecurity(serverUrl: string, accessToken?: string): void {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const normalizedToken = accessToken === undefined ? undefined : normalizeAccessToken(accessToken);
  if (normalizedToken && new URL(normalizedUrl).protocol === 'http:' && !isLoopbackHostname(new URL(normalizedUrl).hostname)) {
    throw validationError(
      'access_token_requires_secure_transport',
      'Access tokens require HTTPS unless the server is on the local loopback interface.'
    );
  }
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_V4_PATTERN.test(value);
}

export function validateConnectionStoreEnvelope(value: unknown): ConnectionStoreEnvelopeV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'revision', 'profiles'], ['defaultId'])) {
    throw invalidStoreError();
  }
  if (value.version !== 1 || !isNonNegativeSafeInteger(value.revision) || !Array.isArray(value.profiles)) {
    throw invalidStoreError();
  }

  const ids = new Set<string>();
  const nameKeys = new Set<string>();
  const credentialSlots = new Set<string>();
  const profiles = value.profiles.map((profile) => {
    const parsed = validateStoredConnectionProfile(profile);
    if (ids.has(parsed.id)) {
      throw invalidStoreError();
    }
    ids.add(parsed.id);

    let nameKey: string;
    try {
      nameKey = connectionNameKey(parsed.name);
    } catch {
      throw invalidStoreError();
    }
    if (nameKeys.has(nameKey)) {
      throw invalidStoreError();
    }
    nameKeys.add(nameKey);

    if (parsed.credentialSlot) {
      if (credentialSlots.has(parsed.credentialSlot)) {
        throw invalidStoreError();
      }
      credentialSlots.add(parsed.credentialSlot);
      if (new URL(parsed.serverUrl).protocol === 'http:' && !isLoopbackHostname(new URL(parsed.serverUrl).hostname)) {
        throw invalidStoreError();
      }
    }
    return parsed;
  });

  let defaultId: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'defaultId')) {
    if (!isCanonicalUuid(value.defaultId) || !ids.has(value.defaultId)) {
      throw invalidStoreError();
    }
    defaultId = value.defaultId;
  }

  const frozenProfiles = Object.freeze(profiles);
  return Object.freeze({
    version: 1,
    revision: value.revision,
    profiles: frozenProfiles,
    ...(defaultId === undefined ? {} : { defaultId })
  });
}

function validateStoredConnectionProfile(value: unknown): StoredConnectionProfile {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'name', 'serverUrl', 'createdAt', 'updatedAt'], ['credentialSlot']) ||
    !isCanonicalUuid(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.serverUrl !== 'string' ||
    !isNonNegativeSafeInteger(value.createdAt) ||
    !isNonNegativeSafeInteger(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw invalidStoreError();
  }

  let normalizedName: string;
  let normalizedUrl: string;
  try {
    normalizedName = normalizeConnectionName(value.name);
    normalizedUrl = normalizeServerUrl(value.serverUrl);
  } catch {
    throw invalidStoreError();
  }
  if (normalizedName !== value.name || normalizedUrl !== value.serverUrl) {
    throw invalidStoreError();
  }

  let credentialSlot: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'credentialSlot')) {
    if (!isCanonicalUuid(value.credentialSlot)) {
      throw invalidStoreError();
    }
    credentialSlot = value.credentialSlot;
  }

  return Object.freeze({
    id: value.id,
    name: normalizedName,
    serverUrl: normalizedUrl,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(credentialSlot === undefined ? {} : { credentialSlot })
  });
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') {
    return true;
  }
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[]
): boolean {
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => allowedKeys.has(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validationError(code: ConnectionProfileValidationCode, message: string): ConnectionProfileValidationError {
  return new ConnectionProfileValidationError(code, message);
}

function invalidStoreError(): ConnectionProfileValidationError {
  return validationError('connection_store_invalid', 'Connection store data is invalid.');
}
