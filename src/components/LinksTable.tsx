import Link from 'next/link';
import type { listLinks } from '@/lib/services/link-query';
import { formatKst } from '@/lib/time';
import { StatusPill } from '@/components/TopBar';
import { CopyButton } from '@/components/CopyButton';

const CREATION_LABEL = { single: '단건', batch: '자동생성', tracking: '트래킹' } as const;

const TAIL = 18;

/** 긴 주소는 가운데를 줄여 앞부분과 끝부분을 함께 보여준다 (열 너비에 맞춰 앞부분이 줄어듦). 전체 주소는 마우스를 올리면 보인다. */
function MiddleEllipsis({ text }: { text: string }) {
  const shown = text.replace(/^https?:\/\//, '');
  const head = shown.length > TAIL ? shown.slice(0, -TAIL) : shown;
  const tail = shown.length > TAIL ? shown.slice(-TAIL) : '';
  return (
    <span className="mid-ellipsis" title={text}>
      <span className="head">{head}</span>
      {tail && <span className="tail">{tail}</span>}
    </span>
  );
}

type LinkItem = Awaited<ReturnType<typeof listLinks>>['data'][number];

/** 링크 목록 표 (링크 목록·강의별 링크 화면 공용). showCourse=false 면 강의 열을 숨긴다. */
export function LinksTable({ links, showCourse = true }: { links: LinkItem[]; showCourse?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>유형</th><th>명칭</th><th>짧은 주소</th><th>현재 목적지</th>{showCourse && <th>강의</th>}
            <th>상태</th><th className="right">조회수</th><th>생성</th><th>최종 수정</th>
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.id}>
              <td className="nowrap num">{l.type_key ? <span title={l.type_key}>{l.type_label ?? l.type_key}</span>
                : l.creation_mode === 'tracking' ? <span title="엑셀 업로드로 만든 트래킹 링크">트래킹</span>
                : <span className="muted">-</span>}</td>
              <td className="col-name"><Link href={`/links/${l.id}`}>{l.name}</Link></td>
              <td className="nowrap"><span className="short"><code>{l.short_url.replace(/^https?:\/\//, '')}</code><CopyButton text={l.short_url} /></span></td>
              <td className="col-dest">
                <span className="dest">
                  {l.active_slot_label && <span className="pill on plain">{l.active_slot_label}</span>}
                  <MiddleEllipsis text={l.destination_url} />
                  <CopyButton text={l.destination_url} ariaLabel="현재 목적지 복사" />
                </span>
              </td>
              {showCourse && (
                <td className="col-course">
                  {l.course_name ?? <span className="muted">미분류</span>}
                  {l.course_status === 'closed' && <span className="sub">종료된 강의</span>}
                </td>
              )}
              <td><StatusPill status={l.status} /></td>
              <td className="right num">{l.total_views.toLocaleString('ko-KR')}</td>
              <td className="col-meta">
                {l.source === 'web' ? '웹' : 'API'} · {CREATION_LABEL[l.creation_mode]}
                <span className="sub">{l.created_by.label} · {formatKst(l.created_at)}</span>
              </td>
              <td className="nowrap num">{formatKst(l.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
