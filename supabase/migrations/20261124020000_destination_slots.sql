-- 전환 주소(destination slots)
-- 짧은 주소 1개에 이름 붙은 목적지 후보를 여러 개 두고, 현재 연결 대상을 전환한다.
-- 예: 단톡방 → 라이브 유튜브 → 앵콜 줌. 공개 이동은 links.destination_url 만 읽는다.

-- 1) 이름 목록 항목: 전환 주소 라벨 목록 (null = 일반 단일 주소 항목). 첫 라벨이 기본 연결.
alter table bzup.generation_template_items add column destination_slots jsonb;
alter table bzup.generation_template_items add constraint generation_template_items_slots_check check (
  destination_slots is null
  or (jsonb_typeof(destination_slots) = 'array' and jsonb_array_length(destination_slots) between 2 and 5)
);

-- 2) 링크별 전환 주소
create table bzup.link_destination_slots (
  link_id          uuid not null references bzup.links(id),
  position         smallint not null check (position between 0 and 4),
  label            text not null check (char_length(label) between 1 and 40),
  destination_url  text check (destination_url is null or octet_length(destination_url) <= 8192),
  updated_at       timestamptz not null default now(),
  primary key (link_id, position)
);

alter table bzup.links add column active_slot smallint check (active_slot is null or active_slot between 0 and 4);

-- 3) 기본 이름 목록 항목
create or replace function bzup.ensure_default_template_item(p_template_id uuid) returns void
language plpgsql as $$
declare
  v_ws uuid;
  v_version integer;
begin
  select workspace_id into v_ws from bzup.generation_templates where id = p_template_id for update;
  if v_ws is null then return; end if;
  if exists (select 1 from bzup.generation_template_items where template_id = p_template_id
              and name = '단톡방-라이브유튜브-앵콜줌') then
    return;
  end if;
  -- 맨 앞에 추가
  update bzup.generation_template_items set sort_order = sort_order + 1, updated_at = now() where template_id = p_template_id;
  insert into bzup.generation_template_items (workspace_id, template_id, name, sort_order, is_active, destination_slots)
  values (v_ws, p_template_id, '단톡방-라이브유튜브-앵콜줌', 1, true, '["단톡방","라이브 유튜브","앵콜 줌"]'::jsonb);
  update bzup.generation_templates set version = version + 1, updated_at = now() where id = p_template_id
  returning version into v_version;
  insert into bzup.generation_template_revisions (workspace_id, template_id, version, ordered_items_snapshot, request_id)
  select v_ws, p_template_id, v_version,
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'sort_order', sort_order, 'destination_slots', destination_slots)
                            order by sort_order), '[]'::jsonb),
         'system:default-item'
    from bzup.generation_template_items where template_id = p_template_id and is_active;
end $$;

-- 기존 회사 목록에도 기본 항목을 추가한다
select bzup.ensure_default_template_item(id) from bzup.generation_templates;
