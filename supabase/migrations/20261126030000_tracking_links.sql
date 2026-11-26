-- 트래킹 링크: 엑셀(추천코드·진행매체·URL)로 강의별 짧은 주소 일괄 발급
-- 업로드한 엑셀 파일은 저장하지 않는다(서버 메모리에서 읽고 버림). 변환 결과만 보관한다.

-- 업로드 1회 기록
create table bzup.tracking_uploads (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references bzup.workspaces(id),
  course_id       uuid not null,
  file_name       text not null check (char_length(file_name) between 1 and 255),
  total_rows      integer not null check (total_rows >= 0),
  created_count   integer not null check (created_count >= 0),
  skipped_count   integer not null check (skipped_count >= 0),
  error_count     integer not null check (error_count >= 0),
  actor_id        uuid not null,
  actor_label     text not null,
  request_id      text,
  created_at      timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, course_id) references bzup.courses(workspace_id, id)
);
create index tracking_uploads_ws_course on bzup.tracking_uploads (workspace_id, course_id, created_at desc);

-- 변환해서 만든 트래킹 링크 (강의 + 정규화 URL 당 1개)
create table bzup.tracking_links (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null,
  course_id              uuid not null,
  upload_id              uuid not null,
  link_id                uuid not null unique,
  row_number             integer not null check (row_number >= 1),
  referral_code          text not null check (char_length(referral_code) between 1 and 100),
  media                  text not null check (char_length(media) between 1 and 100),
  destination_url        text not null check (octet_length(destination_url) <= 8192),
  canonical_destination  text not null,
  created_at             timestamptz not null default now(),
  foreign key (workspace_id, course_id) references bzup.courses(workspace_id, id),
  foreign key (workspace_id, upload_id) references bzup.tracking_uploads(workspace_id, id),
  foreign key (workspace_id, link_id) references bzup.links(workspace_id, id)
);
create index tracking_links_ws_course on bzup.tracking_links (workspace_id, course_id, created_at desc, row_number);
create index tracking_links_course_canonical on bzup.tracking_links (workspace_id, course_id, canonical_destination);
