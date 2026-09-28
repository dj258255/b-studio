/**
 * 로컬 ChatGPT Agent(Codex) 모드는 대화를 이어받지 못한다(설치된 SDK에 fork 경로가 없다).
 * 그래서 대화 기록 전체 대신 지난 요청의 요약만 짧게 넘긴다.
 * 근거: docs/research/2026-09-25-knowledge-sharing-and-model-handoff.md 1.3·3.3
 */

/** 지난 요청 하나의 요약 */
export interface CodexRunSummary {
  request: string;
  summary: string;
  status: string;
}

export const CODEX_RECENT_LIMIT = 3;
/** 요약에 넣는 요청 앞부분의 글자 수 */
export const CODEX_REQUEST_CHARS = 200;
/** 요약에 넣는 결과 앞부분의 글자 수 */
export const CODEX_SUMMARY_CHARS = 300;
/** 요청 앞에 붙이는 블록 전체의 글자 수 상한 */
export const CODEX_CONTEXT_LIMIT = 2_000;

const HEADER = '[이전 요청]';

/** 실행이 끝난 요청을 뒤에 붙이고 최근 3개만 남긴다 */
export function rememberCodexRun(recent: readonly CodexRunSummary[], entry: CodexRunSummary): CodexRunSummary[] {
  return [...recent, entry].slice(-CODEX_RECENT_LIMIT);
}

/**
 * 요청 앞에 붙일 짧은 이전 맥락. 기록이 없으면 빈 문자열이라 붙이지 않는다.
 * 3개를 다 넣어 상한을 넘으면 오래된 것부터 하나씩 뺀다. 하나만 남아도 넘으면 그때 자른다.
 * limit은 상한을 낮춰 확인할 때만 바꾼다.
 */
export function codexContextBlock(recent: readonly CodexRunSummary[], limit = CODEX_CONTEXT_LIMIT): string {
  const lines = recent
    .slice(-CODEX_RECENT_LIMIT)
    .map((entry) => `- ${clip(entry.request, CODEX_REQUEST_CHARS)} → ${entry.status}: ${clip(entry.summary, CODEX_SUMMARY_CHARS)}`);
  while (lines.length > 1 && blockSize(lines) > limit) lines.shift();
  if (lines.length === 0) return '';
  const block = [HEADER, ...lines].join('\n');
  return block.length > limit ? block.slice(0, limit) : block;
}

function blockSize(lines: readonly string[]): number {
  return [HEADER, ...lines].join('\n').length;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
