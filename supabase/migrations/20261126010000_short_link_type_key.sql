-- 짧은 주소 유형: 4자리 숫자 type → 문자열 type_key (docs/short-link-api-type-key-request.md)
-- 테스트 기간 결정: 기존 발급 링크 전체와 링크 종속 데이터를 삭제하고 새 방식으로 다시 발급한다.
-- 의도된 비가역 삭제다. 롤백해도 삭제된 주소는 복원되지 않는다.
-- 강의·직원·API 키·이름 목록·감사 기록·코드 원장(bzup_ledger)은 삭제하지 않는다.
--   (코드 원장을 남겨 삭제된 짧은 코드가 다시 발급되지 않게 한다)

-- 1) 링크 종속 데이터 정리 (참조 순서대로, CASCADE 미사용)
delete from bzup.generation_batch_items;
delete from bzup.link_destination_slots;
delete from bzup.link_daily_views;
delete from bzup.link_view_totals;

alter table bzup.link_revisions disable trigger link_revisions_append_only;
delete from bzup.link_revisions;
alter table bzup.link_revisions enable trigger link_revisions_append_only;

-- 링크 생성·수정 멱등성 기록(구형 숫자 type 요청의 캐시된 응답 포함)과 중복 확인 토큰
delete from bzup.idempotency_records
 where result_link_id is not null
    or route like '/links%' or route like '/link-batches%' or route like '/short-links%';
delete from bzup.generation_reviews;

alter table bzup.links disable trigger links_no_delete;
delete from bzup.links;
alter table bzup.links enable trigger links_no_delete;

delete from bzup.generation_batches;

-- 2) 숫자 type 전용 컬럼·제약·인덱스 제거
drop index if exists bzup.links_course_type_unique;
alter table bzup.links drop column if exists link_type;

-- 3) 유형 모델: key 고유·변경 불가, label 변경 가능, 삭제 대신 비활성화
create table if not exists bzup.short_link_types (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  label       text not null check (label = btrim(label) and char_length(label) between 1 and 120),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create or replace function bzup.short_link_types_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'short link types cannot be deleted; deactivate instead' using errcode = '42501';
  end if;
  if new.key is distinct from old.key or new.created_at is distinct from old.created_at then
    raise exception 'short link type key is immutable' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists short_link_types_guard on bzup.short_link_types;
create trigger short_link_types_guard before update or delete on bzup.short_link_types
  for each row execute function bzup.short_link_types_guard();

insert into bzup.short_link_types (key, label, active) values
  ('landing', '기본 랜딩 QR', true),
  ('payment', '결제페이지 QR', true)
on conflict (key) do nothing;

-- 4) 링크의 유형 참조: 같은 강의에는 유형별 링크 1개 (삭제된 링크 제외)
alter table bzup.links add column type_key text references bzup.short_link_types(key);
create unique index links_course_type_key_unique
  on bzup.links (workspace_id, course_id, type_key)
  where type_key is not null and deleted_at is null;
