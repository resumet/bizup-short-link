// 강의 관리 (PRD §4.1, §15.3)
// 등록·수정·종료·재개, 물리 삭제 없음, ETag/If-Match, 감사 기록
import { AppError, validationError } from '@/lib/errors';
import { toIso } from '@/lib/time';
import type { Db, Queryable } from '@/lib/db/types';
import type { UserPrincipal } from '@/lib/auth/principal';
import { assertAllowedFields, cleanText, isObject, optionalText, uuidField } from '@/lib/validation';
import { audit, runAdminWrite } from './admin-write';

export interface CourseRow {
  id: string;
  name: string;
  instructor_name: string | null;
  cohort: string | null;
  webinar_at: Date | null;
  source: 'manual' | 'dashboard';
  status: 'active' | 'closed';
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const courseEtag = (id: string, version: number) => `"course-${id}-v${version}"`;

export function serializeCourse(c: CourseRow & { link_count?: number }) {
  return {
    id: c.id,
    name: c.name,
    instructor_name: c.instructor_name,
    cohort: c.cohort,
    webinar_at: toIso(c.webinar_at),
    source: c.source,
    status: c.status,
    version: Number(c.version),
    created_at: toIso(c.created_at),
    updated_at: toIso(c.updated_at),
    ...(c.link_count !== undefined ? { link_count: Number(c.link_count) } : {}),
  };
}

export async function listCoursesForAdmin(q: Queryable, workspaceId: string) {
  const rows = await q.query<CourseRow & { link_count: number }>(
    `select c.id, c.name, c.instructor_name, c.cohort, c.webinar_at, c.source, c.status, c.version, c.created_at, c.updated_at,
            (select count(*)::int from bzup.links l where l.workspace_id = c.workspace_id and l.course_id = c.id and l.deleted_at is null) as link_count
       from bzup.courses c where c.workspace_id = $1
      order by case c.status when 'active' then 0 else 1 end, c.webinar_at desc nulls last, c.name, c.created_at`,
    [workspaceId],
  );
  return rows.map(serializeCourse);
}

interface CourseInput {
  name?: string;
  instructor_name?: string | null;
  cohort?: string | null;
  webinar_at?: string | null;
  status?: 'active' | 'closed';
}

function parseCourseBody(body: unknown, requireName: boolean): CourseInput {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['name', 'instructor_name', 'cohort', 'webinar_at', 'status']);
  const out: CourseInput = {};
  if (requireName || 'name' in body) out.name = cleanText(body.name, 'name', '강의명', 1, 120);
  if ('instructor_name' in body) out.instructor_name = optionalText(body.instructor_name, 'instructor_name', '강사명', 80);
  if ('cohort' in body) out.cohort = parseCohort(body.cohort);
  if ('webinar_at' in body) out.webinar_at = parseWebinarAt(body.webinar_at);
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'closed') throw validationError('상태는 진행중(active) 또는 종료(closed)입니다.');
    out.status = body.status;
  }
  if (!requireName && Object.keys(out).length === 0) throw validationError('변경할 항목이 없습니다.');
  return out;
}

function parseCohort(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  return optionalText(v, 'cohort', '기수', 40);
}

function parseWebinarAt(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw validationError('웨비나 일정 형식이 올바르지 않습니다.', [{ field: 'webinar_at', message: '날짜·시간 형식' }]);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function sameNameWarning(q: Queryable, workspaceId: string, name: string, exceptId: string | null) {
  const r = await q.query(
    `select 1 from bzup.courses where workspace_id = $1 and name = $2 and ($3::uuid is null or id <> $3)`,
    [workspaceId, name, exceptId],
  );
  return r.length ? ['같은 이름의 강의가 있습니다. 강사명·기수로 구분해 주세요.'] : [];
}

export async function createCourse(db: Db, p: UserPrincipal, body: unknown, key: string, requestId: string) {
  const input = parseCourseBody(body, true);
  return runAdminWrite(db, p, { method: 'POST', route: '/admin/courses', idempotencyKey: key, hashInput: body, resultObjectType: 'course' },
    async (q, owner) => {
      const warnings = await sameNameWarning(q, owner.workspaceId, input.name!, null);
      const [c] = await q.query<CourseRow>(
        `insert into bzup.courses (workspace_id, name, instructor_name, cohort, webinar_at, status, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$7)
         returning id, name, instructor_name, cohort, webinar_at, source, status, version, created_at, updated_at`,
        [owner.workspaceId, input.name, input.instructor_name ?? null, input.cohort ?? null, input.webinar_at ?? null, input.status ?? 'active', owner.userId],
      );
      await audit(q, owner, { objectType: 'course', objectId: c.id, action: 'course_created', after: serializeCourse(c), requestId });
      return {
        status: 201,
        body: { data: serializeCourse(c), warnings },
        headers: { ETag: courseEtag(c.id, 1), Location: `/internal/admin/courses/${c.id}` },
        objectId: c.id,
      };
    });
}

export async function updateCourse(db: Db, p: UserPrincipal, id: string, body: unknown, ifMatch: string, key: string, requestId: string) {
  const input = parseCourseBody(body, false);
  return runAdminWrite(db, p, {
    method: 'PATCH', route: `/admin/courses/${id}`, idempotencyKey: key, hashInput: { body, if_match: ifMatch }, resultObjectType: 'course',
  }, async (q, owner) => {
    const rows = await q.query<CourseRow>(
      `select id, name, instructor_name, cohort, webinar_at, source, status, version, created_at, updated_at
         from bzup.courses where workspace_id = $1 and id = $2 for update`,
      [owner.workspaceId, id],
    );
    const cur = rows[0];
    if (!cur) throw new AppError('NOT_FOUND');
    const etag = courseEtag(cur.id, Number(cur.version));
    if (ifMatch !== etag) throw new AppError('PRECONDITION_FAILED', undefined, { headers: { ETag: etag } });
    const next = {
      name: input.name ?? cur.name,
      instructor_name: input.instructor_name !== undefined ? input.instructor_name : cur.instructor_name,
      cohort: input.cohort !== undefined ? input.cohort : cur.cohort,
      webinar_at: input.webinar_at !== undefined ? input.webinar_at : toIso(cur.webinar_at),
      status: input.status ?? cur.status,
    };
    const curCmp = { ...cur, webinar_at: toIso(cur.webinar_at) };
    const changed = (['name', 'instructor_name', 'cohort', 'webinar_at', 'status'] as const).filter((k) => next[k] !== curCmp[k]);
    let result = cur;
    let warnings: string[] = [];
    if (changed.length) {
      if (changed.includes('name')) warnings = await sameNameWarning(q, owner.workspaceId, next.name, id);
      // 강의명 변경으로 링크 version 을 올리지 않는다 (§15.3)
      [result] = await q.query<CourseRow>(
        `update bzup.courses set name=$3, instructor_name=$4, cohort=$5, webinar_at=$6, status=$7, version = version + 1,
                updated_by=$8, updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2
          returning id, name, instructor_name, cohort, webinar_at, source, status, version, created_at, updated_at`,
        [owner.workspaceId, id, next.name, next.instructor_name, next.cohort, next.webinar_at, next.status, owner.userId],
      );
      const action = changed.includes('status') ? (next.status === 'closed' ? 'course_closed' : 'course_reopened') : 'course_updated';
      await audit(q, owner, { objectType: 'course', objectId: id, action, before: serializeCourse(cur), after: serializeCourse(result), requestId });
    }
    return {
      status: 200,
      body: { data: serializeCourse(result), changed_fields: changed, warnings },
      headers: { ETag: courseEtag(id, Number(result.version)) },
      objectId: id,
    };
  });
}

// ---------------------------------------------------------------------------
// 외부 강의(bizup-dashboard) 가져오기: 외부 강의 UUID 를 id 로 사용, 이미 있는 UUID 는 건너뛴다
// ---------------------------------------------------------------------------

export const IMPORT_MAX = 100;

interface ImportItem { id: string; name: string; instructor_name: string | null; cohort: string | null; webinar_at: string | null }

function parseImportBody(body: unknown): ImportItem[] {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['courses']);
  if (!Array.isArray(body.courses) || body.courses.length === 0) throw validationError('추가할 강의를 선택해 주세요.');
  if (body.courses.length > IMPORT_MAX) throw validationError(`한 번에 ${IMPORT_MAX}개까지 추가할 수 있습니다.`);
  const seen = new Set<string>();
  return body.courses.map((raw: unknown, i: number) => {
    if (!isObject(raw)) throw validationError('강의 형식이 올바르지 않습니다.', [{ row: i, message: '형식 오류' }]);
    assertAllowedFields(raw, ['id', 'name', 'instructor_name', 'cohort', 'webinar_at']);
    const id = uuidField(raw.id, 'id').toLowerCase();
    if (seen.has(id)) throw validationError('같은 강의가 두 번 선택되었습니다.', [{ row: i, field: 'id', message: '중복' }]);
    seen.add(id);
    return {
      id,
      name: cleanText(raw.name, 'name', '강의명', 1, 120),
      instructor_name: optionalText(raw.instructor_name, 'instructor_name', '강사명', 80),
      cohort: parseCohort(raw.cohort),
      webinar_at: parseWebinarAt(raw.webinar_at),
    };
  });
}

export async function importCourses(db: Db, p: UserPrincipal, body: unknown, key: string, requestId: string) {
  const items = parseImportBody(body);
  return runAdminWrite(db, p, { method: 'POST', route: '/admin/courses/import', idempotencyKey: key, hashInput: body, resultObjectType: 'course_import' },
    async (q, owner) => {
      const added: string[] = [];
      const skipped: string[] = [];
      for (const it of items) {
        const rows = await q.query<CourseRow>(
          `insert into bzup.courses (id, workspace_id, name, instructor_name, cohort, webinar_at, source, status, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,'dashboard','active',$7,$7)
           on conflict (id) do nothing
           returning id, name, instructor_name, cohort, webinar_at, source, status, version, created_at, updated_at`,
          [it.id, owner.workspaceId, it.name, it.instructor_name, it.cohort, it.webinar_at, owner.userId],
        );
        if (rows[0]) {
          added.push(it.id);
          await audit(q, owner, { objectType: 'course', objectId: it.id, action: 'course_imported', after: serializeCourse(rows[0]), requestId });
        } else {
          skipped.push(it.id);
        }
      }
      return { status: 200, body: { data: { added, skipped } }, headers: {}, objectId: null };
    });
}
