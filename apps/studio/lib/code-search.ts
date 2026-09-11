/** 코드 탭의 내용 찾기. 파일을 읽는 일은 서버가 하고, 줄을 고르는 규칙만 따로 두어 테스트한다 */
export interface CodeMatch {
  /** 1부터 세는 줄 번호 */
  line: number;
  /** 보여 줄 줄 내용. 아주 긴 줄은 맞은 자리 주변만 남긴다 */
  text: string;
  /** text 안에서 맞은 자리 */
  start: number;
  length: number;
}

export interface MatchOptions {
  /** 한 파일에서 보여 줄 최대 줄 수 */
  limit?: number;
  /** 한 줄에서 보여 줄 최대 글자 수 */
  maxLength?: number;
}

const ELLIPSIS = '…';
/** 널 바이트가 있으면 바이너리로 본다. 소스에 제어 문자를 그대로 두지 않으려고 코드로 만든다 */
const NUL = String.fromCharCode(0);

/** 대소문자를 가리지 않고 찾는다. 빈 검색어이거나 바이너리 파일이면 찾지 않는다 */
export function matchLines(content: string, query: string, { limit = 5, maxLength = 200 }: MatchOptions = {}): CodeMatch[] {
  const needle = query.toLowerCase();
  if (!needle || content.includes(NUL)) return [];

  const matches: CodeMatch[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length && matches.length < limit; index++) {
    const text = lines[index]!;
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    matches.push({ line: index + 1, ...trimAround(text, at, needle.length, maxLength) });
  }
  return matches;
}

/** 긴 줄은 맞은 자리가 가운데 오도록 잘라, 어디가 맞았는지 보이게 한다 */
function trimAround(text: string, at: number, length: number, maxLength: number): { text: string; start: number; length: number } {
  if (text.length <= maxLength) return { text, start: at, length };
  const room = Math.max(0, maxLength - length);
  const from = Math.max(0, Math.min(at - Math.floor(room / 2), text.length - maxLength));
  const to = Math.min(text.length, from + maxLength);
  const head = from > 0 ? ELLIPSIS : '';
  const tail = to < text.length ? ELLIPSIS : '';
  return { text: `${head}${text.slice(from, to)}${tail}`, start: at - from + head.length, length };
}
