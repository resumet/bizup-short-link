// strong ETag·If-Match (PRD §14.1, §14.6)
import { AppError } from '@/lib/errors';

export function linkEtag(id: string, version: number, urlConfigVersion: number): string {
  return `"link-${id}-v${version}-u${urlConfigVersion}"`;
}

/**
 * If-Match 헤더를 하나의 strong ETag로 해석한다.
 * 누락 428, 별표·weak·복수 ETag 400.
 */
export function requireSingleIfMatch(header: string | null): string {
  if (header === null || header.trim() === '') throw new AppError('PRECONDITION_REQUIRED');
  const v = header.trim();
  if (v === '*' || v.startsWith('W/') || v.includes(',')) {
    throw new AppError('INVALID_IF_MATCH', '하나의 strong ETag만 If-Match로 보낼 수 있습니다.');
  }
  if (!/^"[\x21\x23-\x7e]+"$/.test(v)) throw new AppError('INVALID_IF_MATCH');
  return v;
}
