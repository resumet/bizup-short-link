// 클라이언트 컴포넌트에서 쓰는 상태 배지 (서버 TopBar 모듈과 분리)
export function StatusPillClient({ status }: { status: 'active' | 'inactive' | 'closed' | string }) {
  if (status === 'active') return <span className="pill on">활성</span>;
  if (status === 'closed') return <span className="pill closed">종료</span>;
  return <span className="pill off">비활성</span>;
}
