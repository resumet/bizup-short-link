-- 전환형 짧은 주소는 free_chat 유형 하나로 제한한다.
-- 같은 강의·유형 1개 제한(links_course_type_key_unique)과 합쳐, 한 강의의 전환형 링크는 free_chat 1개뿐이다.
update bzup.short_link_types set slots = null
 where key <> 'free_chat' and slots is not null
   and not exists (select 1 from bzup.links l where l.type_key = short_link_types.key);
alter table bzup.short_link_types add constraint short_link_types_switchable_only_free_chat
  check (slots is null or key = 'free_chat');
