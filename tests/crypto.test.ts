import { describe, expect, it } from 'vitest';
import {
  API_KEY_LENGTH, generateApiKey, generateShortCode, isReservedCode, parseApiKey, SHORT_CODE_RE, stableStringify,
} from '@/lib/crypto';
import { requireSingleIfMatch, linkEtag } from '@/lib/etag';
import { AppError } from '@/lib/errors';
import { formatKst, kstFileStamp } from '@/lib/time';

describe('짧은 코드', () => {
  it('Base62 7자, 예약어 제외', () => {
    for (let i = 0; i < 2000; i++) {
      const c = generateShortCode();
      expect(c).toMatch(SHORT_CODE_RE);
      expect(isReservedCode(c)).toBe(false);
    }
    expect(isReservedCode('HealthZ')).toBe(true);
  });
});

describe('API 키 형식 (PRD §13.8)', () => {
  it('발급·파싱·해시', () => {
    const k = generateApiKey('live');
    expect(k.plaintext).toHaveLength(API_KEY_LENGTH);
    expect(k.plaintext.startsWith(`bzup_live_${k.publicId}_`)).toBe(true);
    expect(k.publicId).toHaveLength(22);
    const p = parseApiKey(k.plaintext)!;
    expect(p.env).toBe('live');
    expect(p.publicId).toBe(k.publicId);
    expect(p.hash.equals(k.secretHash)).toBe(true);
  });
  it('밑줄이 포함된 public_id·secret도 고정 길이로 파싱한다', () => {
    const pid = 'ab_cd-ef_gh_ij-kl_mn_o';
    const secret = '_'.repeat(43);
    expect(parseApiKey(`bzup_test_${pid}_${secret}`)?.publicId).toBe(pid);
  });
  it.each(['', 'bzup_live_x', 'Bearer abc', `bzup_prod_${'a'.repeat(22)}_${'b'.repeat(43)}`, `bzup_live_${'a'.repeat(22)}-${'b'.repeat(43)}`,
    `bzup_live_${'a'.repeat(22)}_${'b'.repeat(42)}!`])('거절 %j', (s) => expect(parseApiKey(s)).toBeNull());
});

describe('If-Match (PRD §14.6)', () => {
  const code = (h: string | null) => { try { requireSingleIfMatch(h); return 'OK'; } catch (e) { return (e as AppError).code; } };
  it('규칙', () => {
    expect(code(null)).toBe('PRECONDITION_REQUIRED');
    expect(code('*')).toBe('INVALID_IF_MATCH');
    expect(code('W/"x"')).toBe('INVALID_IF_MATCH');
    expect(code('"a", "b"')).toBe('INVALID_IF_MATCH');
    expect(code('abc')).toBe('INVALID_IF_MATCH');
    expect(code(linkEtag('9f39e8be-266c-4e15-b99e-a1f8395f2f66', 1, 1))).toBe('OK');
    expect(linkEtag('id', 3, 2)).toBe('"link-id-v3-u2"');
  });
});

describe('기타', () => {
  it('stableStringify 키 순서 고정', () => {
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(stableStringify({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
  it('KST', () => {
    const d = new Date('2026-11-18T15:30:05Z');
    expect(formatKst(d)).toBe('2026-11-19 00:30:05');
    expect(kstFileStamp(d)).toBe('20261119_003005');
  });
});
