// 짧은 주소 유형(type_key) 관리 — 최고관리자 전용 운영 절차
// 일반 발급용 API 키로는 유형을 추가·수정할 수 없다. DB 접속 권한이 있는 운영자만 실행한다.
//
//   npm run types -- list
//   npm run types -- add <key> "<label>"        (key: ^[a-z][a-z0-9_]{0,63}$)
//   npm run types -- rename <key> "<label>"
//   npm run types -- deactivate <key>           (이미 발급된 링크의 이동은 계속 동작)
//   npm run types -- activate <key>
//
// 운영 DB 대상: npm run types:prod -- <명령>
// key 는 변경·삭제할 수 없고, 다른 용도로 재사용하지 않는다. 새 용도에는 새 key 를 만든다.
import postgres from 'postgres';

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const [cmd, key, label] = process.argv.slice(2);
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL 이 필요합니다.'); process.exit(1); }
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

function fail(msg) { console.error(msg); process.exitCode = 1; }
function needKey() { if (!key || !KEY_RE.test(key)) { fail('key 형식: 소문자 영문으로 시작, 소문자 영문·숫자·밑줄, 1~64자'); return false; } return true; }
function needLabel() { const l = (label ?? '').trim(); if (!l || [...l].length > 120) { fail('label: 1~120자'); return null; } return l; }

try {
  if (cmd === 'list' || !cmd) {
    console.table(await sql`select key, label, active, created_at, updated_at from bzup.short_link_types order by key collate "C"`);
  } else if (cmd === 'add') {
    const l = needKey() && needLabel();
    if (l) {
      const r = await sql`insert into bzup.short_link_types (key, label) values (${key}, ${l}) on conflict (key) do nothing returning key`;
      if (r.length) console.log(`추가: ${key} (${l})`);
      else fail(`이미 있는 key 입니다: ${key} — 기존 용도를 확인하고, 다른 용도라면 새 key 를 사용하세요.`);
    }
  } else if (cmd === 'rename') {
    const l = needKey() && needLabel();
    if (l) {
      const r = await sql`update bzup.short_link_types set label = ${l} where key = ${key} returning key`;
      r.length ? console.log(`이름 변경: ${key} → ${l}`) : fail(`없는 key: ${key}`);
    }
  } else if (cmd === 'deactivate' || cmd === 'activate') {
    if (needKey()) {
      const r = await sql`update bzup.short_link_types set active = ${cmd === 'activate'} where key = ${key} returning key`;
      r.length ? console.log(`${cmd === 'activate' ? '활성화' : '비활성화'}: ${key}`) : fail(`없는 key: ${key}`);
    }
  } else {
    fail('명령: list | add <key> "<label>" | rename <key> "<label>" | deactivate <key> | activate <key>');
  }
} finally {
  await sql.end();
}
