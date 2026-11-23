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
- [ ] Supabase 로그인·초대·비밀번호 재설정 화면 (§3.5)
- [ ] 직원 관리 `/admin/employees` (§3.3)
- [x] 강의 관리 `/admin/courses` (§4)
- [x] 이름 목록 관리 `/admin/generation-template` (§7)
- [x] 시스템 API 키 발급·재발급·폐기 `/admin/api-key` (사용자 결정: 연동별 다중 키 대신 시스템 키 1개)
- [x] 링크별 일자별 조회수·총조회수 (IP·User-Agent 미저장)
- [x] 만료 기록 정리 (Vercel Cron `/internal/cron/cleanup`, `npm run db:cleanup`)
- [ ] Excel 내보내기 (§10)
- [x] 링크 관리 화면 `/links`, `/links/new`, `/links/{id}`, 자동생성 팝업
- [x] 로컬 개발 로그인 (`DEV_AUTH`, 운영·Vercel 에서는 비활성)
- [ ] OpenAPI 3.1 명세
