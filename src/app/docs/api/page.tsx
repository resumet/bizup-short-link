// 공개 API 문서 (로그인 불필요). 키·데이터를 노출하지 않는 정적 문서다.
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'BZUP Link API 문서',
  description: '강의 UUID·type·목적지 주소·명칭으로 짧은 주소를 만드는 API',
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
          <a href="#short-links">짧은 주소 생성</a>
          <a href="#courses">강의 목록</a>
          <a href="#errors">오류</a>
          <a href="#examples">예시 코드</a>
        </nav>
      </header>
      <main className="content narrow-content">
        <h1>BZUP Link API</h1>
        <p className="muted">
          강의 UUID, type, 목적지 주소, 명칭을 보내면 <code>{BASE}/xxxxxxx</code> 형태의 짧은 주소를 만들어 돌려줍니다.
          만들어진 짧은 주소는 BZUP Link에 저장되어 관리 화면의 링크 목록에서 확인할 수 있습니다.
        </p>

        <div className="card">
          <table className="table small">
            <thead><tr><th>항목</th><th>값</th></tr></thead>
            <tbody>
              <tr><td>Base URL</td><td><code>{BASE}</code></td></tr>
              <tr><td>형식</td><td>JSON (UTF-8), 시각은 UTC ISO 8601</td></tr>
              <tr><td>인증</td><td><code>Authorization: Bearer &lt;API 키&gt;</code></td></tr>
            </tbody>
          </table>
        </div>

        <h2 id="auth">인증</h2>
        <p>
          모든 API 요청에는 시스템 API 키가 필요합니다. 키는 최고관리자가 관리 화면 <code>/admin/api-key</code>에서 발급하며, 발급할 때 한 번만 표시됩니다.
        </p>
        <ul>
          <li>키는 서버 환경변수에 보관하고, 브라우저 코드·앱·공개 저장소에 넣지 마세요.</li>
          <li>키가 없거나, 틀렸거나, 만료·폐기되면 <code>401 INVALID_API_KEY</code>가 돌아옵니다.</li>
        </ul>
        <Code>{`curl ${BASE}/api/v1/auth-check \\
  -H "Authorization: Bearer $BZUP_API_KEY"`}</Code>

        <h2 id="short-links">짧은 주소 생성</h2>
        <p><code>POST /api/v1/short-links</code></p>
        <p>
          한 강의에는 <strong>type별로 짧은 주소가 하나만</strong> 만들어집니다.
          이미 같은 강의·type의 짧은 주소가 있으면 새로 만들지 않고 <code>409 LINK_TYPE_EXISTS</code>와 함께 기존 짧은 주소를 알려 줍니다.
        </p>

        <h3>요청 헤더</h3>
        <table className="table small">
          <thead><tr><th>헤더</th><th>필수</th><th>설명</th></tr></thead>
          <tbody>
            <tr><td><code>Authorization</code></td><td>예</td><td><code>Bearer &lt;API 키&gt;</code></td></tr>
            <tr><td><code>Content-Type</code></td><td>예</td><td><code>application/json</code></td></tr>
            <tr><td><code>Idempotency-Key</code></td><td>아니오</td><td>요청마다 새 UUID. 응답을 못 받아 다시 보낼 때 같은 값을 쓰면 같은 결과를 돌려줍니다.</td></tr>
          </tbody>
        </table>

        <h3>요청 본문</h3>
        <table className="table small">
          <thead><tr><th>필드</th><th>타입</th><th>필수</th><th>설명</th></tr></thead>
          <tbody>
            <tr><td><code>course_id</code></td><td>string (UUID)</td><td>예</td><td>강의 UUID. <a href="#courses">강의 목록</a>에서 확인합니다. 진행중인 강의만 가능합니다.</td></tr>
            <tr><td><code>type</code></td><td>string</td><td>예</td><td>4자리 숫자 문자열 <code>&quot;0000&quot;</code>~<code>&quot;9999&quot;</code>. 숫자 <code>1</code>이 아니라 문자열 <code>&quot;0001&quot;</code>로 보내야 합니다.</td></tr>
            <tr><td><code>destination_url</code></td><td>string</td><td>예</td><td>이동할 전체 주소 (<code>http://</code> 또는 <code>https://</code>)</td></tr>
            <tr><td><code>name</code></td><td>string</td><td>예</td><td>명칭 1~120자</td></tr>
          </tbody>
        </table>
        <Code>{`curl -X POST ${BASE}/api/v1/short-links \\
  -H "Authorization: Bearer $BZUP_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "course_id": "8b1d2f4e-5c6a-4b7d-9e0f-1a2b3c4d5e6f",
    "type": "0001",
    "destination_url": "https://open.kakao.com/o/abc123",
    "name": "AI 수익화 클래스 1기 단톡방"
  }'`}</Code>

        <h3>성공 응답 <span className="pill on">201 Created</span></h3>
        <Code>{`{
  "short_url": "${BASE}/Ab3dE7x",
  "short_code": "Ab3dE7x",
  "link_id": "3f6c9a1e-2b4d-4c8e-9f0a-1b2c3d4e5f60",
  "course_id": "8b1d2f4e-5c6a-4b7d-9e0f-1a2b3c4d5e6f",
  "type": "0001",
  "name": "AI 수익화 클래스 1기 단톡방",
  "destination_url": "https://open.kakao.com/o/abc123",
  "created_at": "2026-11-25T14:45:00Z"
}`}</Code>

        <h3>이미 있는 type <span className="pill off">409 Conflict</span></h3>
        <p className="muted">같은 강의·type으로 다시 요청하면 기존 짧은 주소를 <code>error.details</code>로 알려 줍니다. 호출하는 쪽에서는 이 값을 그대로 쓰면 됩니다.</p>
        <Code>{`{
  "error": {
    "code": "LINK_TYPE_EXISTS",
    "message": "이 강의에는 같은 type 의 짧은 주소가 이미 있습니다.",
    "details": {
      "course_id": "8b1d2f4e-5c6a-4b7d-9e0f-1a2b3c4d5e6f",
      "type": "0001",
      "link_id": "3f6c9a1e-2b4d-4c8e-9f0a-1b2c3d4e5f60",
      "short_code": "Ab3dE7x",
      "short_url": "${BASE}/Ab3dE7x"
    },
    "request_id": "…"
  }
}`}</Code>
        <p className="muted small">같은 목적지 주소가 다른 링크에 이미 있어도 확인 절차 없이 새 짧은 주소를 만듭니다. 같은 강의에 같은 type만 막습니다.</p>

        <h2 id="courses">강의 목록</h2>
        <p><code>GET /api/v1/courses</code> — 짧은 주소를 만들 때 쓸 강의 UUID를 조회합니다. <code>?status=active</code>를 붙이면 진행중 강의만 나옵니다.</p>
        <Code>{`curl "${BASE}/api/v1/courses?status=active" \\
  -H "Authorization: Bearer $BZUP_API_KEY"`}</Code>
        <Code>{`{
  "data": [
    {
      "id": "8b1d2f4e-5c6a-4b7d-9e0f-1a2b3c4d5e6f",
      "name": "AI 수익화 클래스",
      "instructor_name": "홍길동",
      "cohort": "1",
      "webinar_at": "2026-12-01T10:30:00.000Z",
      "status": "active",
      "version": 1,
      "created_at": "…",
      "updated_at": "…"
    }
  ]
}`}</Code>

        <h2 id="errors">오류</h2>
        <p>오류 응답은 모두 <code>{`{ "error": { "code", "message", "details"?, "request_id" } }`}</code> 형식입니다. 문의할 때는 <code>request_id</code>를 함께 알려 주세요.</p>
        <table className="table small">
          <thead><tr><th>상태</th><th>code</th><th>원인</th></tr></thead>
          <tbody>
            <tr><td>401</td><td><code>INVALID_API_KEY</code></td><td>API 키가 없거나 틀리거나 만료·폐기됨</td></tr>
            <tr><td>403</td><td><code>INSUFFICIENT_SCOPE</code></td><td>키에 필요한 권한이 없음</td></tr>
            <tr><td>409</td><td><code>LINK_TYPE_EXISTS</code></td><td>이 강의에 같은 type의 짧은 주소가 이미 있음 (기존 주소는 <code>details</code>)</td></tr>
            <tr><td>409</td><td><code>IDEMPOTENCY_KEY_REUSED</code></td><td>같은 Idempotency-Key로 다른 내용을 보냄</td></tr>
            <tr><td>422</td><td><code>COURSE_REQUIRED</code></td><td><code>course_id</code>가 없거나 없는 강의</td></tr>
            <tr><td>422</td><td><code>COURSE_NOT_ACTIVE</code></td><td>종료된 강의</td></tr>
            <tr><td>422</td><td><code>VALIDATION_ERROR</code></td><td><code>type</code>·<code>name</code> 형식 오류, 허용되지 않은 필드</td></tr>
            <tr><td>422</td><td><code>INVALID_DESTINATION_URL</code> / <code>FORBIDDEN_DESTINATION</code></td><td>목적지 주소 형식 오류 또는 허용되지 않는 주소 (예: 짧은 주소 자기 자신)</td></tr>
            <tr><td>429</td><td><code>RATE_LIMITED</code></td><td>요청이 너무 많음. <code>Retry-After</code> 헤더만큼 기다린 뒤 다시 시도</td></tr>
            <tr><td>503</td><td><code>SERVICE_UNAVAILABLE</code></td><td>일시적 오류. 같은 Idempotency-Key로 다시 시도</td></tr>
          </tbody>
        </table>

        <h2 id="examples">예시 코드</h2>
        <h3>JavaScript (Node.js 18+, 서버 쪽)</h3>
        <Code>{`async function createShortLink({ courseId, type, destinationUrl, name }) {
  const res = await fetch('${BASE}/api/v1/short-links', {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${process.env.BZUP_API_KEY}\`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ course_id: courseId, type, destination_url: destinationUrl, name }),
  });
  const body = await res.json();
  if (res.status === 201) return body.short_url;
  if (res.status === 409 && body.error.code === 'LINK_TYPE_EXISTS') return body.error.details.short_url;
  throw new Error(\`\${res.status} \${body.error?.code}: \${body.error?.message}\`);
}`}</Code>

        <h3>Python</h3>
        <Code>{`import os, uuid, requests

def create_short_link(course_id, type_, destination_url, name):
    r = requests.post(
        "${BASE}/api/v1/short-links",
        headers={
            "Authorization": f"Bearer {os.environ['BZUP_API_KEY']}",
            "Idempotency-Key": str(uuid.uuid4()),
        },
        json={"course_id": course_id, "type": type_, "destination_url": destination_url, "name": name},
        timeout=15,
    )
    body = r.json()
    if r.status_code == 201:
        return body["short_url"]
    if r.status_code == 409 and body["error"]["code"] == "LINK_TYPE_EXISTS":
        return body["error"]["details"]["short_url"]
    raise RuntimeError(f"{r.status_code} {body['error']['code']}: {body['error']['message']}")`}</Code>

        <p className="muted small" style={{ marginTop: '2rem' }}>BZUP Link · 문의는 BZUP Link 최고관리자에게 해 주세요.</p>
      </main>
    </div>
  );
}
