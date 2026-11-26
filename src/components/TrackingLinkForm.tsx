'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch, apiUpload, ApiError, formatKst } from '@/lib/client/api';
import { CopyButton } from './CopyButton';

interface Course { id: string; name: string; instructor_name: string | null }

type RowStatus = 'created' | 'exists' | 'duplicate_in_file' | 'error';
interface ResultRow {
  row: number; referral_code: string; media: string; destination_url: string; status: RowStatus;
  name: string | null; short_url: string | null; link_id: string | null; message: string | null;
}
interface UploadResult {
  upload_id: string; course_id: string; course_name: string; file_name: string;
  total_rows: number; created_count: number; skipped_count: number; error_count: number; rows: ResultRow[];
}
interface StoredRow {
  id: string; link_id: string; name: string; referral_code: string; media: string; destination_url: string;
  short_url: string; status: 'active' | 'inactive' | 'deleted'; created_at: string | null; file_name: string;
}

const STATUS: Record<RowStatus, { label: string; cls: string }> = {
  created: { label: '새로 만듦', cls: 'on' },
  exists: { label: '이미 있음', cls: 'off' },
  duplicate_in_file: { label: '파일 내 중복', cls: 'off' },
  error: { label: '오류', cls: 'closed' },
};
const LINK_STATUS = { active: '사용중', inactive: '중지', deleted: '삭제됨' } as const;

function tsv(rows: { name: string | null; referral_code: string; media: string; short_url: string | null; destination_url: string }[]) {
  const head = ['이름', '추천코드', '진행매체', '짧은 주소', 'URL'].join('\t');
  return [head, ...rows.map((r) => [r.name ?? '', r.referral_code, r.media, r.short_url ?? '', r.destination_url].join('\t'))].join('\n');
}

export function TrackingLinkForm({ courses, isOwner }: { courses: Course[]; isOwner: boolean }) {
  const [courseId, setCourseId] = useState(courses.length === 1 ? courses[0].id : '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [stored, setStored] = useState<StoredRow[] | null>(null);
  const [storedError, setStoredError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadStored = useCallback(async (id: string) => {
    setStoredError(null);
    try {
      const r = await apiFetch<{ data: StoredRow[] }>(`/internal/tracking-links?course_id=${encodeURIComponent(id)}`);
      setStored(r.body.data);
    } catch (e) {
      setStored(null);
      setStoredError(e instanceof ApiError ? e.message : '목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    setStored(null);
    if (courseId) void loadStored(courseId);
  }, [courseId, loadStored]);

  if (courses.length === 0) {
    return (
      <div className="card">
        <p>진행중 강의가 없습니다. 최고관리자가 진행중 강의를 등록해야 합니다.</p>
        {isOwner && <Link className="button" href="/admin/courses">강의 등록하기</Link>}
      </div>
    );
  }

  async function submit() {
    if (!courseId || !file) return;
    const form = new FormData();
    form.set('course_id', courseId);
    form.set('file', file);
    setBusy(true);
    setError(null);
    try {
      const r = await apiUpload<{ data: UploadResult }>('/internal/tracking-links', form);
      setResult(r.body.data);
      // 업로드한 파일은 화면에서도 비운다 (서버에는 저장하지 않음)
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      void loadStored(courseId);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const courseName = courses.find((c) => c.id === courseId)?.name;

  return (
    <>
      <form className="card form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label>
          강의
          <select value={courseId} onChange={(e) => { setCourseId(e.target.value); setResult(null); }} required>
            <option value="" disabled>진행중 강의 선택</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.instructor_name ? ` (${c.instructor_name})` : ''}</option>
            ))}
          </select>
        </label>
        <label>
          엑셀 파일 (.xlsx)
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
          <span className="muted small">
            머리글에 <b>추천코드</b>, <b>진행매체</b>, <b>URL</b> 열이 있어야 합니다. 한 번에 최대 300행.{' '}
            <a href="/internal/tracking-links/template" download>양식 내려받기</a>
          </span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button className="button" type="submit" disabled={busy || !courseId || !file}>
            {busy && <span className="spinner" aria-hidden="true" />}{busy ? '만드는 중…' : '짧은 주소 만들기'}
          </button>
        </div>
      </form>

      {result && (
        <section style={{ marginTop: '2rem' }} aria-live="polite">
          <div className="title-row">
            <h2>처리 결과 <span className="muted small">{result.file_name}</span></h2>
            <div className="actions">
              <CopyButton
                text={tsv(result.rows.filter((r) => r.status === 'created' || r.status === 'exists'))}
                label="결과 표 복사"
                ariaLabel="처리 결과 표를 엑셀 붙여넣기용으로 복사"
              />
            </div>
          </div>
          <p className={result.error_count ? 'error' : 'ok'} role="status">
            총 {result.total_rows}행 · 새로 만듦 <b>{result.created_count}</b> · 건너뜀 <b>{result.skipped_count}</b>
            {result.error_count > 0 && <> · 오류 <b>{result.error_count}</b></>}
            {result.created_count === 0 && result.error_count === 0 && ' — 새로 추가된 URL 이 없습니다.'}
          </p>
          <div className="table-wrap">
            <table className="table small">
              <thead>
                <tr><th>행</th><th>상태</th><th>이름</th><th>추천코드</th><th>진행매체</th><th>짧은 주소</th><th>URL</th><th>비고</th></tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.row}>
                    <td className="nowrap">{r.row}</td>
                    <td className="nowrap"><span className={`pill ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                    <td className="col-name">{r.link_id ? <Link href={`/links/${r.link_id}`}>{r.name}</Link> : (r.name ?? '')}</td>
                    <td>{r.referral_code}</td>
                    <td>{r.media}</td>
                    <td className="nowrap">
                      {r.short_url && <>{r.short_url} <CopyButton text={r.short_url} /></>}
                    </td>
                    <td className="ellipsis" title={r.destination_url}>{r.destination_url}</td>
                    <td className="muted">{r.message ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {courseId && (
        <section style={{ marginTop: '2rem' }}>
          <div className="title-row">
            <h2>보관된 트래킹 링크 <span className="muted small">{courseName}{stored ? ` · ${stored.length}건` : ''}</span></h2>
            {stored && stored.length > 0 && (
              <div className="actions">
                <CopyButton text={tsv(stored)} label="전체 표 복사" ariaLabel="보관된 트래킹 링크 표를 엑셀 붙여넣기용으로 복사" />
                <a className="button small secondary" href={`/internal/tracking-links/export?course_id=${encodeURIComponent(courseId)}`} download>엑셀 다운로드</a>
              </div>
            )}
          </div>
          {storedError && <p className="error">{storedError}</p>}
          {stored && stored.length === 0 && <p className="muted">아직 이 강의로 만든 트래킹 링크가 없습니다.</p>}
          {stored && stored.length > 0 && (
            <div className="table-wrap">
              <table className="table small">
                <thead>
                  <tr><th>이름</th><th>추천코드</th><th>진행매체</th><th>짧은 주소</th><th>URL</th><th>상태</th><th>만든 시각</th><th>엑셀</th></tr>
                </thead>
                <tbody>
                  {stored.map((r) => (
                    <tr key={r.id}>
                      <td className="col-name"><Link href={`/links/${r.link_id}`}>{r.name}</Link></td>
                      <td>{r.referral_code}</td>
                      <td>{r.media}</td>
                      <td className="nowrap">{r.status !== 'deleted' ? <>{r.short_url} <CopyButton text={r.short_url} /></> : <s>{r.short_url}</s>}</td>
                      <td className="ellipsis" title={r.destination_url}>{r.destination_url}</td>
                      <td className="nowrap">{LINK_STATUS[r.status]}</td>
                      <td className="nowrap">{formatKst(r.created_at)}</td>
                      <td className="muted ellipsis" title={r.file_name}>{r.file_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
