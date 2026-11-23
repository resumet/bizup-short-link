// 강의 관리 (PRD §4.1, §15.3)
// 등록·수정·종료·재개, 물리 삭제 없음, ETag/If-Match, 감사 기록
import { AppError, validationError } from '@/lib/errors';
import { toIso } from '@/lib/time';
import type { Db, Queryable } from '@/lib/db/types';
import type { UserPrincipal } from '@/lib/auth/principal';
import { assertAllowedFields, cleanText, isObject, optionalText } from '@/lib/validation';
import { audit, runAdminWrite } from './admin-write';

export interface CourseRow {
  id: string;
  name: string;
  instructor_name: string | null;
  memo: string | null;
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
    memo: c.memo,
    status: c.status,
    version: Number(c.version),
    created_at: toIso(c.created_at),
    updated_at: toIso(c.updated_at),
    ...(c.link_count !== undefined ? { link_count: Number(c.link_count) } : {}),
  };
}

export async function listCoursesForAdmin(q: Queryable, workspaceId: string) {
  const rows = await q.query<CourseRow & { link_count: number }>(
    `select c.id, c.name, c.instructor_name, c.memo, c.status, c.version, c.created_at, c.updated_at,
            (select count(*)::int from bzup.links l where l.workspace_id = c.workspace_id and l.course_id = c.id) as link_count
       from bzup.courses c where c.workspace_id = $1
      order by case c.status when 'active' then 0 else 1 end, c.name, c.created_at`,
    [workspaceId],
  );
  return rows.map(serializeCourse);
}

interface CourseInput {
  name?: string;
  instructor_name?: string | null;
  memo?: string | null;
  status?: 'active' | 'closed';
}

function parseCourseBody(body: unknown, requireName: boolean): CourseInput {
  if (!isObject(body)) throw new AppError('INVALID_JSON');
  assertAllowedFields(body, ['name', 'instructor_name', 'memo', 'status']);
  const out: CourseInput = {};
  if (requireName || 'name' in body) out.name = cleanText(body.name, 'name', '강의명', 1, 120);
  if ('instructor_name' in body) out.instructor_name = optionalText(body.instructor_name, 'instructor_name', '강사명', 80);
  if ('memo' in body) {
    if (body.memo !== null && typeof body.memo === 'string' && [...body.memo].length > 500) {
      throw validationError('메모는 500자 이내로 입력해 주세요.', [{ field: 'memo', message: '최대 500자' }]);
    }
    out.memo = body.memo === null || body.memo === undefined ? null : String(body.memo).trim() || null;
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'closed') throw validationError('상태는 진행중(active) 또는 종료(closed)입니다.');
    out.status = body.status;
  }
  if (!requireName && Object.keys(out).length === 0) throw validationError('변경할 항목이 없습니다.');
  return out;
}

async function sameNameWarning(q: Queryable, workspaceId: string, name: string, exceptId: string | null) {
  const r = await q.query(
    `select 1 from bzup.courses where workspace_id = $1 and name = $2 and ($3::uuid is null or id <> $3)`,
    [workspaceId, name, exceptId],
  );
  return r.length ? ['같은 이름의 강의가 있습니다. 강사명·메모로 구분해 주세요.'] : [];
}

export async function createCourse(db: Db, p: UserPrincipal, body: unknown, key: string, requestId: string) {
  const input = parseCourseBody(body, true);
  return runAdminWrite(db, p, { method: 'POST', route: '/admin/courses', idempotencyKey: key, hashInput: body, resultObjectType: 'course' },
    async (q, owner) => {
      const warnings = await sameNameWarning(q, owner.workspaceId, input.name!, null);
      const [c] = await q.query<CourseRow>(
        `insert into bzup.courses (workspace_id, name, instructor_name, memo, status, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$6)
         returning id, name, instructor_name, memo, status, version, created_at, updated_at`,
        [owner.workspaceId, input.name, input.instructor_name ?? null, input.memo ?? null, input.status ?? 'active', owner.userId],
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
      `select id, name, instructor_name, memo, status, version, created_at, updated_at
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
      memo: input.memo !== undefined ? input.memo : cur.memo,
      status: input.status ?? cur.status,
    };
    const changed = (['name', 'instructor_name', 'memo', 'status'] as const).filter((k) => next[k] !== cur[k]);
    let result = cur;
    let warnings: string[] = [];
    if (changed.length) {
      if (changed.includes('name')) warnings = await sameNameWarning(q, owner.workspaceId, next.name, id);
      // 강의명 변경으로 링크 version 을 올리지 않는다 (§15.3)
      [result] = await q.query<CourseRow>(
        `update bzup.courses set name=$3, instructor_name=$4, memo=$5, status=$6, version = version + 1,
                updated_by=$7, updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2
          returning id, name, instructor_name, memo, status, version, created_at, updated_at`,
        [owner.workspaceId, id, next.name, next.instructor_name, next.memo, next.status, owner.userId],
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
