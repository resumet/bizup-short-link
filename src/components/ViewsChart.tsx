import type { DailyViews } from '@/lib/services/views';
import { formatKst } from '@/lib/time';

/** 최근 N일 일자별 조회수 막대 (서버 렌더링, 스크립트 없음) */
export function ViewsChart({ views }: { views: DailyViews }) {
  const max = Math.max(1, ...views.daily.map((d) => d.views));
  const recent7 = views.daily.slice(-7).reduce((s, d) => s + d.views, 0);
  const today = views.daily[views.daily.length - 1]?.views ?? 0;
  const first = views.daily[0]?.date ?? '';
  const last = views.daily[views.daily.length - 1]?.date ?? '';
  return (
    <div className="card">
      <div className="views-summary">
        <div className="stat"><strong>{views.total_views.toLocaleString('ko-KR')}</strong><span>총조회수</span></div>
        <div className="stat"><strong>{today.toLocaleString('ko-KR')}</strong><span>오늘</span></div>
        <div className="stat"><strong>{recent7.toLocaleString('ko-KR')}</strong><span>최근 7일</span></div>
        <div className="stat">
          <strong style={{ fontSize: '1rem', paddingTop: '0.625rem' }}>{views.last_viewed_at ? formatKst(views.last_viewed_at) : '-'}</strong>
          <span>마지막 조회</span>
        </div>
      </div>
      <div className="bars" role="img" aria-label={`최근 ${views.daily.length}일 일자별 조회수`}>
        {views.daily.map((d) => (
          <div
            key={d.date}
            className={`bar${d.views === 0 ? ' zero' : ''}`}
            style={{ height: d.views === 0 ? '2px' : `${Math.max(4, (d.views / max) * 100)}%` }}
            title={`${d.date} · ${d.views.toLocaleString('ko-KR')}회`}
          />
        ))}
      </div>
      <div className="bars-axis"><span>{first}</span><span>{last} (한국 시간)</span></div>
    </div>
  );
}
