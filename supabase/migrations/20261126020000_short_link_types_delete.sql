-- 유형 관리 화면: 한 번도 쓰이지 않은 유형만 제거 허용
-- 링크가 참조하는 유형은 외래키(links.type_key)가 삭제를 막는다 → 비활성화를 사용한다.
create or replace function bzup.short_link_types_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.key is distinct from old.key or new.created_at is distinct from old.created_at then
    raise exception 'short link type key is immutable' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
