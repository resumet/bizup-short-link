'use client';
// 같은 목적지 재생성 확인 팝업 (PRD §6.4)
import { formatKst } from '@/lib/client/api';

export interface DuplicateReview {
  review_token: string;
  duplicate_kind: 'existing' | 'internal' | 'both';
  duplicate_groups: {
    input_row_ids: string[];
    input_rows?: { row_id: string; row_number: number; name: string }[];
    existing_count: number;
    existing_links?: { id: string; name: string; course_name: string | null; short_url: string; status: string; created_at: string }[];
  }[];
}

const TITLE = {
  existing: '같은 연결 주소가 이미 등록되어 있습니다.',
  internal: '입력한 항목 중 같은 연결 주소가 있습니다.',
  both: '기존 링크와 이번 입력에 같은 연결 주소가 있습니다.',
};

export function DuplicateDialog({
  review, changed, busy, onCreate, onCancel,
}: { review: DuplicateReview; changed?: boolean; busy?: boolean; onCreate: () => void; onCancel: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>{TITLE[review.duplicate_kind]}</h2>
        {changed && <p className="warn">확인 이후 같은 주소의 링크 구성이 바뀌었습니다. 아래 내용을 다시 확인해 주세요.</p>}
        <p>같은 연결 주소를 사용하는 새 짧은 주소를 만들까요?</p>
        <div className="modal-scroll">
          {review.duplicate_groups.map((g, gi) => (
            <div key={gi} className="dup-group">
              {g.input_rows && g.input_rows.length > 1 && (
                <p className="muted">
                  이번 입력: {g.input_rows.map((r) => `${r.row_number}번 ${r.name}`).join(', ')}
                </p>
              )}
              {g.existing_count > 0 && (
                <>
                  <p className="muted">기존 링크 {g.existing_count}건{g.existing_count > 5 ? ' (대표 5건 표시)' : ''}</p>
                  {g.existing_links && (
                    <table className="table small">
                      <thead><tr><th>명칭</th><th>강의</th><th>짧은 주소</th><th>상태</th><th>생성</th></tr></thead>
                      <tbody>
                        {g.existing_links.map((l) => (
                          <tr key={l.id}>
                            <td><a href={`/links/${l.id}`} target="_blank" rel="noreferrer">{l.name}</a></td>
                            <td>{l.course_name ?? '미분류'}</td>
                            <td>{l.short_url}</td>
                            <td><span className={`pill ${l.status === 'active' ? 'on' : 'off'}`}>{l.status === 'active' ? '활성' : '비활성'}</span></td>
                            <td>{formatKst(l.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>취소</button>
          <button className="button" type="button" onClick={onCreate} disabled={busy}>{busy && <span className="spinner" aria-hidden="true" />}{busy ? '처리 중…' : '새로 만들기'}</button>
        </div>
      </div>
    </div>
  );
}
