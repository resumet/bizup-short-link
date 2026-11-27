# BZUP Link

짧은 주소·강의별 링크 관리 서비스입니다. 요구사항 기준 문서는 [docs/bzup_io_short_link_management_PRD_v2.2.md](docs/bzup_io_short_link_management_PRD_v2.2.md)입니다.

## 구성

| 구성 | 선택 |
|---|---|
| 관리 웹·API | Next.js 15 (App Router) + TypeScript |
| 업무 DB | Supabase PostgreSQL, private schema `bzup` |
| 로그인 | Supabase Auth (서버 BFF 세션, HttpOnly 쿠키) |
| 코드 원장 | 운영 S3 조건부 쓰기(`If-None-Match: *`), 개발 `bzup_ledger` 테이블 |
| 테스트 | Vitest + PGlite(WASM Postgres) |

## 경로

| 경로 | 처리 | 인증 |
|---|---|---|
| `/{short_code}` | 공개 302 이동 | 없음 |
| `/api/v1/**` | 외부 API | `Authorization: Bearer bzup_live_…` + scope |
| `/internal/**` | 직원 웹 API | Supabase 세션 + 역할 + CSRF |
| `/links`, `/admin/**` | 관리 화면 | 직원 세션 |

## 개발

```bash
npm install
npm test            # 단위 + PGlite 통합 테스트
npm run typecheck
npm run build
```

### 로컬 실행 (Supabase 없이)

```bash
npm run dev:db      # 터미널 1: 로컬 PostgreSQL + 마이그레이션
npm run db:migrate  # 실행 중인 DB 에 새 마이그레이션 적용
npm run bootstrap   # 최초 1회
npm run dev:seed    # 강의·이름 목록·테스트 API 키
npm run dev:staff   # 개발 직원 계정 (owner/editor/viewer/중지)
npm run dev         # 터미널 2: http://localhost:3000/login
```

### DB 준비

1. `supabase/migrations/*.sql`을 Supabase 프로젝트에 적용합니다 (`supabase db push` 또는 SQL Editor).
2. `.env.example`을 `.env.local`로 복사해 값을 채웁니다.
3. 최초 owner로 지정할 Auth 사용자를 만든 뒤 UUID를 `INITIAL_OWNER_USER_ID`에 넣고 실행합니다.

```bash
npm run bootstrap
```

서비스 설정이 이미 있으면 주소 설정을 덮어쓰지 않습니다.

## 운영 배포 (도메인 `bizup.im`)

짧은 주소는 `https://bizup.im/{7자리 코드}` 형태로 발급되고, 관리 화면도 같은 도메인(`https://bizup.im/links`)을 씁니다.
기본 주소는 DB(`service_domains`, `service_settings`)에 저장되며 **최초 bootstrap 때 한 번만** 정해집니다.
`*.vercel.app` 주소로 먼저 bootstrap 하면 그 주소로 짧은 주소가 발급되므로, 처음부터 `INITIAL_PRIMARY_ORIGIN=https://bizup.im` 으로 실행합니다.

1. **Vercel**: GitHub 저장소를 Import → Settings → Domains 에 `bizup.im` 추가 (`www.bizup.im` 은 `bizup.im` 으로 리다이렉트 권장).
2. **DNS** (도메인 구입처 관리 화면): Vercel Domains 화면에 표시되는 값을 그대로 등록합니다.
   - `bizup.im` (apex): A 레코드 → Vercel 이 안내하는 IP (보통 `76.76.21.21`)
   - `www`: CNAME → Vercel 이 안내하는 값 (보통 `cname.vercel-dns.com`)
   - 또는 네임서버를 Vercel 네임서버로 변경
3. **Supabase 프로젝트**: 리전은 서울(`ap-northeast-2`) 권장 (Vercel 함수 리전 `icn1` 과 맞춤, `vercel.json`).
4. **환경변수 파일** (둘 다 `.gitignore` 대상, 로컬에만 보관)
   - `.env.vercel`: Vercel 런타임 값. `<...>` 를 Supabase 값으로 채운 뒤 Vercel → Settings → Environment Variables → Import .env 로 올립니다.
   - `.env.prod-admin`: 운영 DB 초기 설정용(마이그레이션 주소, 최초 최고관리자). Vercel 에 올리지 않습니다.
   - `DEV_AUTH`·`DEV_AUTH_SECRET`·`DEV_LOGIN_PASSWORD` 는 운영에 넣지 않습니다.
5. **Supabase Auth 설정**
   - Authentication → URL Configuration: Site URL `https://bizup.im`, Redirect URLs `https://bizup.im/**`
   - Authentication → Sign In / Providers: **Allow new users to sign up 끄기** (직원은 초대로만 가입)
   - Authentication → Emails → SMTP: 커스텀 SMTP 설정 (기본 SMTP 는 발송량 제한이 있어 운영 불가, §3.7)
   - Authentication → Emails → Templates: 링크를 서버 검증 경로로 변경
     - **Invite user**: `<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite">초대 수락하기</a>`
     - **Reset Password**: `<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery">비밀번호 재설정</a>`
6. **최초 최고관리자**: Authentication → Users → Add user → Create new user (이메일·비밀번호, Auto Confirm User 체크) → User UID 를 `.env.prod-admin` 의 `INITIAL_OWNER_USER_ID` 에 입력.
7. **운영 DB 초기화** (내 PC에서)
   ```bash
   npm run db:migrate:prod   # 마이그레이션 적용 (Session pooler 5432)
   npm run bootstrap:prod    # 회사·도메인 bizup.im·이름 목록·최초 최고관리자
   ```
8. **Vercel 배포** 후 확인: `https://bizup.im/login` 로그인 → `/admin/employees` 에서 직원 초대 → 링크 생성 → 발급된 `https://bizup.im/xxxxxxx` 가 302 로 이동하는지 확인.

### 로그인·초대 흐름

| 흐름 | 경로 |
|---|---|
| 로그인 | `/login` → `POST /auth/login` (서버가 Supabase 세션을 HttpOnly 쿠키로 발급, 멤버십 확인) |
| 직원 초대 | `/admin/employees` → Auth Admin 초대 메일 → `/auth/confirm?type=invite` → `/login/confirm` (버튼을 눌러야 토큰 사용, 메일 검사기 선클릭 대비) → `/account/setup` (이름·비밀번호) → 활성 |
| 기존 Auth 계정 초대 | 메일 없이 계정 연결(초기 설정 대기) → 그 계정으로 로그인 → `/account/setup` → 활성 |
| 비밀번호 재설정 | `/login/forgot` → 메일 → `/auth/confirm?type=recovery` → `/login/confirm` → `/account/password` |
| 로그아웃 | `POST /auth/logout` |

## 구현 현황

PRD 23.1의 개발 순서를 따릅니다. 각 단계 진행 상황은 아래와 같습니다.

- [x] DB 스키마 전체 (§15)
- [x] URL 검증·canonical·금지 목적지 (§5.3~5.4, §6.3)
- [x] 코드 발급·원장 예약·충돌 재시도 (§5.5)
- [x] 단건 생성·중복 확인·검토 토큰·멱등성·회사 잠금 (§6, §14.1~14.3, §16)
- [x] 이름 목록 기반 일괄 생성 서비스 (§8, §14.4)
- [x] 수정·ETag·이력 (§11, §14.6)
- [x] 목록·검색·필터·cursor (§9, §14.5)
- [x] 공개 리다이렉트 (§12)
- [x] 외부 API 키 인증·scope (§13.5), `/api/v1` · `/internal` 링크 경로
- [x] Supabase 로그인·초대·비밀번호 재설정 화면 (§3.5)
- [x] 직원 관리 `/admin/employees` (§3.3, 초대·재발송·역할 변경·접근 중지/재개)
- [x] 강의 관리 `/admin/courses` (§4)
- [x] 이름 목록 관리 `/admin/generation-template` (§7)
- [x] 시스템 API 키 발급·재발급·폐기 `/admin/api-key` (사용자 결정: 연동별 다중 키 대신 시스템 키 1개)
- [x] 링크별 일자별 조회수·총조회수 (IP·User-Agent 미저장)
- [x] 만료 기록 정리 (Vercel Cron `/internal/cron/cleanup`, `npm run db:cleanup`)
- [ ] Excel 내보내기 (§10)
- [x] 링크 관리 화면 `/links`, `/links/new`, `/links/{id}`, 자동생성 팝업
- [x] 로컬 개발 로그인 (`DEV_AUTH`, 운영·Vercel 에서는 비활성)
- [ ] OpenAPI 3.1 명세

## 짧은 주소 유형 (type_key)

- 명세: `/docs/api` (공개), `public/openapi.yaml` → `https://bizup.im/openapi.yaml`
- 유형 조회 `GET /api/v1/short-link-types`, 발급 `POST /api/v1/short-links` (`course_id`, `type_key`, `destination_url`, `name`)
- 숫자 `type`(0000~9999)은 폐기. `type` 필드가 오면 422 `VALIDATION_ERROR`
- 같은 강의·유형은 링크 1개 (DB 고유 인덱스 `links_course_type_key_unique`, 409 `LINK_TYPE_EXISTS` 로 기존 주소 반환)
- 유형 관리(운영자 전용): `npm run types[:prod] -- list | add <key> "<label>" | rename <key> "<label>" | deactivate <key> | activate <key>`
  - key 변경·삭제 불가(DB 트리거), 삭제 대신 비활성화, key 재사용 금지
  - 전환형 유형 구성: `npm run types[:prod] -- slots <key> "chat=단톡방,youtube=유튜브 라이브,zoom=줌 라이브"` (`none` 이면 일반 유형). 관리 화면 `/admin/link-types` 에서도 가능

## 전환형 짧은 주소 (단톡방 → 유튜브 라이브 → 줌)

- 유형에 전환 주소 구성(2~5개)을 정해 두면 그 유형의 짧은 주소는 전환 주소를 갖는다. 기본 제공: `free_chat`(무료단톡방) = `chat` 단톡방 / `youtube` 유튜브 라이브 / `zoom` 줌 라이브
- 만들 때는 첫 주소만 필수, 나머지는 비워 두었다가 나중에 채운다. **지금 연결 중인 주소는 항상 채워져 있다** (빈 주소로 전환·연결 중인 주소 비우기는 409 `SLOT_EMPTY`)
- 화면: `/links/new` 에서 유형 선택 → 주소 칸 / 링크 목록의 연결 주소 표시(`단톡방 ▾`)를 눌러 바로 전환, 빈 주소는 입력 후 [저장]·[저장하고 전환] / 상세 화면의 전환 주소
- API (강의 UUID + type_key 로 찾음, 링크 ID·ETag 불필요, 반복 호출 안전)
  - 생성 `POST /api/v1/short-links` + `slot_urls: { chat: URL, youtube: null, zoom: null }`
  - 상태 `GET /api/v1/short-links?course_id=&type_key=` (`links:read`)
  - 채우기·바꾸기·비우기 `PUT /api/v1/short-links/slots` `{ course_id, type_key, slot, destination_url, activate? }` (`links:update`)
  - 전환 `POST /api/v1/short-links/switch` `{ course_id, type_key, slot }` (`links:update`)
- 구성은 그 유형으로 링크를 만들기 전까지만 바꿀 수 있다. 마이그레이션 `20261127000000_switchable_link_types.sql`
- 전환 마이그레이션 `20261126010000_short_link_type_key.sql` 은 **기존 발급 링크 전체와 종속 데이터를 삭제**한다 (테스트 기간 결정, 비가역).
  강의·직원·API 키·코드 원장은 유지. 대시보드 전달 문서: `docs/dashboard-short-link-type-key-handoff.md`

## 트래킹 링크 (`/links/tracking`)

상단 메뉴 **짧은 주소 만들기 → 트래킹 링크 만들기**. (일반 링크 만들기 = `/links/new`)

- 강의 선택 + 엑셀(.xlsx, 최대 300행·4MB) 업로드. 머리글에서 `추천 코드`·`진행 매체`·`URL` 열을 찾는다(띄어쓰기 무관, `단축 링크` 열은 무시).
- 이름: `{강의명}_{추천코드}_{진행매체}` (120자 초과 시 강의명을 줄임)
- 유형(type_key) 없이 생성 방식 `creation_mode = 'tracking'` 으로 구분한다 (목록의 방식 필터 '트래킹').
- 같은 강의에 같은 URL(정규화 기준)의 트래킹 링크가 있으면 건너뛰고 새 URL 만 만든다. DB 고유 색인 `links_tracking_course_url_unique` 가 강의 + 원본 주소당 1개를 보장(삭제된 링크 제외). 일반·자동생성·유형 링크와는 비교하지 않는다.
- 파일 안 중복·빈 값·잘못된 URL 은 행별로 표시.
- 업로드 파일은 저장하지 않는다(요청 메모리에서만 읽음). 결과는 `bzup.tracking_uploads`·`bzup.tracking_links` 에 보관.
- API: `POST /internal/tracking-links` (multipart `course_id`, `file`), `GET /internal/tracking-links?course_id=`, `GET /internal/tracking-links/export?course_id=` (단축 링크 채운 엑셀), `GET /internal/tracking-links/template` (양식)
