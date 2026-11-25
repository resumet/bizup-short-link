-- 강의 정보: UUID(id), 강의명, 강사명, 기수, 웨비나 일정
-- 외부(bizup-dashboard)에서 가져온 강의는 외부 강의 UUID 를 그대로 id 로 사용한다 → 같은 강의는 한 번만 추가된다.
-- memo 는 더 이상 화면·API 에서 쓰지 않는다 (기존 값 보존을 위해 컬럼은 유지).

alter table bzup.courses
  add column cohort     text check (cohort is null or char_length(cohort) between 1 and 40),
  add column webinar_at timestamptz,
  add column source     text not null default 'manual' check (source in ('manual','dashboard'));
