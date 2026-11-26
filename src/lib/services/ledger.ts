// 독립 코드 예약 원장 (PRD §5.5, §15.8)
// - 객체 키: {service_namespace_id}/{short_code}
// - 조건부 신규 쓰기만 허용, 갱신·삭제·자동 만료 금지, DB 복원과 독립 보존
// - 회사 쓰기 잠금을 보유한 채 호출하지 않는다 (§16.3)
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppError } from '@/lib/errors';
import type { Db } from '@/lib/db/types';

export interface ReservationInput {
  namespaceId: string;
  shortCode: string;
  linkId: string;
  workspaceId: string;
}

export interface CodeLedger {
  /** true=예약 성공, false=이미 예약된 코드. 원장 장애는 예외. */
  reserve(input: ReservationInput): Promise<boolean>;
  /**
   * 여러 코드를 한 번에 예약하고 성공한 `${short_code}:${link_id}` 집합을 돌려준다 (선택).
   * DB 원장은 동시 쿼리 대신 한 문장으로 처리해야 한다: 연결 수보다 많은 동시 쿼리는
   * postgres.js 파이프라이닝 + Supabase transaction pooler 조합에서 멈춘다.
   */
  reserveMany?(inputs: ReservationInput[]): Promise<Set<string>>;
}

/** 개발·테스트용: 별도 schema 의 append-only 테이블 (자체 연결로 즉시 커밋) */
export class PostgresLedger implements CodeLedger {
  constructor(private readonly db: Db) {}
  async reserve(i: ReservationInput): Promise<boolean> {
    const rows = await this.db.query<{ short_code: string }>(
      `insert into bzup_ledger.code_reservations (service_namespace_id, short_code, link_id, workspace_id)
       values ($1, $2, $3, $4)
       on conflict do nothing
       returning short_code`,
      [i.namespaceId, i.shortCode, i.linkId, i.workspaceId],
    );
    return rows.length === 1;
  }
  async reserveMany(inputs: ReservationInput[]): Promise<Set<string>> {
    if (!inputs.length) return new Set();
    const rows = await this.db.query<{ short_code: string; link_id: string }>(
      `insert into bzup_ledger.code_reservations (service_namespace_id, short_code, link_id, workspace_id)
       select t.ns, t.code, t.link_id, t.ws
         from unnest($1::uuid[], $2::text[], $3::uuid[], $4::uuid[]) as t(ns, code, link_id, ws)
       on conflict do nothing
       returning short_code, link_id`,
      [inputs.map((i) => i.namespaceId), inputs.map((i) => i.shortCode), inputs.map((i) => i.linkId), inputs.map((i) => i.workspaceId)],
    );
    return new Set(rows.map((r) => `${r.short_code}:${r.link_id}`));
  }
}

/** 운영용: S3 호환 저장소의 조건부 신규 쓰기 (If-None-Match: *) */
export class S3Ledger implements CodeLedger {
  private readonly client: S3Client;
  constructor(private readonly bucket: string, client?: S3Client) {
    this.client = client ?? new S3Client({});
  }
  async reserve(i: ReservationInput): Promise<boolean> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `${i.namespaceId}/${i.shortCode}`,
          IfNoneMatch: '*',
          ContentType: 'application/json',
          Body: JSON.stringify({
            link_id: i.linkId,
            workspace_id: i.workspaceId,
            reserved_at: new Date().toISOString(),
          }),
        }),
      );
      return true;
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 412) return false; // 이미 존재
      if (status === 409) {
        // 동시 조건부 쓰기 충돌: 다른 요청이 먼저 선점한 것으로 본다.
        return false;
      }
      throw new AppError('SERVICE_UNAVAILABLE', '짧은 주소 발급을 일시적으로 처리할 수 없습니다.');
    }
  }
}

/** 테스트용 메모리 원장 */
export class MemoryLedger implements CodeLedger {
  readonly reserved = new Map<string, ReservationInput>();
  /** 테스트에서 강제로 충돌시킬 코드 */
  readonly taken = new Set<string>();
  failing = false;
  async reserve(i: ReservationInput): Promise<boolean> {
    if (this.failing) throw new AppError('SERVICE_UNAVAILABLE', '짧은 주소 발급을 일시적으로 처리할 수 없습니다.');
    const k = `${i.namespaceId}/${i.shortCode}`;
    if (this.reserved.has(k) || this.taken.has(i.shortCode)) return false;
    this.reserved.set(k, i);
    return true;
  }
}

let ledger: CodeLedger | null = null;

export function setLedger(l: CodeLedger): void {
  ledger = l;
}

export function getLedger(db: Db): CodeLedger {
  if (ledger) return ledger;
  const driver = process.env.CODE_LEDGER_DRIVER ?? 'postgres';
  if (driver === 's3') {
    const bucket = process.env.CODE_LEDGER_BUCKET;
    if (!bucket) throw new Error('CODE_LEDGER_BUCKET is not configured');
    ledger = new S3Ledger(bucket);
  } else {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DB_LEDGER !== 'true') {
      throw new Error('운영 환경은 DB와 독립된 코드 원장(CODE_LEDGER_DRIVER=s3)을 사용해야 합니다.');
    }
    ledger = new PostgresLedger(db);
  }
  return ledger;
}
