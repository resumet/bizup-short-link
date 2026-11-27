// 전환형 유형의 전환 주소 구성 [{ key, label }] (2~5개)
import { validationError } from '@/lib/errors';

export interface SlotDef { key: string; label: string }

export const SLOT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const MIN_SLOTS = 2;
export const MAX_SLOTS = 5;

/** 관리 화면·API 입력 검증. null = 일반 유형 */
export function parseSlotDefs(v: unknown): SlotDef[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || v.length < MIN_SLOTS || v.length > MAX_SLOTS) {
    throw validationError(`전환 주소는 ${MIN_SLOTS}~${MAX_SLOTS}개로 정해 주세요.`, [{ field: 'slots', message: `${MIN_SLOTS}~${MAX_SLOTS}개` }]);
  }
  const seen = new Set<string>();
  return v.map((d, i) => {
    const key = (d as { key?: unknown })?.key;
    const label = (d as { label?: unknown })?.label;
    if (typeof key !== 'string' || !SLOT_KEY_RE.test(key)) {
      throw validationError(`${i + 1}번째 전환 키는 소문자 영문으로 시작하고 소문자 영문·숫자·밑줄만 쓸 수 있습니다 (1~32자).`,
        [{ field: `slots[${i}].key`, message: '형식 오류' }]);
    }
    if (seen.has(key)) throw validationError(`전환 키가 중복되었습니다: ${key}`, [{ field: `slots[${i}].key`, message: '중복' }]);
    seen.add(key);
    if (typeof label !== 'string' || !label.trim() || [...label.trim()].length > 40) {
      throw validationError(`${i + 1}번째 전환 주소 이름은 1~40자입니다.`, [{ field: `slots[${i}].label`, message: '1~40자' }]);
    }
    return { key, label: label.trim() };
  });
}
