// 서비스 주소 정책 (PRD §15.9, §20.4)
// 운영 주소 설정의 기준은 DB 한 곳이다. 장기 메모리 캐시를 두지 않는다.
import { AppError } from '@/lib/errors';
import type { Queryable } from '@/lib/db/types';

export interface UrlPolicy {
  namespaceId: string;
  workspaceId: string;
  primaryHost: string;
  urlConfigVersion: number;
  /** 등록된 모든 호스트(pending·active·retired) — 금지 목적지 판정용 */
  serviceHosts: string[];
  /** 공개 이동·API·인증을 처리하는 active 호스트 */
  activeHosts: string[];
}

export async function loadUrlPolicy(q: Queryable): Promise<UrlPolicy> {
  const rows = await q.query<{
    service_namespace_id: string; workspace_id: string; url_config_version: number; primary_host: string;
  }>(
    `select s.service_namespace_id, s.workspace_id, s.url_config_version, d.hostname as primary_host
       from bzup.service_settings s
       join bzup.service_domains d on d.id = s.primary_domain_id`,
  );
  const s = rows[0];
  if (!s) throw new AppError('SERVICE_UNAVAILABLE', '서비스 주소 설정이 초기화되지 않았습니다.');
  const domains = await q.query<{ hostname: string; status: string }>(
    `select hostname, status from bzup.service_domains where service_namespace_id = $1`,
    [s.service_namespace_id],
  );
  return {
    namespaceId: s.service_namespace_id,
    workspaceId: s.workspace_id,
    primaryHost: s.primary_host,
    urlConfigVersion: Number(s.url_config_version),
    serviceHosts: domains.map((d) => d.hostname),
    activeHosts: domains.filter((d) => d.status === 'active').map((d) => d.hostname),
  };
}

/** 로컬 개발 호스트만 http, 나머지는 https */
export function originFor(host: string): string {
  const bare = host.replace(/:\d+$/, '');
  const local = bare === 'localhost' || bare === '127.0.0.1' || bare.endsWith('.localhost');
  return `${local ? 'http' : 'https'}://${host}`;
}

export function shortUrlFor(host: string, code: string): string {
  return `${originFor(host)}/${code}`;
}

/** 요청 Host 헤더를 정규화한다 (포트 유지, 소문자, 마지막 점 제거). */
export function normalizeRequestHost(host: string | null): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  const m = /^([^:]+?)\.?(:\d+)?$/.exec(h);
  if (!m) return null;
  return `${m[1]}${m[2] ?? ''}`;
}
