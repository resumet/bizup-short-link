// 공개 API 문서 (로그인 불필요). 키·데이터를 노출하지 않는 정적 문서다.
// 기계용 명세: /openapi.yaml (public/openapi.yaml) — 이 페이지와 내용을 일치시킨다.
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'BZUP Link API 문서',
  description: '강의 UUID·유형(type_key)·목적지 주소·명칭으로 짧은 주소를 만드는 API',
};

const BASE = 'https://bizup.im';

function Code({ children }: { children: string }) {
  return <pre className="code-block">{children}</pre>;
}

export default function ApiDocsPage() {
  return (
    <div className="page">
      <header className="topbar">
        <Link href="/docs/api" className="brand">BZUP Link API</Link>
        <nav aria-label="문서 목차">
          <a href="#auth">인증</a>
          <a href="#types">유형 조회</a>
          <a href="#short-links">짧은 주소 발급</a>
          <a href="#switch">전환형</a>
          <a href="#idempotency">멱등성</a>
          <a href="#errors">오류</a>
          <a href="#examples">예시 코드</a>
        </nav>
        <span className="me"><a href="/openapi.yaml">OpenAPI</a> · <Link href="/links">관리 화면</Link></span>
      </header>
      <main className="content narrow-content">
        <h1>BZUP Link API</h1>
        <p className="muted">
          강의 UUID, 유형(<code>type_key</code>), 목적지 주소, 명칭을 보내면 <code>{BASE}/xxxxxxx</code> 형태의 짧은 주소를 만들어 돌려줍니다.
          만들어진 짧은 주소는 BZUP Link에 저장되어 관리 화면의 링크 목록에서 확인할 수 있습니다.
        </p>

        <div className="card">
          <table className="table small">
            <thead><tr><th>항목</th><th>값</th></tr></thead>
            <tbody>
              <tr><td>Base URL</td><td><code>{BASE}</code></td></tr>
              <tr><td>형식</td><td>JSON (UTF-8), 시각은 UTC ISO 8601</td></tr>
              <tr><td>인증</td><td><code>Authorization: Bearer &lt;API 키&gt;</code></td></tr>
              <tr><td>OpenAPI 명세</td><td><a href="/openapi.yaml">{BASE}/openapi.yaml</a></td></tr>
            </tbody>
          </table>
        </div>

        <p className="warn">
          <strong>숫자 type 방식(0000~9999)은 폐기되었습니다.</strong> 요청에 <code>type</code> 필드가 있으면 422 <code>VALIDATION_ERROR</code>입니다.
          문자열 <code>type_key</code>만 사용합니다.
        </p>

        <h2 id="auth">인증</h2>
        <p>
          모든 요청에는 시스템 API 키가 필요합니다. 키는 최고관리자가 관리 화면 <code>/admin/api-key</code>에서 발급하며, 발급할 때 한 번만 표시됩니다.
        </p>
        <ul>
          <li>키는 서버 환경변수에 보관하고, 브라우저 코드·앱·공개 저장소에 넣지 마세요. 유형 조회·발급 호출도 서버에서 합니다.</li>
          <li>키가 없거나, 틀렸거나, 만료·폐기되면 <code>401 INVALID_API_KEY</code>, 권한이 부족하면 <code>403 INSUFFICIENT_SCOPE</code>입니다.</li>
        </ul>

        <h2 id="types">유형 조회</h2>
        <p><code>GET /api/v1/short-link-types</code> — 짧은 주소 생성용 API 키로 조회할 수 있습니다. 활성·비활성 유형을 모두 <code>key</code> 오름차순으로 돌려줍니다.</p>
        <Code>{`curl ${BASE}/api/v1/short-link-types \\
  -H "Authorization: Bearer $BZUP_API_KEY"`}</Code>
        <Code>{`{
  "types": [
    { "key": "free_chat", "label": "무료단톡방", "active": true,
      "slots": [
        { "key": "chat", "label": "단톡방" },
        { "key": "youtube", "label": "유튜브 라이브" },
        { "key": "zoom", "label": "줌 라이브" }
      ] },
    { "key": "landing", "label": "기본 랜딩 QR", "active": true, "slots": null },
    { "key": "payment", "label": "결제페이지 QR", "active": true, "slots": null }
  ]
}`}</Code>
        <ul className="small">
          <li>유형 목록의 기준은 서버입니다. 클라이언트에 고정 목록을 두지 말고 이 API로 확인하세요.</li>
          <li><code>key</code>는 바뀌지 않는 식별자입니다. 형식: 소문자 영문으로 시작, 소문자 영문·숫자·밑줄, 1~64자 (<code>^[a-z][a-z0-9_]{'{0,63}'}$</code>).</li>
          <li><code>label</code>은 표시 이름이며 바뀔 수 있습니다. 비활성 유형으로는 새 짧은 주소를 만들 수 없지만, 이미 발급된 주소는 계속 동작합니다.</li>
          <li><code>slots</code>가 있으면 <a href="#switch">전환형 유형</a>입니다. 일반 유형은 <code>null</code>입니다.</li>
        </ul>

        <h2 id="short-links">짧은 주소 발급</h2>
        <p><code>POST /api/v1/short-links</code></p>
        <p>한 강의에는 <strong>유형별로 짧은 주소가 하나만</strong> 있습니다.</p>

        <h3>요청 헤더</h3>
        <table className="table small">
          <thead><tr><th>헤더</th><th>필수</th><th>설명</th></tr></thead>
          <tbody>
            <tr><td><code>Authorization</code></td><td>예</td><td><code>Bearer &lt;API 키&gt;</code></td></tr>
            <tr><td><code>Content-Type</code></td><td>예</td><td><code>application/json</code></td></tr>
            <tr><td><code>Idempotency-Key</code></td><td>아니오</td><td>요청마다 새 UUID. <a href="#idempotency">멱등성</a> 참고</td></tr>
          </tbody>
        </table>

        <h3>요청 본문</h3>
        <table className="table small">
          <thead><tr><th>필드</th><th>타입</th><th>필수</th><th>설명</th></tr></thead>
          <tbody>
            <tr><td><code>course_id</code></td><td>string (UUID)</td><td>예</td><td>강의 UUID. 진행중 강의만 가능합니다.</td></tr>
            <tr><td><code>type_key</code></td><td>string</td><td>예</td><td>등록된 유형 key (예: <code>landing</code>, <code>payment</code>). 숫자·숫자 문자열(<code>&quot;0001&quot;</code>)·대문자·공백은 거부됩니다.</td></tr>
            <tr><td><code>destination_url</code></td><td>string</td><td>예*</td><td>최대 2,000자, <code>http://</code> 또는 <code>https://</code> 전체 주소. 사용자명·비밀번호가 포함된 주소는 금지. *전환형 유형은 <code>slot_urls</code>의 첫 주소로 대신할 수 있습니다.</td></tr>
            <tr><td><code>name</code></td><td>string</td><td>예</td><td>앞뒤 공백 제거 후 1~120자</td></tr>
            <tr><td><code>slot_urls</code></td><td>object</td><td>아니오</td><td>전환형 유형만. <code>{'{ "전환키": URL 또는 null }'}</code>. <a href="#switch">전환형</a> 참고</td></tr>
          </tbody>
        </table>
        <p className="muted small">위 필드 외의 필드(구형 <code>type</code> 포함)를 보내면 422 <code>VALIDATION_ERROR</code>입니다.</p>
        <Code>{`curl -X POST ${BASE}/api/v1/short-links \\
  -H "Authorization: Bearer $BZUP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "course_id": "실제 강의 UUID",
    "type_key": "payment",
    "destination_url": "https://example.com/payment",
    "name": "AI 수익화 클래스 결제페이지"
  }'`}</Code>

        <h3>처리 순서</h3>
        <ol className="small">
          <li>인증·권한 확인 (401 / 403)</li>
          <li>입력 형식 확인 (422 <code>VALIDATION_ERROR</code>)</li>
          <li>강의 확인: 없거나 접근할 수 없으면 422 <code>COURSE_REQUIRED</code>, 종료 강의면 422 <code>COURSE_NOT_ACTIVE</code> (없는 강의와 접근 불가 강의를 구분하지 않습니다)</li>
          <li>같은 강의·유형의 링크가 있으면 <strong>409 <code>LINK_TYPE_EXISTS</code></strong>로 기존 주소를 돌려줍니다. 유형이 비활성이어도 같습니다. 이름·연결 주소는 덮어쓰지 않습니다.</li>
          <li>등록되지 않은 <code>type_key</code>면 422 <code>UNKNOWN_LINK_TYPE</code></li>
          <li>비활성 유형이면 422 <code>LINK_TYPE_INACTIVE</code></li>
          <li>새 짧은 주소 발급 (201). 같은 목적지 주소가 다른 링크에 있어도 확인 없이 발급합니다.</li>
        </ol>

        <h3>새 발급 <span className="pill on">201 Created</span></h3>
        <Code>{`{
  "short_url": "${BASE}/Ab3dE7x",
  "short_code": "Ab3dE7x",
  "link_id": "76cb8534-125a-45f9-9081-e37e6b4805f4",
  "course_id": "3f6c8c23-9e12-4c75-a4d2-6425ddcd2101",
  "type_key": "payment",
  "type_label": "결제페이지 QR",
  "name": "AI 수익화 클래스 결제페이지",
  "destination_url": "https://example.com/payment",
  "created_at": "2026-11-26T00:00:00Z"
}`}</Code>

        <h3>같은 강의·유형 링크 존재 <span className="pill off">409 Conflict</span></h3>
        <p className="muted small">호출하는 쪽에서는 <code>error.details.short_url</code>을 그대로 쓰면 됩니다. 동시에 여러 번 요청해도 링크는 하나만 만들어집니다.</p>
        <Code>{`{
  "error": {
    "code": "LINK_TYPE_EXISTS",
    "message": "이 강의에는 같은 유형의 짧은 주소가 이미 있습니다.",
    "details": {
      "course_id": "3f6c8c23-9e12-4c75-a4d2-6425ddcd2101",
      "type_key": "payment",
      "type_label": "결제페이지 QR",
      "link_id": "76cb8534-125a-45f9-9081-e37e6b4805f4",
      "short_code": "Ab3dE7x",
      "short_url": "${BASE}/Ab3dE7x"
    },
    "request_id": "…"
  }
}`}</Code>

        <h2 id="switch">전환형 짧은 주소 (단톡방 → 라이브 → 줌)</h2>
        <p>
          짧은 주소 하나의 연결 대상을 필요할 때 바꿉니다. 예를 들어 <code>free_chat</code>(무료단톡방) 유형은
          단톡방·유튜브 라이브·줌 라이브 주소 3개를 갖고, 문자로 나간 같은 짧은 주소가 라이브 전에는 단톡방, 라이브 중에는 유튜브로 연결됩니다.
        </p>
        <ul className="small">
          <li>전환형 유형은 <code>free_chat</code> 하나뿐입니다. 따라서 한 강의의 전환형 짧은 주소는 <code>free_chat</code> 1개입니다.</li>
          <li>만들 때는 <strong>첫 주소만 필수</strong>입니다. 유튜브·줌 주소는 비워 두었다가 나중에 채웁니다.</li>
          <li>링크는 <strong>강의 UUID + type_key</strong>로 찾습니다. 링크 ID·ETag 가 필요 없습니다.</li>
          <li>전환은 다음 클릭부터 바로 적용되고, 모든 변경은 관리 화면의 변경 이력에 남습니다.</li>
          <li>같은 요청을 반복해도 안전합니다. 이미 그 상태면 아무것도 바꾸지 않고 <code>changed_fields: []</code>로 응답합니다.</li>
          <li>지금 연결 중인 주소는 항상 채워져 있습니다. 빈 주소로 전환하거나 연결 중인 주소를 비우면 409 <code>SLOT_EMPTY</code>입니다.</li>
          <li>조회는 <code>links:read</code>, 채우기·전환은 <code>links:update</code> 권한이 필요합니다.</li>
        </ul>

        <h3>1. 만들기 (유튜브·줌은 비워 둠)</h3>
        <Code>{`curl -X POST ${BASE}/api/v1/short-links \\
  -H "Authorization: Bearer $BZUP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "course_id": "실제 강의 UUID",
    "type_key": "free_chat",
    "name": "AI 수익화 클래스 무료단톡방",
    "slot_urls": { "chat": "https://open.kakao.com/o/abc123", "youtube": null, "zoom": null }
  }'`}</Code>
        <p className="muted small">응답은 일반 발급과 같고 <code>active_slot</code>(지금 연결된 전환 키)과 <code>slots</code>가 더 붙습니다.</p>

        <h3>2. 주소 채우기 — <code>PUT /api/v1/short-links/slots</code></h3>
        <Code>{`curl -X PUT ${BASE}/api/v1/short-links/slots \\
  -H "Authorization: Bearer $BZUP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "course_id": "실제 강의 UUID", "type_key": "free_chat",
        "slot": "youtube", "destination_url": "https://www.youtube.com/live/abc" }'`}</Code>
        <table className="table small">
          <thead><tr><th>필드</th><th>필수</th><th>설명</th></tr></thead>
          <tbody>
            <tr><td><code>course_id</code>, <code>type_key</code></td><td>예</td><td>대상 짧은 주소</td></tr>
            <tr><td><code>slot</code></td><td>예</td><td>전환 키 (예: <code>youtube</code>)</td></tr>
            <tr><td><code>destination_url</code></td><td>예</td><td>채울 주소. <code>null</code>이면 비웁니다 (연결 중인 주소는 비울 수 없음)</td></tr>
            <tr><td><code>activate</code></td><td>아니오</td><td><code>true</code>면 채우고 바로 전환합니다 (기본 <code>false</code>)</td></tr>
          </tbody>
        </table>

        <h3>3. 전환 — <code>POST /api/v1/short-links/switch</code></h3>
        <Code>{`# 라이브 시작
curl -X POST ${BASE}/api/v1/short-links/switch \\
  -H "Authorization: Bearer $BZUP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "course_id": "실제 강의 UUID", "type_key": "free_chat", "slot": "youtube" }'

# 라이브 종료 → 단톡방으로
  -d '{ "course_id": "실제 강의 UUID", "type_key": "free_chat", "slot": "chat" }'`}</Code>

        <h3>상태 조회 — <code>GET /api/v1/short-links?course_id=&amp;type_key=</code></h3>
        <p className="muted small">채우기·전환 응답도 같은 형식이며 <code>changed_fields</code>가 붙습니다.</p>
        <Code>{`{
  "data": {
    "link_id": "76cb8534-125a-45f9-9081-e37e6b4805f4",
    "short_url": "${BASE}/Ab3dE7x",
    "short_code": "Ab3dE7x",
    "course_id": "3f6c8c23-9e12-4c75-a4d2-6425ddcd2101",
    "type_key": "free_chat",
    "type_label": "무료단톡방",
    "name": "AI 수익화 클래스 무료단톡방",
    "status": "active",
    "destination_url": "https://www.youtube.com/live/abc",
    "switchable": true,
    "active_slot": "youtube",
    "active_slot_label": "유튜브 라이브",
    "slots": [
      { "key": "chat", "label": "단톡방", "destination_url": "https://open.kakao.com/o/abc123" },
      { "key": "youtube", "label": "유튜브 라이브", "destination_url": "https://www.youtube.com/live/abc" },
      { "key": "zoom", "label": "줌 라이브", "destination_url": null }
    ],
    "updated_at": "2026-11-27T11:00:00Z",
    "changed_fields": ["active_slot", "destination_url"]
  }
}`}</Code>

        <h2 id="idempotency">멱등성</h2>
        <ul className="small">
          <li><code>Idempotency-Key</code>는 선택입니다. 응답을 받지 못해 다시 보낼 때 <strong>같은 키·같은 본문</strong>을 쓰면 원래 응답(201)을 그대로 돌려주고 링크를 추가로 만들지 않습니다.</li>
          <li>같은 키를 <strong>다른 본문</strong>에 쓰면 409 <code>IDEMPOTENCY_KEY_REUSED</code>입니다.</li>
          <li>키 없이, 또는 다른 키로 같은 강의·유형을 다시 요청하면 409 <code>LINK_TYPE_EXISTS</code>로 기존 링크를 돌려줍니다.</li>
          <li>키는 24시간 동안 기억됩니다.</li>
        </ul>

        <h2 id="courses">강의 목록</h2>
        <p><code>GET /api/v1/courses</code> — 강의 UUID를 조회합니다. <code>?status=active</code>를 붙이면 진행중 강의만 나옵니다.</p>
        <Code>{`curl "${BASE}/api/v1/courses?status=active" \\
  -H "Authorization: Bearer $BZUP_API_KEY"`}</Code>

        <h2 id="errors">오류</h2>
        <p>오류 응답은 모두 <code>{`{ "error": { "code", "message", "details"?, "request_id" } }`}</code> 형식입니다. 문의할 때는 <code>request_id</code>를 함께 알려 주세요.</p>
        <table className="table small">
          <thead><tr><th>상태</th><th>code</th><th>원인</th></tr></thead>
          <tbody>
            <tr><td>401</td><td><code>INVALID_API_KEY</code></td><td>키 누락·오류·만료·폐기</td></tr>
            <tr><td>403</td><td><code>INSUFFICIENT_SCOPE</code></td><td>키 권한 부족</td></tr>
            <tr><td>409</td><td><code>LINK_TYPE_EXISTS</code></td><td>같은 강의·유형의 링크 존재 (기존 주소는 <code>details</code>)</td></tr>
            <tr><td>409</td><td><code>IDEMPOTENCY_KEY_REUSED</code></td><td>같은 Idempotency-Key로 다른 본문을 보냄</td></tr>
            <tr><td>409</td><td><code>SLOT_EMPTY</code></td><td>비어 있는 전환 주소로 전환, 또는 연결 중인 주소를 비우려 함</td></tr>
            <tr><td>404</td><td><code>NOT_FOUND</code></td><td>(전환형) 이 강의에 해당 유형의 짧은 주소가 없음</td></tr>
            <tr><td>422</td><td><code>UNKNOWN_SLOT</code></td><td>(전환형) 유형에 없는 전환 키</td></tr>
            <tr><td>422</td><td><code>LINK_NOT_SWITCHABLE</code></td><td>(전환형) 전환형 유형으로 만든 링크가 아님</td></tr>
            <tr><td>422</td><td><code>COURSE_REQUIRED</code></td><td>강의 UUID 누락, 없거나 접근할 수 없는 강의</td></tr>
            <tr><td>422</td><td><code>COURSE_NOT_ACTIVE</code></td><td>종료 등 발급할 수 없는 상태의 강의</td></tr>
            <tr><td>422</td><td><code>UNKNOWN_LINK_TYPE</code></td><td>형식은 맞지만 등록되지 않은 <code>type_key</code></td></tr>
            <tr><td>422</td><td><code>LINK_TYPE_INACTIVE</code></td><td>비활성 유형으로 신규 발급 시도</td></tr>
            <tr><td>422</td><td><code>VALIDATION_ERROR</code></td><td>구형 <code>type</code> 필드, <code>type_key</code> 누락·형식 오류, 이름 오류, 알 수 없는 필드</td></tr>
            <tr><td>422</td><td><code>INVALID_DESTINATION_URL</code> / <code>FORBIDDEN_DESTINATION</code></td><td>목적지 주소 형식 오류 또는 허용되지 않는 주소</td></tr>
            <tr><td>429</td><td><code>RATE_LIMITED</code></td><td>요청 제한 초과. <code>Retry-After</code>만큼 기다린 뒤 다시 시도</td></tr>
          </tbody>
        </table>

        <h2 id="examples">예시 코드 (서버 전용)</h2>
        <h3>JavaScript (Node.js 18+)</h3>
        <Code>{`async function createShortLink({ courseId, typeKey, destinationUrl, name, idempotencyKey }) {
  const apiKey = process.env.BZUP_API_KEY;
  if (!apiKey) throw new Error('짧은 주소 API 키가 설정되지 않았습니다.');

  const response = await fetch('${BASE}/api/v1/short-links', {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ course_id: courseId, type_key: typeKey, destination_url: destinationUrl, name }),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
    cache: 'no-store',
  });

  const body = await response.json().catch(() => null);
  if (response.status === 201 && typeof body?.short_url === 'string') return body.short_url;
  if (response.status === 409 && body?.error?.code === 'LINK_TYPE_EXISTS'
      && typeof body.error.details?.short_url === 'string') {
    return body.error.details.short_url;
  }
  throw new Error(\`짧은 주소 발급 실패: \${response.status} \${body?.error?.code ?? 'INVALID_RESPONSE'}\`);
}`}</Code>
        <p className="muted small">재시도 시 멱등성을 원하면 호출하는 쪽에서 UUID를 한 번 만들어 같은 <code>idempotencyKey</code>로 전달하세요.</p>

        <h3>Python</h3>
        <Code>{`import os, uuid, requests

def create_short_link(course_id, type_key, destination_url, name, idempotency_key=None):
    headers = {"Authorization": f"Bearer {os.environ['BZUP_API_KEY']}"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    r = requests.post(
        "${BASE}/api/v1/short-links",
        headers=headers,
        json={"course_id": course_id, "type_key": type_key, "destination_url": destination_url, "name": name},
        timeout=15,
    )
    body = r.json()
    if r.status_code == 201:
        return body["short_url"]
    if r.status_code == 409 and body["error"]["code"] == "LINK_TYPE_EXISTS":
        return body["error"]["details"]["short_url"]
    raise RuntimeError(f"{r.status_code} {body['error']['code']}: {body['error']['message']}")`}</Code>

        <h2 id="type-admin">유형 등록·수정·비활성화 (운영자)</h2>
        <p className="small">일반 발급용 API 키로는 유형을 추가·수정할 수 없습니다. BZUP Link 운영자가 서버 저장소에서 다음 명령으로 관리합니다.</p>
        <Code>{`npm run types:prod -- list
npm run types:prod -- add <key> "<표시 이름>"
npm run types:prod -- rename <key> "<새 표시 이름>"
npm run types:prod -- deactivate <key>
npm run types:prod -- activate <key>`}</Code>
        <ul className="small">
          <li>key는 바꾸거나 삭제할 수 없고, 다른 용도로 재사용하지 않습니다. 새 용도에는 새 key를 만듭니다.</li>
          <li>사용하지 않는 유형은 삭제 대신 비활성화합니다. 이미 발급된 주소는 계속 동작합니다.</li>
        </ul>

        <p className="muted small" style={{ marginTop: '2rem' }}>BZUP Link · 문의는 BZUP Link 최고관리자에게 해 주세요.</p>
      </main>
    </div>
  );
}
