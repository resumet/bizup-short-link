-- 자동생성(이름 목록·일괄 생성) 기능 제거에 따른 DB 정리
-- 자동생성으로 만든 링크가 남아 있으면 중단한다 (링크를 지우지 않는다)
do $$
begin
  if exists (select 1 from bzup.links where creation_mode = 'batch' or generation_batch_id is not null) then
    raise exception '자동생성으로 만든 링크가 있어 정리를 중단합니다. 먼저 해당 링크를 처리해 주세요.';
  end if;
end $$;

-- 1) 링크 불변 필드 보호에서 generation_batch_id 제거 (컬럼 삭제 전에 교체)
create or replace function bzup.links_guard_immutable() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.workspace_id is distinct from old.workspace_id
     or new.short_code is distinct from old.short_code
     or new.issued_domain is distinct from old.issued_domain
     or new.initial_destination_url is distinct from old.initial_destination_url
     or new.external_ref is distinct from old.external_ref
     or new.source is distinct from old.source
     or new.creation_mode is distinct from old.creation_mode
     or new.created_at is distinct from old.created_at
     or new.created_by_type is distinct from old.created_by_type
     or new.created_by_id is distinct from old.created_by_id then
    raise exception 'immutable link field change rejected' using errcode = '23514';
  end if;
  if old.course_id is not null and new.course_id is null then
    raise exception 'link course cannot be cleared' using errcode = '23514';
  end if;
  return new;
end $$;

-- 2) 자동생성 참조 컬럼 (외래키·검사 제약·색인은 컬럼과 함께 삭제됨)
alter table bzup.links drop column generation_batch_id;
alter table bzup.link_revisions drop column generation_batch_id;
alter table bzup.idempotency_records drop column result_batch_id;

-- 3) 생성 방식에서 'batch' 제거
alter table bzup.links drop constraint links_creation_mode_check;
alter table bzup.links add constraint links_creation_mode_check check (creation_mode in ('single','tracking'));

-- 4) 자동생성 테이블·함수
drop table bzup.generation_batch_items;
drop table bzup.generation_batches;
drop table bzup.generation_template_revisions;
drop table bzup.generation_template_items;
drop table bzup.generation_templates;
drop function if exists bzup.ensure_default_template_item(uuid);
