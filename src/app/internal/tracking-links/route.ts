// 트래킹 링크: 엑셀 업로드로 발급(POST multipart), 강의별 보관 목록(GET)
// 업로드 파일은 요청 메모리에서만 읽고 어디에도 저장하지 않는다.
import { internalRoute } from '@/lib/route';
import { json } from '@/lib/http';
import { AppError } from '@/lib/errors';
import type { UserPrincipal } from '@/lib/auth/principal';
import { readTrackingWorkbook, TRACKING_MAX_FILE_BYTES } from '@/lib/tracking/excel';
import { createTrackingLinks, listTrackingLinks } from '@/lib/services/tracking-links';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = internalRoute(async (c) => {
  const courseId = new URL(c.req.url).searchParams.get('course_id');
  return json({ data: await listTrackingLinks(c.db, c.principal as UserPrincipal, courseId) }, 200, c.requestId);
});

export const POST = internalRoute(async (c) => {
  if (!/^multipart\/form-data/i.test(c.req.headers.get('content-type') ?? '')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '엑셀 파일을 첨부해 주세요.');
  }
  if (Number(c.req.headers.get('content-length') ?? '0') > TRACKING_MAX_FILE_BYTES + 64 * 1024) {
    throw new AppError('PAYLOAD_TOO_LARGE', '엑셀 파일은 4MB 이하만 올릴 수 있습니다.');
  }
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new AppError('INVALID_JSON', '업로드 요청을 읽을 수 없습니다.');
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) throw new AppError('VALIDATION_ERROR', '엑셀 파일을 첨부해 주세요.');
  if (file.size > TRACKING_MAX_FILE_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', '엑셀 파일은 4MB 이하만 올릴 수 있습니다.');
  if (!/\.xlsx$/i.test(file.name)) throw new AppError('VALIDATION_ERROR', '.xlsx 형식의 엑셀 파일만 올릴 수 있습니다.');
  const rows = await readTrackingWorkbook(await file.arrayBuffer());
  const result = await createTrackingLinks(
    c.db, c.principal as UserPrincipal, { courseId: form.get('course_id'), fileName: file.name, rows }, c.requestId,
  );
  return json({ data: result }, result.created_count ? 201 : 200, c.requestId);
});
