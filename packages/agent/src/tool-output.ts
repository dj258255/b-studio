/**
 * 도구 결과 예산과 자르기를 한 곳에 모은 순수 함수들.
 *
 * E2 실행 8회의 세션 기록에서 도구 결과가 토큰 누수의 대부분이었다(run_in_service 70%·http_request 14%·read_file 11%).
 * 결과는 실행이 끝날 때까지 컨텍스트에 남아 뒤 턴마다 캐시 읽기로 다시 계산되므로, 결과 본문을 줄이는 것이 곧 비용을 줄인다.
 * 여기서는 자르기 규칙만 정의하고, 실제 적용은 tools.ts가 한다(테스트가 쉽도록 순수 함수로 둔다).
 */

/**
 * 명령 출력(stdout+stderr 합) 예산. 가장 큰 누수원(run_in_service)이라 가장 작게 둔다.
 * 테스트·빌드 로그의 실패 요약은 **뒤**에 있으므로(clipCommandOutput) 뒤쪽을 더 남긴다.
 */
export const COMMAND_OUTPUT_BUDGET = 6_000;
/** HTTP 응답 본문 예산. HTML이면 태그를 벗긴 "보이는 글자" 기준으로 이 값을 적용한다(http_request 14%) */
export const HTTP_BODY_BUDGET = 4_000;
/** read_file 예산. 파일은 앞에서부터 읽는 경우가 많아 앞쪽 위주로 남긴다(기존 30,000에서 줄임) */
export const READ_FILE_BUDGET = 12_000;
/** service_logs는 줄 수 상한(1-400)을 그대로 두고, 글자 상한만 지금 값을 유지한다 */
export const LOGS_OUTPUT_LIMIT = 30_000;

/**
 * 에이전트의 자가 확인 범위. full은 지금과 같고, lean은 게이트가 어차피 하는 확인(전체 빌드·테스트, 끝난 변경의 재시작·HTTP 확인)을
 * 에이전트가 되풀이하지 않게 안내하고, 성공한 명령의 출력을 짧게 돌려준다.
 * E6에서 b-studio의 호출은 그냥 Claude Code의 3.4배였고, 문맥 합의 32.7%가 run_in_service 결과를 다시 읽은 양이었다.
 */
export type SelfCheckMode = 'full' | 'lean';

/** lean에서 성공한(종료 코드 0) 명령 출력 예산. 성공 로그는 대개 "통과"만 알면 되므로 끝부분 위주로 짧게 남긴다 */
export const LEAN_SUCCESS_OUTPUT_BUDGET = 800;

/** 자른 사실을 숨기지 않고 한 줄로 알린다 */
function clipNote(total: number, omitted: number, hint?: string): string {
  return `[... 전체 ${total}자 중 ${omitted}자 생략${hint ? `. ${hint}` : ''} ...]`;
}

/**
 * 명령 출력은 뒤쪽 위주로 남긴다(앞 25%·뒤 75%). 긴 테스트·빌드 로그의 실패 요약이 뒤에 있기 때문이다.
 * gzip처럼 스트림이 이상해도 안전하도록 코드 유닛이 아니라 UTF-16 슬라이스로 자른다(서로게이트 페어가 갈라질 수 있음은 감수).
 */
export function clipCommandOutput(text: string, budget: number = COMMAND_OUTPUT_BUDGET): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.25);
  const tail = budget - head;
  return `${text.slice(0, head)}\n${clipNote(text.length, text.length - budget, '필요하면 grep·tail로 좁혀 다시 실행')}\n${text.slice(-tail)}`;
}

/** 파일 등 일반 글은 앞쪽 위주로 남긴다(앞 80%·뒤 20%). 처음부터 읽는 경우가 많다 */
export function clipText(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.8);
  const tail = budget - head;
  return `${text.slice(0, head)}\n${clipNote(text.length, text.length - budget)}\n${text.slice(-tail)}`;
}

/**
 * HTML에서 보이는 글자만 남긴다. `<script>`·`<style>`·`<noscript>`와 주석을 **먼저 통째로** 지워
 * 스크립트 안의 `<`가 태그로 해석되지 않게 한다(개발 서버 페이지의 스크립트가 13,430자였다).
 * 그다음 나머지 태그를 벗기고, 기본 엔티티를 풀고, 공백을 정리한다. `<title>` 글자는 태그만 벗겨 남는다.
 */
export function visibleHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // &amp;는 마지막에 푼다. 먼저 풀면 &amp;lt;가 <로 잘못 풀린다
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTML인지 판별한다. content-type이 우선이고, 없으면 문서 시작으로 본다 */
export function isHtmlContent(contentType: string | undefined, text: string): boolean {
  if (contentType && /(text\/html|application\/xhtml\+xml)/i.test(contentType)) return true;
  return /^\s*(<!doctype html|<html[\s>])/i.test(text);
}

/** 반복 결과 대체 문구의 접두어. token-report가 이 문구로 "같은 결과 반복"을 센다 */
export const REPEAT_NOTE_PREFIX = '(앞의 ';

/** 앞선 같은 호출의 결과와 같을 때 본문 대신 돌려주는 문구 */
export function repeatNote(call: number): string {
  return `${REPEAT_NOTE_PREFIX}${call}번째 호출 결과와 같습니다)`;
}

/** 어떤 결과가 반복 대체 문구인지 */
export function isRepeatNote(text: string): boolean {
  return text.startsWith(REPEAT_NOTE_PREFIX) && text.endsWith('번째 호출 결과와 같습니다)');
}

/**
 * 실행 단위 도구 결과 캐시. 한 실행(runAgent 한 번) 안에서 같은 도구·같은 입력의 결과가 앞과 완전히 같으면
 * 본문 대신 "(앞의 N번째 호출 결과와 같습니다)"를 돌려 결과 글자를 줄인다. 러너가 실행마다 새로 만든다.
 */
export interface ToolResultCache {
  /** `도구이름\u0000입력` → 앞선 호출의 본문과 순번 */
  entries: Map<string, { content: string; call: number }>;
  /** 이 실행에서 지금까지 실행한 도구 호출 수 */
  calls: number;
}

export function createToolResultCache(): ToolResultCache {
  return { entries: new Map(), calls: 0 };
}

/** 같은 도구·같은 입력의 결과가 앞과 완전히 같으면 본문 대신 참조를 돌려준다. 돌려준 값이 모델에게 간다 */
export function dedupeResult(cache: ToolResultCache, name: string, input: unknown, content: string): string {
  cache.calls += 1;
  const key = `${name}\u0000${stableKey(input)}`;
  const previous = cache.entries.get(key);
  if (previous && previous.content === content) return repeatNote(previous.call);
  cache.entries.set(key, { content, call: cache.calls });
  return content;
}

/** 쓰기 도구가 성공하면 read_file·list_files 캐시를 비운다. 같은 경로를 다시 읽으면 내용이 달라졌을 수 있다 */
export function invalidateReadCache(cache: ToolResultCache): void {
  for (const key of cache.entries.keys()) {
    const name = key.slice(0, key.indexOf('\u0000'));
    if (name === 'read_file' || name === 'list_files') cache.entries.delete(key);
  }
}

/** 입력 객체의 키 순서가 달라도 같은 키가 되도록 정렬해 직렬화한다 */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}
