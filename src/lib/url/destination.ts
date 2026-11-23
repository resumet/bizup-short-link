// 목적지 URL 검증·저장값·중복 비교용 canonical (PRD §5.3, §5.4, §6.3)
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { AppError } from '@/lib/errors';
import { charClass } from '@/lib/charclass';

export const MAX_DESTINATION_BYTES = 8192;

export interface ParsedDestination {
  /** 실제 저장·이동 URL. 유효한 ASCII URL은 원문 그대로 유지한다. */
  stored: string;
  /** 중복 비교용 canonical 문자열 */
  canonical: string;
  /** canonical 의 SHA-256 (검색 가속용, 비유일) */
  fingerprint: Buffer;
  /** 소문자·IDNA·마지막 점 정규화 호스트 */
  host: string;
}

const SCHEME_AUTHORITY_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/;
// 제어문자(C0, DEL, C1)·공백류·백슬래시
const FORBIDDEN_CHAR_RE = charClass([[0x00,0x20],[0x7f,0x9f],[0x5c,0x5c],[0xa0,0xa0],[0x1680,0x1680],[0x2000,0x200b],[0x2028,0x2029],[0x202f,0x202f],[0x205f,0x205f],[0x3000,0x3000],[0xfeff,0xfeff]]);
const BAD_PERCENT_RE = /%(?![0-9A-Fa-f]{2})/;

function invalid(message: string): AppError {
  return new AppError('INVALID_DESTINATION_URL', message);
}

/** 호스트 정규화: 소문자·IDNA(ASCII)·마지막 점 제거. 실패 시 null */
export function normalizeHostname(raw: string): string | null {
  let h = raw.trim();
  if (h.startsWith('[') && h.endsWith(']')) return h.toLowerCase();
  h = h.replace(/\.$/, '');
  if (!h) return null;
  const ascii = domainToASCII(h);
  if (!ascii) return null;
  return ascii.toLowerCase().replace(/\.$/, '');
}

/** 비 ASCII 문자를 UTF-8 퍼센트 인코딩한다. ASCII 문자는 그대로 둔다. */
function encodeNonAscii(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += cp < 0x80 ? ch : encodeURIComponent(ch);
  }
  return out;
}

/**
 * 목적지 URL을 검증하고 저장값·canonical을 만든다.
 * - http/https 절대 URL만 허용, 스킴 보정 없음
 * - 공백·제어문자·백슬래시·잘못된 퍼센트 인코딩·userinfo 거절
 * - ASCII URL의 경로·쿼리·fragment는 재작성하지 않음
 * - 한글 경로·국제화 도메인은 URI로 변환한 값을 저장
 */
export function parseDestination(input: unknown): ParsedDestination {
  if (typeof input !== 'string') throw invalid('전체 주소를 입력해 주세요.');
  const trimmed = input.trim();
  if (!trimmed) throw invalid('전체 주소를 입력해 주세요.');
  if (FORBIDDEN_CHAR_RE.test(trimmed)) {
    throw invalid('주소에 공백·줄바꿈·제어문자·백슬래시를 넣을 수 없습니다.');
  }
  const m = SCHEME_AUTHORITY_RE.exec(trimmed);
  if (!m) throw invalid('http:// 또는 https:// 로 시작하는 전체 주소를 입력해 주세요.');
  const scheme = m[1].toLowerCase();
  const authority = m[2];
  const rest = m[3];
  if (scheme !== 'http' && scheme !== 'https') {
    throw invalid('http 또는 https 주소만 사용할 수 있습니다.');
  }
  if (authority.includes('@')) throw invalid('사용자명·비밀번호가 포함된 주소는 사용할 수 없습니다.');
  if (!authority) throw invalid('주소의 호스트가 없습니다.');

  // host[:port] 분리 (IPv6 리터럴 포함)
  let hostRaw: string;
  let port: string | null = null;
  const v6 = /^(\[[^\]]+\])(?::(\d*))?$/.exec(authority);
  if (v6) {
    hostRaw = v6[1];
    port = v6[2] ?? null;
  } else {
    const idx = authority.lastIndexOf(':');
    if (idx >= 0) {
      hostRaw = authority.slice(0, idx);
      port = authority.slice(idx + 1);
    } else {
      hostRaw = authority;
    }
  }
  if (port !== null) {
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw invalid('주소의 포트 번호가 올바르지 않습니다.');
    }
  }
  if (!hostRaw) throw invalid('주소의 호스트가 없습니다.');
  if (BAD_PERCENT_RE.test(hostRaw) || hostRaw.includes('%')) {
    throw invalid('주소의 호스트가 올바르지 않습니다.');
  }
  if (BAD_PERCENT_RE.test(rest)) throw invalid('주소의 퍼센트 인코딩이 올바르지 않습니다.');

  const isAscii = /^[\x21-\x7e]*$/.test(trimmed);
  const host = normalizeHostname(hostRaw);
  if (!host) throw invalid('주소의 호스트가 올바르지 않습니다.');

  let stored: string;
  if (isAscii) {
    stored = trimmed;
  } else {
    const hostForStore = /^[\x21-\x7e]*$/.test(hostRaw) ? hostRaw : host;
    stored = `${m[1]}://${hostForStore}${port !== null ? `:${port}` : ''}${encodeNonAscii(rest)}`;
  }
  if (Buffer.byteLength(stored, 'utf8') > MAX_DESTINATION_BYTES) {
    throw invalid('주소가 너무 깁니다. 최대 8,192바이트까지 저장할 수 있습니다.');
  }

  // WHATWG 파서로 최종 형식 확인
  let parsed: URL;
  try {
    parsed = new URL(stored);
  } catch {
    throw invalid('주소 형식이 올바르지 않습니다.');
  }
  if (!parsed.hostname) throw invalid('주소의 호스트가 없습니다.');
  if (parsed.username || parsed.password) {
    throw invalid('사용자명·비밀번호가 포함된 주소는 사용할 수 없습니다.');
  }

  const defaultPort = scheme === 'http' ? '80' : '443';
  const effPort = port === null || port === '' || Number(port) === Number(defaultPort) ? '' : `:${Number(port)}`;
  const storedRest = isAscii ? rest : encodeNonAscii(rest);
  const canonicalRest = storedRest === '' || storedRest.startsWith('?') || storedRest.startsWith('#')
    ? `/${storedRest}`
    : storedRest;
  const canonical = `${scheme}://${host}${effPort}${canonicalRest}`;
  const fingerprint = createHash('sha256').update(canonical, 'utf8').digest();

  return { stored, canonical, fingerprint, host };
}

// ---------------------------------------------------------------------------
// 금지 목적지 (§5.4)
// ---------------------------------------------------------------------------

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

function isForbiddenIPv4(p: number[]): boolean {
  const [a, b] = p;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // 멀티캐스트·예약·브로드캐스트
  );
}

function isForbiddenIPv6(hostBracketed: string): boolean {
  const h = hostBracketed.slice(1, -1).toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true; // fe80::/10
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) {
    const p = ipv4Parts(mapped[1]);
    return p ? isForbiddenIPv4(p) : true;
  }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isForbiddenIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return false;
}

/**
 * 금지 목적지 검사. serviceHosts 는 service_domains 의 모든 등록 호스트(현재·이전·연결 예정)와
 * 명시적으로 운영하는 자체 하위 호스트이며 정규화된 값이어야 한다.
 */
export function assertAllowedDestination(dest: ParsedDestination, serviceHosts: Iterable<string>): void {
  const forbidden = (msg: string) => new AppError('FORBIDDEN_DESTINATION', msg);
  // WHATWG 파서가 10진·16진 IPv4 표기를 정규화한 호스트로도 검사한다.
  const whatwgHost = new URL(dest.stored).hostname.toLowerCase().replace(/\.$/, '');
  for (const h of new Set([dest.host, whatwgHost])) {
    if (h === 'localhost' || h.endsWith('.localhost') || h === 'local' || h.endsWith('.local')) {
      throw forbidden('내부 주소(localhost·.local)로는 연결할 수 없습니다.');
    }
    const v4 = ipv4Parts(h);
    if (v4 && isForbiddenIPv4(v4)) throw forbidden('사설·루프백·링크로컬 IP 주소로는 연결할 수 없습니다.');
    if (h.startsWith('[') && isForbiddenIPv6(h)) {
      throw forbidden('사설·루프백·링크로컬 IP 주소로는 연결할 수 없습니다.');
    }
    for (const sh of serviceHosts) {
      if (h === sh) throw forbidden('이 서비스의 짧은 주소 호스트로는 연결할 수 없습니다.');
    }
  }
}
