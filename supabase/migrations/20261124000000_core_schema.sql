-- BZUP Link — core schema (PRD v2.2 §15)
-- 업무 테이블은 PostgREST로 노출되지 않는 private schema `bzup`에 둔다 (§18.4).
-- 브라우저는 업무 테이블을 직접 읽거나 쓰지 않으며, 서버만 DB 자격증명으로 접근한다.

create schema if not exists bzup;

-- ---------------------------------------------------------------------------
-- 회사·서비스 주소 정책
-- ---------------------------------------------------------------------------
create table bzup.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  created_at  timestamptz not null default now()
);

create table bzup.service_domains (
  id                    uuid primary key default gen_random_uuid(),
  service_namespace_id  uuid not null,
  hostname              text not null unique
                        check (hostname = lower(hostname) and hostname !~ '\.$' and hostname <> ''),
  status                text not null check (status in ('pending','active','retired')),
  kind                  text not null check (kind in ('vercel_production','custom','development')),
  verified_at           timestamptz,
  activated_at          timestamptz,
  created_at            timestamptz not null default now(),
  unique (service_namespace_id, id)
);

create table bzup.service_settings (
  service_namespace_id  uuid primary key,
  workspace_id          uuid not null references bzup.workspaces(id),
  primary_domain_id     uuid not null,
  url_config_version    integer not null default 1 check (url_config_version >= 1),
  updated_by            uuid,
  updated_at            timestamptz not null default now(),
  foreign key (service_namespace_id, primary_domain_id)
    references bzup.service_domains(service_namespace_id, id)
);

-- 운영 서비스당 1행
create unique index service_settings_singleton on bzup.service_settings ((true));

-- ---------------------------------------------------------------------------
-- 직원·초대 (§3, §15.2)
-- ---------------------------------------------------------------------------
create table bzup.workspace_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references bzup.workspaces(id),
  user_id       uuid not null,                     -- auth.users.id
  display_name  text not null check (char_length(display_name) between 1 and 80),
  email         text not null,                     -- 표시용 사본, 계정 연결의 근거가 아님
  role          text not null check (role in ('owner','editor','viewer')),
  status        text not null check (status in ('invited','onboarding','active','suspended')),
  invited_at    timestamptz,
  joined_at     timestamptz,
  suspended_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       integer not null default 1 check (version >= 1),
  unique (workspace_id, user_id),
  unique (workspace_id, id)
);

create table bzup.employee_invitations (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references bzup.workspaces(id),
  normalized_email       text not null check (normalized_email = lower(btrim(normalized_email))),
  display_name           text not null check (char_length(display_name) between 1 and 80),
  intended_role          text not null check (intended_role in ('owner','editor','viewer')),
  status                 text not null check (status in ('pending','sending','sent','failed','accepted','revoked')),
  invited_by             uuid not null,
  auth_user_id           uuid,
  member_id              uuid,
  delivery_requested_at  timestamptz,
  last_error_code        text,
  accepted_at            timestamptz,
  expires_at             timestamptz,
  request_id             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- 같은 이메일의 진행 중 초대는 1건
create unique index employee_invitations_active_email
  on bzup.employee_invitations (workspace_id, normalized_email)
  where status in ('pending','sending','sent','failed');

-- ---------------------------------------------------------------------------
-- 강의 (§4, §15.3)
-- ---------------------------------------------------------------------------
create table bzup.courses (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references bzup.workspaces(id),
  name             text not null check (char_length(name) between 1 and 120),
  instructor_name  text check (instructor_name is null or char_length(instructor_name) <= 80),
  memo             text check (memo is null or char_length(memo) <= 500),
  status           text not null check (status in ('active','closed')),
  version          integer not null default 1 check (version >= 1),
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, id)
);
create index courses_ws_status_name on bzup.courses (workspace_id, status, name);

-- ---------------------------------------------------------------------------
-- API 연동·키 (§13.6~13.14, §15.8)
-- ---------------------------------------------------------------------------
create table bzup.api_clients (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references bzup.workspaces(id),
  name               text not null check (char_length(name) between 1 and 80),
  memo               text check (memo is null or char_length(memo) <= 300),
  status             text not null check (status in ('active','suspended','deleted')),
  default_course_id  uuid,
  version            integer not null default 1 check (version >= 1),
  created_by         uuid not null,
  created_at         timestamptz not null default now(),
  updated_by         uuid,
  updated_at         timestamptz not null default now(),
  suspended_by       uuid,
  suspended_at       timestamptz,
  deleted_by         uuid,
  deleted_at         timestamptz,
  change_reason      text,
  unique (workspace_id, id),
  foreign key (workspace_id, default_course_id) references bzup.courses(workspace_id, id)
);

create table bzup.api_keys (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  api_client_id        uuid not null,
  name                 text not null check (char_length(name) between 1 and 80),
  memo                 text check (memo is null or char_length(memo) <= 300),
  public_id            text not null unique check (public_id ~ '^[A-Za-z0-9_-]{22}$'),
  environment          text not null check (environment in ('live','test')),
  key_prefix           text not null,
  secret_hash          bytea,
  hash_algorithm       text not null default 'sha256' check (hash_algorithm = 'sha256'),
  scopes               text[] not null,
  status               text not null check (status in ('active','suspended','revoked')),
  expires_at           timestamptz not null,
  scheduled_revoke_at  timestamptz,
  rotation_of_key_id   uuid,
  rotation_reason      text,
  version              integer not null default 1 check (version >= 1),
  created_by           uuid not null,
  created_at           timestamptz not null default now(),
  updated_by           uuid,
  updated_at           timestamptz not null default now(),
  last_used_at         timestamptz,
  suspended_by         uuid,
  suspended_at         timestamptz,
  revoked_by           uuid,
  revoked_at           timestamptz,
  revoke_reason        text,
  deleted_by           uuid,
  deleted_at           timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, api_client_id) references bzup.api_clients(workspace_id, id),
  foreign key (workspace_id, rotation_of_key_id) references bzup.api_keys(workspace_id, id),
  check (expires_at > created_at),
  check (cardinality(scopes) between 1 and 4),
  check (scopes <@ array['links:create','links:read','links:update','courses:read']::text[]),
  -- 유효 active/suspended 키에는 해시가 있어야 하고, 삭제된 키에는 해시가 없어야 한다.
  check (status = 'revoked' or secret_hash is not null),
  check (deleted_at is null or (secret_hash is null and status = 'revoked')),
  check (status <> 'revoked' or revoked_at is not null)
);
create index api_keys_ws_client on bzup.api_keys (workspace_id, api_client_id);
create index api_keys_ws_status_exp on bzup.api_keys (workspace_id, status, expires_at);

-- scopes 배열의 중복 금지
create or replace function bzup.array_has_no_duplicates(text[]) returns boolean
language sql immutable as $$
  select count(*) = count(distinct x) from unnest($1) as x
$$;
alter table bzup.api_keys add constraint api_keys_scopes_distinct
  check (bzup.array_has_no_duplicates(scopes));

create table bzup.api_key_issue_requests (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references bzup.workspaces(id),
  actor_user_id            uuid not null,
  method                   text not null,
  canonical_route          text not null,
  request_key_hash         bytea not null,
  normalized_request_hash  bytea not null,
  api_client_id            uuid not null,
  result_key_id            uuid not null,
  rotation_of_key_id       uuid,
  created_at               timestamptz not null default now(),
  unique (workspace_id, actor_user_id, method, canonical_route, request_key_hash)
);

-- ---------------------------------------------------------------------------
-- 자동생성 이름 목록 (§7, §15.6)
-- ---------------------------------------------------------------------------
create table bzup.generation_templates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null unique references bzup.workspaces(id),  -- 회사당 1행
  display_name  text not null default '자동생성 기본 목록',
  version       integer not null default 1 check (version >= 1),
  updated_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, id)
);

create table bzup.generation_template_items (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  template_id   uuid not null,
  name          text not null check (char_length(name) between 1 and 120),
  sort_order    integer not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (workspace_id, template_id) references bzup.generation_templates(workspace_id, id)
);
create index generation_template_items_tpl on bzup.generation_template_items (template_id, sort_order, id);

create table bzup.generation_template_revisions (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null,
  template_id             uuid not null,
  version                 integer not null,
  ordered_items_snapshot  jsonb not null,
  actor_user_id           uuid,
  request_id              text,
  created_at              timestamptz not null default now(),
  unique (template_id, version)
);

-- ---------------------------------------------------------------------------
-- 링크·이력 (§5, §11, §15.4~15.5)
-- ---------------------------------------------------------------------------
create table bzup.generation_batches (
  id                           uuid primary key default gen_random_uuid(),
  workspace_id                 uuid not null,
  course_id                    uuid not null,
  template_id                  uuid not null,
  template_version             integer not null,
  issued_domain_snapshot       text not null,
  url_config_version_snapshot  integer not null,
  count                        integer not null check (count between 1 and 100),
  source                       text not null check (source in ('web','api')),
  actor_type                   text not null check (actor_type in ('user','api_client')),
  actor_id                     uuid not null,
  actor_label_snapshot         text not null,
  api_key_id                   uuid,
  request_id                   text,
  status                       text not null default 'succeeded' check (status = 'succeeded'),
  created_at                   timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, course_id) references bzup.courses(workspace_id, id)
);

create table bzup.links (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references bzup.workspaces(id),
  issued_domain            text not null,
  short_code               text not null unique check (short_code ~ '^[0-9A-Za-z]{7}$'),
  name                     text not null check (char_length(name) between 1 and 120),
  initial_destination_url  text not null check (octet_length(initial_destination_url) <= 8192),
  destination_url          text not null check (octet_length(destination_url) <= 8192),
  canonical_destination    text not null,
  destination_fingerprint  bytea not null,
  course_id                uuid,
  external_ref             text check (external_ref is null or external_ref ~ '^[A-Za-z0-9._:-]{1,200}$'),
  status                   text not null check (status in ('active','inactive')),
  version                  integer not null default 1 check (version >= 1),
  source                   text not null check (source in ('web','api')),
  creation_mode            text not null check (creation_mode in ('single','batch')),
  generation_batch_id      uuid,
  created_by_type          text not null check (created_by_type in ('user','api_client','system')),
  created_by_id            uuid,
  created_by_label         text,
  created_api_key_id       uuid,
  updated_by_type          text not null check (updated_by_type in ('user','api_client','system')),
  updated_by_id            uuid,
  updated_by_label         text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, external_ref),
  foreign key (workspace_id, course_id) references bzup.courses(workspace_id, id),
  foreign key (workspace_id, generation_batch_id) references bzup.generation_batches(workspace_id, id),
  check ((creation_mode = 'batch') = (generation_batch_id is not null))
);
create index links_ws_fingerprint on bzup.links (workspace_id, destination_fingerprint);
create index links_ws_course_created on bzup.links (workspace_id, course_id, created_at desc, id desc);
create index links_ws_status_created on bzup.links (workspace_id, status, created_at desc, id desc);
create index links_ws_created on bzup.links (workspace_id, created_at desc, id desc);
create index links_ws_batch on bzup.links (workspace_id, generation_batch_id);

-- 불변 필드 방어 (§15.4)
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
     or new.generation_batch_id is distinct from old.generation_batch_id
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
create trigger links_guard_immutable before update on bzup.links
  for each row execute function bzup.links_guard_immutable();

create or replace function bzup.reject_delete() returns trigger
language plpgsql as $$
begin
  raise exception '% rows cannot be deleted', tg_table_name using errcode = '42501';
end $$;
create trigger links_no_delete before delete on bzup.links
  for each row execute function bzup.reject_delete();

create table bzup.link_revisions (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  link_id              uuid not null,
  version              integer not null check (version >= 1),
  action               text not null check (action in ('created','updated')),
  changed_fields       text[] not null,
  before_snapshot      jsonb,
  after_snapshot       jsonb not null,
  actor_type           text not null check (actor_type in ('user','api_client','system')),
  actor_id             uuid,
  actor_label_snapshot text,
  api_key_id           uuid,
  generation_batch_id  uuid,
  request_id           text,
  reason               text check (reason is null or char_length(reason) <= 500),
  created_at           timestamptz not null default now(),
  unique (link_id, version),
  foreign key (workspace_id, link_id) references bzup.links(workspace_id, id),
  check ((action = 'created') = (before_snapshot is null))
);

-- 이력은 append-only
create or replace function bzup.reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
create trigger link_revisions_append_only before update or delete on bzup.link_revisions
  for each row execute function bzup.reject_mutation();

create table bzup.generation_batch_items (
  batch_id                  uuid not null references bzup.generation_batches(id),
  template_item_id          uuid not null,
  link_id                   uuid not null unique references bzup.links(id),
  name_snapshot             text not null,
  destination_url_snapshot  text not null,
  short_url_snapshot        text not null,
  sort_order                integer not null,
  primary key (batch_id, template_item_id)
);

-- ---------------------------------------------------------------------------
-- 중복 검토 토큰 (§6, §14.2, §15.7)
-- ---------------------------------------------------------------------------
create table bzup.generation_reviews (
  id                         uuid primary key default gen_random_uuid(),
  token_hash                 bytea not null unique,
  workspace_id               uuid not null,
  principal_type             text not null check (principal_type in ('user','api_client')),
  principal_id               uuid not null,
  mode                       text not null check (mode in ('single','batch')),
  normalized_input_hash      bytea not null,
  resolved_course_id         uuid not null,
  template_id                uuid,
  template_version           integer,
  existing_duplicate_digest  bytea not null,
  internal_duplicate_groups  jsonb not null default '[]'::jsonb,
  preview_snapshot           jsonb not null default '{}'::jsonb,
  expires_at                 timestamptz not null,
  consumed_at                timestamptz,
  consumed_by_operation_id   text,
  created_at                 timestamptz not null default now()
);
create index generation_reviews_created on bzup.generation_reviews (created_at);

-- ---------------------------------------------------------------------------
-- 멱등성·호출 제한·감사 (§16.5, §17.2, §13.14)
-- ---------------------------------------------------------------------------
create table bzup.idempotency_records (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null,
  principal_type           text not null check (principal_type in ('user','api_client')),
  principal_id             uuid not null,
  method                   text not null,
  route                    text not null,
  key_hash                 bytea not null,
  normalized_request_hash  bytea not null,
  resolved_course_id       uuid,
  response_status          integer not null,
  response_body            text,        -- 최초 응답 본문을 바이트 그대로 재생하기 위해 text
  response_headers         jsonb not null default '{}'::jsonb,
  result_link_id           uuid,
  result_batch_id          uuid,
  result_object_type       text,
  result_object_id         uuid,
  created_at               timestamptz not null default now(),
  expires_at               timestamptz not null,
  unique (workspace_id, principal_type, principal_id, method, route, key_hash)
);
create index idempotency_records_expires on bzup.idempotency_records (expires_at);

create table bzup.rate_windows (
  bucket        text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (bucket, window_start)
);

create table bzup.admin_audit_events (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  actor_type     text not null check (actor_type in ('user','api_client','system')),
  actor_user_id  uuid,
  api_client_id  uuid,
  api_key_id     uuid,
  object_type    text not null,
  object_id      uuid,
  action         text not null,
  before_data    jsonb,
  after_data     jsonb,
  reason         text,
  request_id     text,
  created_at     timestamptz not null default now()
);
create index admin_audit_events_obj on bzup.admin_audit_events (workspace_id, object_type, object_id, created_at desc);
create trigger admin_audit_events_append_only before update or delete on bzup.admin_audit_events
  for each row execute function bzup.reject_mutation();

-- ---------------------------------------------------------------------------
-- 개발·테스트용 코드 예약 원장 (§15.8)
-- 운영은 DB 복원과 독립된 조건부 신규 쓰기 저장소(S3 If-None-Match)를 사용한다.
-- 이 테이블은 CODE_LEDGER_DRIVER=postgres 일 때만 사용하며, 별도 schema로 분리한다.
-- ---------------------------------------------------------------------------
create schema if not exists bzup_ledger;
create table bzup_ledger.code_reservations (
  service_namespace_id  uuid not null,
  short_code            text not null,
  link_id               uuid not null,
  workspace_id          uuid not null,
  reserved_at           timestamptz not null default now(),
  primary key (service_namespace_id, short_code)
);
create trigger code_reservations_append_only before update or delete on bzup_ledger.code_reservations
  for each row execute function bzup.reject_mutation();
