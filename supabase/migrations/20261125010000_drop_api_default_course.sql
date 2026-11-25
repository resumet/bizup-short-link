-- API 기본 강의 제거: 모든 API 생성 요청은 course_id(강의 UUID)를 포함한다
alter table bzup.api_clients drop column default_course_id;
