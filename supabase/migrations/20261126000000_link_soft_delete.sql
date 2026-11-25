-- 링크 삭제 (상세 화면 위험 구역)
-- 행은 남기고 deleted_at 으로 표시한다: 변경 이력·조회수·감사 기록이 링크를 참조하고, 짧은 코드는 재사용하지 않는다.
alter table bzup.links
  add column deleted_at       timestamptz,
  add column deleted_by_label text;

-- 삭제된 링크는 강의·type 1개 제한에서 빠진다 (같은 type 으로 다시 만들 수 있음)
drop index bzup.links_course_type_unique;
create unique index links_course_type_unique
  on bzup.links (workspace_id, course_id, link_type)
  where link_type is not null and deleted_at is null;

alter table bzup.link_revisions drop constraint link_revisions_action_check;
alter table bzup.link_revisions add constraint link_revisions_action_check
  check (action in ('created','updated','deleted'));
