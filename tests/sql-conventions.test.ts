import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// postgres.js 는 `$n::jsonb` 파라미터에 넘긴 JSON 문자열을 다시 JSON 인코딩한다(문자열 jsonb 로 저장됨).
// PGlite 테스트로는 드러나지 않으므로 소스 규칙으로 막는다: 항상 `$n::text::jsonb` 를 사용한다.
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []);
}

describe('SQL 규칙', () => {
  it('jsonb 파라미터는 $n::text::jsonb 로 캐스팅한다', () => {
    const offenders = walk(path.resolve(__dirname, '../src'))
      .filter((f) => /\$\d+::jsonb/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });
});
