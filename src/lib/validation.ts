// 공통 입력 검증 (PRD §5.3, §13.1)
import { AppError, validationError } from '@/lib/errors';
import { charClass } from '@/lib/charclass';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EXTERNAL_REF_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const CONTROL_RE = charClass([[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029]]);

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 허용 목록 밖의 필드는 422 VALIDATION_ERROR (§13.1) */
export function assertAllowedFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw validationError(`허용되지 않은 필드입니다: ${extra.join(', ')}`, undefined, { fields: extra });
}

/** 양끝 공백 제거 후 min~max 코드포인트, 줄바꿈·제어문자 거절 */
export function cleanText(v: unknown, field: string, label: string, min: number, max: number): string {
  if (typeof v !== 'string') throw validationError(`${label}을(를) 입력해 주세요.`, [{ field, message: `${label}을(를) 입력해 주세요.` }]);
  const s = v.trim();
  const len = [...s].length;
  if (len < min || len > max) {
    const msg = min > 0 && len === 0 ? `${label}을(를) 입력해 주세요.` : `${label}은(는) ${min}~${max}자로 입력해 주세요.`;
    throw validationError(msg, [{ field, message: msg }]);
  }
  if (CONTROL_RE.test(s)) {
    const msg = `${label}에 줄바꿈·제어문자를 넣을 수 없습니다.`;
    throw validationError(msg, [{ field, message: msg }]);
  }
  return s;
}

export function optionalText(v: unknown, field: string, label: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = cleanText(v, field, label, 0, max);
  return s === '' ? null : s;
}

export function uuidField(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw validationError(`${field} 형식이 올바르지 않습니다.`, [{ field, message: 'UUID 형식이어야 합니다.' }]);
  return v.toLowerCase();
}

export function externalRefField(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !EXTERNAL_REF_RE.test(v)) {
    throw validationError('external_ref는 1~200자의 영문·숫자·.:_- 만 사용할 수 있습니다.', [{ field: 'external_ref', message: '형식 오류' }]);
  }
  return v;
}

export function assertUuidPath(id: string): string {
  if (!UUID_RE.test(id)) throw new AppError('NOT_FOUND');
  return id.toLowerCase();
}
