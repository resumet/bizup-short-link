-- 1) 링크 조회수: 일자별(KST) 집계와 총계
--    방문자 IP·User-Agent 등 개인 식별 정보는 저장하지 않는다 (PRD §18.5)
create table bzup.link_daily_views (
  link_id    uuid not null references bzup.links(id),
  view_date  date not null,                 -- Asia/Seoul 기준 날짜
  views      bigint not null default 0 check (views >= 0),
  primary key (link_id, view_date)
);

create table bzup.link_view_totals (
  link_id         uuid primary key references bzup.links(id),
  total_views     bigint not null default 0 check (total_views >= 0),
  last_viewed_at  timestamptz
);

-- 공개 이동 1회 기록 (일자별 + 총계를 한 문장으로)
create or replace function bzup.record_link_view(p_link_id uuid) returns void
language sql as $$
  with d as (
    insert into bzup.link_daily_views (link_id, view_date, views)
    values (p_link_id, (now() at time zone 'Asia/Seoul')::date, 1)
    on conflict (link_id, view_date) do update set views = bzup.link_daily_views.views + 1
    returning 1
  )
  insert into bzup.link_view_totals (link_id, total_views, last_viewed_at)
  values (p_link_id, 1, now())
  on conflict (link_id) do update
    set total_views = bzup.link_view_totals.total_views + 1, last_viewed_at = excluded.last_viewed_at;
$$;

-- 2) 시스템 API 연동: 회사당 1개, 시스템이 발급한 키로 외부 API 를 호출한다
alter table bzup.api_clients add column is_system boolean not null default false;
create unique index api_clients_one_system on bzup.api_clients (workspace_id)
  where is_system and status <> 'deleted';

-- 3) 만료 기록 정리 (배치 단위로 짧게 삭제)
--    - idempotency_records: 성공 후 24시간 보관 (§16.5)
--    - generation_reviews : 발급 후 24시간 보관 (§15.7)
--    - rate_windows       : 1분 윈도우, 1시간 지난 카운터
create or replace function bzup.cleanup_expired(p_batch integer default 5000)
returns table (idempotency_deleted integer, reviews_deleted integer, rate_windows_deleted integer)
language plpgsql as $$
declare
  a integer; b integer; c integer;
begin
  with x as (
    select id from bzup.idempotency_records where expires_at < now() limit p_batch
  ) delete from bzup.idempotency_records r using x where r.id = x.id;
  get diagnostics a = row_count;

  with x as (
    select id from bzup.generation_reviews
     where created_at < now() - interval '24 hours' and expires_at < now() limit p_batch
  ) delete from bzup.generation_reviews r using x where r.id = x.id;
  get diagnostics b = row_count;

  with x as (
    select bucket, window_start from bzup.rate_windows
     where window_start < now() - interval '1 hour' limit p_batch
  ) delete from bzup.rate_windows r using x where r.bucket = x.bucket and r.window_start = x.window_start;
  get diagnostics c = row_count;

  return query select a, b, c;
end $$;

create index rate_windows_window_start on bzup.rate_windows (window_start);
