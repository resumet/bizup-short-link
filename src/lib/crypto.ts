// 코드·키·토큰·해시 유틸 (PRD §5.5, §13.8, §14.2, §16.5)
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const SHORT_CODE_RE = /^[0-9A-Za-z]{7}$/;

/** 서비스 경로로 예약된 이름. 코드 라우트보다 우선하며 코드로 발급하지 않는다(대소문자 무시). */
export const RESERVED_PATHS = [
  'links', 'admin', 'api', 'internal', 'auth', 'login', 'logout', '_next', 'healthz',
  'favicon.ico', 'robots.txt', 'static', 'public', 'assets', 'signup', 'account', 'settings', 'docs',
];
const RESERVED_LOWER = new Set(RESERVED_PATHS.map((s) => s.toLowerCase()));

export function isReservedCode(code: string): boolean {
  return RESERVED_LOWER.has(code.toLowerCase());
}

/** 암호학적 난수 기반 Base62 7자 후보 */
export function generateShortCode(): string {
  for (;;) {
    let s = '';
    for (let i = 0; i < 7; i++) s += BASE62[randomInt(62)];
    if (!isReservedCode(s)) return s;
  }
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function constantTimeEqual(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 키 순서를 고정한 JSON 직렬화 (요청 해시용) */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function hashRequest(value: unknown): Buffer {
  return sha256(stableStringify(value));
}

/** 불투명 난수 토큰 */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// API 키 (§13.8): bzup_{env}_<public_id 22자>_<secret 43자>
// ---------------------------------------------------------------------------
export type KeyEnvironment = 'live' | 'test';
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const KEY_PREFIX_LEN = 'bzup_live_'.length; // 10
const PUBLIC_ID_LEN = 22;
const SECRET_LEN = 43;
export const API_KEY_LENGTH = KEY_PREFIX_LEN + PUBLIC_ID_LEN + 1 + SECRET_LEN;

export interface GeneratedApiKey {
  plaintext: string;
  publicId: string;
  keyPrefix: string;
  secretHash: Buffer;
}

export function generateApiKey(env: KeyEnvironment): GeneratedApiKey {
  const publicId = randomBytes(16).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const keyPrefix = `bzup_${env}_${publicId}`;
  const plaintext = `${keyPrefix}_${secret}`;
  return { plaintext, publicId, keyPrefix, secretHash: sha256(plaintext) };
}

export interface ParsedApiKey {
  env: KeyEnvironment;
  publicId: string;
  hash: Buffer;
}

/** 고정 길이·허용 문자로 파싱한다. 밑줄 전체 분할을 하지 않는다. */
export function parseApiKey(raw: string): ParsedApiKey | null {
  if (raw.length !== API_KEY_LENGTH) return null;
  let env: KeyEnvironment;
  if (raw.startsWith('bzup_live_')) env = 'live';
  else if (raw.startsWith('bzup_test_')) env = 'test';
  else return null;
  const publicId = raw.slice(KEY_PREFIX_LEN, KEY_PREFIX_LEN + PUBLIC_ID_LEN);
  const sep = raw[KEY_PREFIX_LEN + PUBLIC_ID_LEN];
  const secret = raw.slice(KEY_PREFIX_LEN + PUBLIC_ID_LEN + 1);
  if (sep !== '_' || !B64URL_RE.test(publicId) || !B64URL_RE.test(secret) || secret.length !== SECRET_LEN) {
    return null;
  }
  return { env, publicId, hash: sha256(raw) };
}

// ---------------------------------------------------------------------------
// Idempotency-Key (§16.5)
// ---------------------------------------------------------------------------
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
