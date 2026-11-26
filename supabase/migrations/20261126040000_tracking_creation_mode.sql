-- 트래킹 링크: 유형(type_key) 없이 생성 방식 creation_mode = 'tracking' 으로 구분하고,
-- 같은 강의 안에서 원본 주소(정규화 URL)당 1개만 허용한다. 삭제된 링크는 규칙에서 빠진다.
-- 일반(single)·자동생성(batch)·유형 링크에는 적용하지 않는다.

alter table bzup.links drop constraint links_creation_mode_check;
alter table bzup.links add constraint links_creation_mode_check
  check (creation_mode in ('single','batch','tracking'));

-- 이미 만든 트래킹 링크의 생성 방식 보정 (creation_mode 는 불변 필드라 이 갱신에서만 보호 트리거를 끈다)
alter table bzup.links disable trigger links_guard_immutable;
update bzup.links l set creation_mode = 'tracking'
  from bzup.tracking_links t
 where t.link_id = l.id and l.creation_mode = 'single';
alter table bzup.links enable trigger links_guard_immutable;

-- 강의 + 원본 주소당 트래킹 링크 1개. URL 원문(최대 8KB)은 색인 한도를 넘을 수 있어
-- canonical 의 SHA-256(destination_fingerprint)으로 판별한다.
create unique index links_tracking_course_url_unique
  on bzup.links (workspace_id, course_id, destination_fingerprint)
  where creation_mode = 'tracking' and deleted_at is null;
