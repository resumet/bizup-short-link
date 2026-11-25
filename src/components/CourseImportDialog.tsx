'use client';
// 외부 강의 정보(bizup-dashboard) 조회 팝업. 아직 DB 저장은 하지 않는다.
// 외부 API 는 브라우저 Origin(https://bizup.im)으로 호출을 허용하므로 브라우저에서 직접 호출한다.
import { useEffect, useState } from 'react';
import { formatKst } from '@/lib/client/api';

const COURSES_API = 'https://bizup-dashboard.vercel.app/api/public/courses';

interface ExternalCourse {
  id: string;
  name: string;
  instructorName: string | null;
  cohort: string | null;
  webinarDate: string | null;
}

export function CourseImportButton({ existingNames }: { existingNames: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button secondary" onClick={() => setOpen(true)}>강의정보 가져오기</button>
      {open && <CourseImportDialog existingNames={existingNames} onClose={() => setOpen(false)} />}
    </>
  );
}

function CourseImportDialog({ existingNames, onClose }: { existingNames: string[]; onClose: () => void }) {
  const [courses, setCourses] = useState<ExternalCourse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(COURSES_API, { method: 'GET', credentials: 'omit', cache: 'no-store' });
      if (res.status === 403) {
        setError('강의 정보는 https://bizup.im 에서만 가져올 수 있습니다. (로컬 개발 환경에서는 조회가 거절됩니다)');
        return;
      }
      if (!res.ok) {
        setError(`강의 정보를 가져오지 못했습니다. (응답 ${res.status})`);
        return;
      }
      const body = (await res.json()) as { courses?: ExternalCourse[] };
      setCourses(Array.isArray(body.courses) ? body.courses : []);
    } catch {
      setError('강의 정보 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const existing = new Set(existingNames.map((n) => n.trim()));

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="course-import-title">
      <div className="modal wide">
        <h2 id="course-import-title">강의정보 가져오기</h2>
        <p>bizup-dashboard 에 등록된 강의 목록입니다. 아직 이 화면에서 등록되지는 않습니다.</p>
        {loading && <p className="muted"><span className="spinner" aria-hidden="true" />불러오는 중…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {courses && (
          courses.length === 0 ? <p className="muted">가져올 강의가 없습니다.</p> : (
            <div className="modal-scroll">
              <table className="table small">
                <thead><tr><th>강의명</th><th>강사명</th><th>기수</th><th>웨비나 일시</th><th>상태</th></tr></thead>
                <tbody>
                  {courses.map((c) => (
                    <tr key={c.id}>
                      <td className="col-name">{c.name}</td>
                      <td>{c.instructorName}</td>
                      <td className="num">{c.cohort ? `${c.cohort}기` : ''}</td>
                      <td className="nowrap num">{c.webinarDate ? formatKst(c.webinarDate) : ''}</td>
                      <td>{existing.has(c.name.trim()) ? <span className="pill on">같은 이름 등록됨</span> : <span className="pill off plain">미등록</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        <div className="modal-actions">
          {courses && <span className="muted" style={{ marginRight: 'auto', alignSelf: 'center' }}>{courses.length}개</span>}
          <button className="button secondary" type="button" disabled={loading} onClick={() => void load()}>새로고침</button>
          <button className="button" type="button" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
