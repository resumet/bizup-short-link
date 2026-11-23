// 코드포인트 범위로 문자 클래스 정규식을 만든다 (소스에 보이지 않는 문자를 직접 쓰지 않기 위함).
export function charClass(ranges: [number, number][]): RegExp {
  const hex = (n: number) => `\\u{${n.toString(16)}}`;
  const body = ranges.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('');
  return new RegExp(`[${body}]`, 'u');
}
