/**
 * 로그 탭에서 한 줄을 강조 표시할 때 쓰는 순수 함수들. 정규식은 모듈 위에서 한 번만 만들어 두고,
 * 한 줄마다 O(줄 길이)로만 훑어 1,000줄이 넘어도 빠르다.
 */

export type LogTone = 'fail' | 'wait' | 'muted' | 'pass' | 'platform';

export interface LogToken {
  content: string;
  tone?: LogTone;
}

interface Span {
  start: number;
  end: number;
  tone: LogTone;
}

const PLATFORM_PREFIX = '[b-studio]';

/** 시각. ISO(2024-01-01T12:00:00.123Z)와 맨 시:분:초(12:00:00.123)를 모두 찾는다 */
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
/** HTTP 상태 코드. 2xx/4xx/5xx만 다루고(3xx는 강조 대상이 아님) 앞뒤가 글자·숫자가 아니어야 한다 */
const STATUS_CODE = /\b(?:2\d{2}|4\d{2}|5\d{2})\b/g;
/** 상태 코드는 HTTP 줄에서만 찾는다. 없으면 "494 kB"처럼 크기·포트 숫자가 오류 색으로 칠해졌다(실제 db 로그에서 발견) */
const HTTP_CONTEXT = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|\bHTTP\/|\bstatus\b/i;

/** ANSI SGR(색·굵기) 이스케이프. `\x1b[` 뒤에 숫자와 세미콜론이 오고 `m`으로 끝난다 */
const ANSI_SGR = /\x1b\[([0-9;]*)m/g;

/** 자주 쓰는 기본 전경색 코드만 톤으로 옮긴다. 그 외 코드(굵게, 배경색 등)는 이스케이프만 지우고 무시한다 */
const ANSI_FOREGROUND_TONE: Partial<Record<string, LogTone>> = {
  '2': 'muted',
  '31': 'fail',
  '91': 'fail',
  '32': 'pass',
  '92': 'pass',
  '33': 'wait',
  '93': 'wait',
  '90': 'muted',
  '37': 'muted',
};

/**
 * 줄 전체의 성격을 정한다. 우선순위: b-studio 플랫폼 줄 > 스택 트레이스/에러 > 경고.
 * INFO·DEBUG는 줄 전체가 아니라 그 단어만 흐리게 한다(Spring처럼 거의 모든 줄에 INFO가 있으면 로그가 통째로 흐려진다).
 * 아무 것도 아니면 undefined(기본 색)를 돌려준다
 */
export function classifyLine(text: string): LogTone | undefined {
  if (text.startsWith(PLATFORM_PREFIX)) return 'platform';
  if (isStackTraceLine(text)) return 'fail';
  if (/\b(error|exception|fail(?:ed|ure)?)\b/i.test(text)) return 'fail';
  if (/\bwarn(?:ing)?\b/i.test(text)) return 'wait';
  return undefined;
}

/** 스택 트레이스 줄: 들여쓴 "at …"(Java·Node), "Caused by:", "... N more" */
const STACK_TRACE = /^\s*(?:at\s|Caused by:|\.\.\. \d+ more)/;
function isStackTraceLine(text: string): boolean {
  return STACK_TRACE.test(text);
}

/** 로그 수준 단어 INFO·DEBUG·TRACE. 그 단어만 흐리게 한다 */
const QUIET_LEVEL = /\b(?:INFO|DEBUG|TRACE)\b/g;

/** ANSI 이스케이프 코드를 지운 순수 문자열만 필요할 때 */
export function stripAnsi(text: string): string {
  return splitAnsi(text).text;
}

/** ANSI 이스케이프를 지우면서, 기본 전경색이 칠해진 구간을 톤과 함께 남긴다 */
function splitAnsi(rawText: string): { text: string; colorSpans: Span[] } {
  if (!rawText.includes('\x1b')) return { text: rawText, colorSpans: [] };

  const colorSpans: Span[] = [];
  let text = '';
  let current: LogTone | undefined;
  let spanStart = 0;
  let lastIndex = 0;
  ANSI_SGR.lastIndex = 0;

  const closeSpan = (endInClean: number) => {
    if (current && endInClean > spanStart) colorSpans.push({ start: spanStart, end: endInClean, tone: current });
  };

  let match: RegExpExecArray | null;
  while ((match = ANSI_SGR.exec(rawText))) {
    text += rawText.slice(lastIndex, match.index);
    closeSpan(text.length);
    spanStart = text.length;

    const codes = match[1] ? match[1].split(';') : ['0'];
    for (const code of codes) {
      if (code === '' || code === '0') current = undefined;
      else if (code in ANSI_FOREGROUND_TONE) current = ANSI_FOREGROUND_TONE[code];
    }
    lastIndex = ANSI_SGR.lastIndex;
  }
  text += rawText.slice(lastIndex);
  closeSpan(text.length);

  return { text, colorSpans };
}

/** 시각·상태 코드 구간을 찾는다(줄 안 어디든). 서로 겹치면 먼저 찾은 쪽(시각)을 남긴다 */
function findPatternSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(TIMESTAMP)) spans.push({ start: match.index, end: match.index + match[0].length, tone: 'muted' });
  for (const match of text.matchAll(QUIET_LEVEL)) spans.push({ start: match.index, end: match.index + match[0].length, tone: 'muted' });
  const statusCodes = HTTP_CONTEXT.test(text) ? text.matchAll(STATUS_CODE) : [];
  for (const match of statusCodes) {
    const code = Number(match[0]);
    spans.push({ start: match.index, end: match.index + match[0].length, tone: code < 300 ? 'pass' : 'fail' });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  const result: Span[] = [];
  let lastEnd = -1;
  for (const span of spans) {
    if (span.start < lastEnd) continue;
    result.push(span);
    lastEnd = span.end;
  }
  return result;
}

/**
 * 로그 한 줄을 강조용 조각으로 나눈다. ANSI를 지우고, 줄 전체 톤(에러·경고 등)을 정한 뒤,
 * 시각·상태 코드처럼 더 구체적인 구간이 있으면 그 자리만 다른 톤으로 덮어쓴다.
 * ANSI 색은 줄 전체 톤이 정해지지 않았을 때만 바탕으로 쓴다(줄 색이 이미 있으면 그게 더 믿을 만하다)
 */
export function highlightLogLine(rawLine: string): LogToken[] {
  const { text, colorSpans } = splitAnsi(rawLine);
  if (text.length === 0) return [{ content: '' }];

  const lineTone = classifyLine(text);
  const tones = new Array<LogTone | undefined>(text.length).fill(lineTone);

  if (!lineTone) {
    for (const span of colorSpans) for (let index = span.start; index < span.end; index++) tones[index] = span.tone;
  }
  for (const span of findPatternSpans(text)) for (let index = span.start; index < span.end; index++) tones[index] = span.tone;

  return coalesce(text, tones);
}

/** 같은 톤이 이어지는 구간을 하나의 조각으로 합쳐, 그리기 비용을 줄인다 */
function coalesce(text: string, tones: Array<LogTone | undefined>): LogToken[] {
  const tokens: LogToken[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index++) {
    if (index === text.length || tones[index] !== tones[start]) {
      const tone = tones[start];
      tokens.push(tone ? { content: text.slice(start, index), tone } : { content: text.slice(start, index) });
      start = index;
    }
  }
  return tokens;
}
