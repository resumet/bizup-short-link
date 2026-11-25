-- 짧은 주소 유형(type): 4자리 숫자 0000~9999
-- 한 강의(course_id)에는 유형별로 짧은 주소 1개만 존재한다.
alter table bzup.links
  add column link_type char(4) check (link_type is null or link_type ~ '^[0-9]{4}$');

create unique index links_course_type_unique
  on bzup.links (workspace_id, course_id, link_type)
  where link_type is not null;
