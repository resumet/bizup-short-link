import { describe, expect, it } from 'vitest';
import { assertAllowedDestination, parseDestination } from '@/lib/url/destination';
import { AppError } from '@/lib/errors';

const canon = (u: string) => parseDestination(u).canonical;
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as AppError).code; }
  return 'OK';
};

describe('canonical 동일 URL 판정 (PRD §6.3)', () => {
  it.each([
    ['https://EXAMPLE.com', 'https://example.com/'],
    ['https://example.com:443/a', 'https://example.com/a'],
    ['http://example.com:80/a', 'http://example.com/a'],
    ['https://example.com./a', 'https://example.com/a'],
    ['https://example.com?x=1', 'https://example.com/?x=1'],
    ['https://한국.kr/a', 'https://xn--3e0b707e.kr/a'],
  ])('%s == %s', (a, b) => expect(canon(a)).toBe(canon(b)));

  it.each([
    ['http://example.com/a', 'https://example.com/a'],
    ['https://example.com/A', 'https://example.com/a'],
    ['https://example.com/?a=1&b=2', 'https://example.com/?b=2&a=1'],
    ['https://example.com/?utm_source=sms', 'https://example.com/?utm_source=blog'],
    ['https://example.com/#section1', 'https://example.com/#section2'],
    ['https://example.com/', 'https://example.com/?'],
    ['https://example.com/', 'https://example.com/#'],
    ['https://example.com/a+b', 'https://example.com/a%20b'],
  ])('%s != %s', (a, b) => expect(canon(a)).not.toBe(canon(b)));
});

describe('저장값 (PRD §5.3)', () => {
  it('유효한 ASCII URL은 그대로 저장한다', () => {
    const u = 'https://Bizupclass.com/webinar/kim?utm_source=sms&utm_source=x&q=a+b%20c#Frag';
    expect(parseDestination(`  ${u}  `).stored).toBe(u);
  });
  it('한글 경로와 국제화 도메인을 URI로 변환한다', () => {
    const p = parseDestination('https://한국.kr/강의?이름=김선아#소개');
    expect(p.stored).toBe(
      'https://xn--3e0b707e.kr/%EA%B0%95%EC%9D%98?%EC%9D%B4%EB%A6%84=%EA%B9%80%EC%84%A0%EC%95%84#%EC%86%8C%EA%B0%9C',
    );
  });
  it.each([
    ['example.com/a'],
    ['ftp://example.com/'],
    ['javascript:alert(1)'],
    ['https://exa mple.com/'],
    ['https://example.com/a b'],
    ['https://example.com/a\nb'],
    ['https://example.com\\a'],
    ['https://example.com/%zz'],
    ['https://example.com/%4'],
    ['https://user:pw@example.com/'],
    ['https://user@example.com/'],
    ['https://example.com:99999/'],
    ['https:///a'],
    [''],
  ])('거절: %j', (u) => expect(code(() => parseDestination(u))).toBe('INVALID_DESTINATION_URL'));
  it('8,192바이트 초과 거절', () => {
    expect(code(() => parseDestination(`https://example.com/${'a'.repeat(8200)}`))).toBe('INVALID_DESTINATION_URL');
  });
});

describe('금지 목적지 (PRD §5.4)', () => {
  const hosts = ['bzup-link-demo.vercel.app', 'bzup.io'];
  const check = (u: string) => code(() => assertAllowedDestination(parseDestination(u), hosts));
  it.each([
    'http://localhost/a', 'http://app.localhost/', 'http://printer.local/', 'http://127.0.0.1/', 'http://10.1.2.3/',
    'http://172.16.0.1/', 'http://192.168.0.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://[fe80::1]/',
    'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/',
    'https://bzup.io/abc', 'https://BZUP.IO./abc', 'https://bzup-link-demo.vercel.app/K7m2Q8x',
  ])('금지: %s', (u) => expect(check(u)).toBe('FORBIDDEN_DESTINATION'));
  it.each(['https://other.vercel.app/x', 'https://bizupclass.com/', 'http://8.8.8.8/', 'https://sub.bzup.io.example.com/'])(
    '허용: %s', (u) => expect(check(u)).toBe('OK'),
  );
});
