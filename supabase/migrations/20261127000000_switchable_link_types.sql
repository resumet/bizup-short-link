-- 전환형 짧은 주소 유형
-- 유형에 전환 주소 구성(키·표시 이름 2~5개)을 정해 두면, 그 유형으로 만든 링크는 전환 주소를 갖는다.
-- 예: free_chat(무료단톡방) = chat 단톡방 / youtube 유튜브 라이브 / zoom 줌 라이브
-- 첫 번째 주소만 필수이고 나머지는 비워 두었다가 나중에 채운다. 지금 연결 중인 주소는 항상 채워져 있다.

-- 1) 유형의 전환 주소 구성: [{ "key": "chat", "label": "단톡방" }, ...] (null = 일반 유형)
alter table bzup.short_link_types add column slots jsonb;
alter table bzup.short_link_types add constraint short_link_types_slots_check check (
  slots is null
  or (jsonb_typeof(slots) = 'array' and jsonb_array_length(slots) between 2 and 5)
);

-- 2) 링크 전환 주소의 키 (유형으로 만든 링크만. 이름 목록 자동생성 링크는 null)
alter table bzup.link_destination_slots add column slot_key text
  check (slot_key is null or slot_key ~ '^[a-z][a-z0-9_]{0,31}$');
create unique index link_destination_slots_key_unique
  on bzup.link_destination_slots (link_id, slot_key) where slot_key is not null;

-- 3) 기본 전환형 유형
insert into bzup.short_link_types (key, label, active, slots) values
  ('free_chat', '무료단톡방', true,
   '[{"key":"chat","label":"단톡방"},{"key":"youtube","label":"유튜브 라이브"},{"key":"zoom","label":"줌 라이브"}]'::jsonb)
on conflict (key) do nothing;
