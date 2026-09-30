/**
 * 세션 기록에서 "에이전트가 되풀이하는 행동"을 찾는다(순수 함수, ADR-077).
 *
 * 실무자 조언: 며칠 쓰고 나면 로그에서 같은 명령·같은 탐색 순서·같은 큰 파일 읽기가 반복되는 것이 보인다.
 * 그걸 스크립트(또는 노트 한 줄)로 굳히면 다음부터는 모델이 토큰을 써서 다시 유도할 필요가 없다
 * (Anthropic Agent Skills: "정렬을 토큰 생성으로 하는 것은 정렬 알고리즘을 돌리는 것보다 훨씬 비싸다").
 *
 * 세 가지를 찾는다.
 *  (a) 거의 같은 `run_in_service` 명령이 실행 3번 이상, 서로 다른 실행 2개 이상에서 반복됨 → 스크립트 제안
 *  (b) 같은 도구 2~4개가 같은 순서로 실행 3개 이상에서 반복됨(예: list_files → read_file X → run_in_service "gradle test") → 스크립트 제안
 *  (c) 같은 파일을 `read_file`로 크게(예산을 넘게) 실행 3개 이상에서 다시 읽음 → 노트 요약 제안
 *
 * 입력은 세션별 StudioEvent 기록이다. 호출자(서버)가 프로젝트의 세션을 최근 것부터 모아 넘기고,
 * 이 모듈은 세션 수·실행 수를 상한으로 자른다(오래된 기록을 계속 다시 분석해 비용이 늘지 않게).
 */
import type { StudioEvent } from './studio-events';

export type RepeatedActionKind = 'command' | 'sequence' | 'big_read';

/** 후보 하나를 보여줄 예시 하나(원문 그대로, 정규화 전) */
export interface RepeatedActionExample {
  runId: string;
  sessionId: string;
  input: string;
}

export interface RepeatedActionSuggestion {
  /** scripts/<name>.sh 후보 이름(명령·순서 후보에만 있다) */
  scriptName?: string;
  /** 초안 스크립트 본문(셸). 사람이 검토해 고친 뒤 쓴다 */
  scriptBody?: string;
  /** 큰 반복 읽기용 안내 문구(파일 후보에만 있다) */
  noteText?: string;
}

export interface RepeatedActionCandidate {
  /** kind와 정규화한 신호로 만든 안정적인 id(무시 목록에 쓴다) */
  id: string;
  kind: RepeatedActionKind;
  /** 사람이 읽을 한 줄 요약 */
  title: string;
  /** 겹친 횟수(같은 실행 안 반복도 센다) */
  occurrences: number;
  /** 관련 실행(run) 수(distinct) */
  runCount: number;
  /** 관련 세션 수(distinct) */
  sessionCount: number;
  runIds: string[];
  sessionIds: string[];
  /** 도구 결과 글자 수 합(토큰 비용 대리 지표) */
  totalChars: number;
  examples: RepeatedActionExample[];
  suggestion: RepeatedActionSuggestion;
}

export interface RepeatedActionsSessionInput {
  sessionId: string;
  events: readonly StudioEvent[];
}

export interface RepeatedActionsOptions {
  /** 볼 세션 수 상한(호출자가 최근 것부터 넘긴다고 가정). 기본 20 */
  maxSessions?: number;
  /** 볼 실행 수 상한(세션을 합쳐서). 기본 200 */
  maxRuns?: number;
}

export const DEFAULT_MAX_SESSIONS = 20;
export const DEFAULT_MAX_RUNS = 200;

/** (a) 같은 명령이 이 횟수 넘게 반복돼야 후보가 된다 */
export const MIN_COMMAND_OCCURRENCES = 3;
/** (a) 그 반복이 서로 다른 실행 이 개수 넘게 걸쳐 있어야 한다 */
export const MIN_COMMAND_RUNS = 2;
/** (b) 같은 순서가 서로 다른 실행 이 개수 넘게 나와야 한다 */
export const MIN_SEQUENCE_RUNS = 3;
/** (b) 후보로 볼 도구 호출 순서 길이(2~4개) */
export const SEQUENCE_MIN_LEN = 2;
export const SEQUENCE_MAX_LEN = 4;
/** (c) read_file 결과가 이 글자를 넘어야 "크다"고 본다(명령·출력 예산 6,000자와 같은 기준, token-report.ts BIG_RESULT_CHARS) */
export const BIG_READ_CHARS = 4_000;
/** (c) 같은 파일을 크게 다시 읽는 반복이 서로 다른 실행 이 개수 넘게 나와야 한다 */
export const MIN_BIG_READ_RUNS = 3;

const MAX_EXAMPLES = 3;

// ---------- 정규화 ----------

const TEMP_PATH_RE = /(?:\/private)?\/(?:tmp|var\/folders)\/[^\s"'`]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g;
/** 10~13자리 숫자(초·밀리초 단위 epoch). 일반 숫자 인자와 헷갈리지 않게 자릿수를 넉넉히 잡는다 */
const EPOCH_RE = /\b\d{10,13}\b/g;
const PORT_RE = /(:|--port[= ]?|-p[= ])(\d{2,5})\b/gi;

/** 임시 경로·uuid·시각·포트처럼 실행마다 달라지는 부분을 표시자로 바꾼다. 그룹핑 키에만 쓰고, 예시 문구는 원문을 그대로 둔다 */
export function stripVolatile(text: string): string {
  return text
    .replace(TEMP_PATH_RE, '<tmp>')
    .replace(UUID_RE, '<uuid>')
    .replace(ISO_TIMESTAMP_RE, '<timestamp>')
    .replace(PORT_RE, (_match, prefix: string) => `${prefix}<port>`)
    .replace(EPOCH_RE, '<epoch>');
}

/** 앞뒤 공백을 없애고 연속 공백을 하나로 줄인다 */
export function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** run_in_service 명령을 그룹핑용 키로 만든다: 서비스 이름 + 인자, 공백 정리 + 변동 부분 표시자화 */
export function normalizeCommandText(service: string, command: readonly string[]): string {
  return normalizeWhitespace(stripVolatile(`${service} ${command.join(' ')}`));
}

// ---------- 실행 추출 ----------

interface RunCall {
  name: string;
  input: unknown;
  chars: number;
}

interface RunRecord {
  runId: string;
  sessionId: string;
  calls: RunCall[];
}

/** 세션 기록에서 실행별 도구 호출 목록을 뽑는다(token-report.ts의 tool_call/tool_result 짝짓기와 같은 규칙) */
function extractRuns(sessions: readonly RepeatedActionsSessionInput[]): RunRecord[] {
  const runs: RunRecord[] = [];
  for (const session of sessions) {
    let current: RunRecord | undefined;
    let pending: Array<{ name: string; input: unknown }> = [];
    for (const event of session.events) {
      if (event.type === 'run_started') {
        current = { runId: event.runId, sessionId: session.sessionId, calls: [] };
        runs.push(current);
        pending = [];
        continue;
      }
      if (!current) continue;
      if (event.type === 'agent') {
        const inner = event.event;
        if (inner.type === 'tool_call') {
          pending.push({ name: inner.name, input: inner.input });
        } else if (inner.type === 'tool_result') {
          const index = pending.findIndex((call) => call.name === inner.name);
          const call = index === -1 ? { name: inner.name, input: {} } : pending.splice(index, 1)[0]!;
          current.calls.push({ name: call.name, input: call.input, chars: inner.chars ?? inner.content.length });
        }
        continue;
      }
      if (event.type === 'run_finished' && event.runId === current.runId) current = undefined;
    }
  }
  return runs;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function commandOf(input: unknown): { service: string; command: string[] } {
  const args = asRecord(input);
  const service = typeof args.service === 'string' ? args.service : '';
  const command = Array.isArray(args.command) ? args.command.filter((value): value is string => typeof value === 'string') : [];
  return { service, command };
}

/** 도구 호출 하나를 시퀀스 채굴·그룹핑에 쓸 정규화 신호로 만든다(도구 이름 + 정규화한 핵심 인자) */
function callSignature(name: string, input: unknown): string {
  const args = asRecord(input);
  switch (name) {
    case 'run_in_service': {
      const { service, command } = commandOf(input);
      return `${name}:${normalizeCommandText(service, command)}`;
    }
    case 'read_file':
    case 'list_files':
    case 'write_file':
    case 'edit_file':
    case 'delete_file': {
      const path = typeof args.path === 'string' ? args.path : '';
      return `${name}:${normalizeWhitespace(stripVolatile(path))}`;
    }
    case 'restart_service':
    case 'service_logs': {
      const service = typeof args.service === 'string' ? args.service : '';
      return `${name}:${service}`;
    }
    case 'http_request':
    case 'call_external_api': {
      const target = typeof args.service === 'string' ? args.service : typeof args.api === 'string' ? args.api : '';
      const method = typeof args.method === 'string' ? args.method : '';
      const path = typeof args.path === 'string' ? args.path : '';
      return `${name}:${normalizeWhitespace(stripVolatile(`${target} ${method} ${path}`))}`;
    }
    default:
      return name;
  }
}

/** 도구 호출 하나를 사람이 읽을 한 줄로(원문 그대로, 예시용) */
function callDisplay(name: string, input: unknown): string {
  const args = asRecord(input);
  switch (name) {
    case 'run_in_service': {
      const { service, command } = commandOf(input);
      return `${service} ${command.join(' ')}`.trim();
    }
    case 'read_file':
    case 'list_files':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return typeof args.path === 'string' ? args.path : name;
    case 'restart_service':
    case 'service_logs':
      return typeof args.service === 'string' ? args.service : name;
    default:
      return name;
  }
}

/** 안정적인 짧은 id(간단한 FNV-1a 변형). 파일명·JSON 키로 쓰기 안전하게 16진 8자리만 남긴다 */
function hashKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'repeated-action';
}

function examplesOf(occurrences: ReadonlyArray<{ runId: string; sessionId: string; display: string }>): RepeatedActionExample[] {
  const seen = new Set<string>();
  const examples: RepeatedActionExample[] = [];
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.runId)) continue;
    seen.add(occurrence.runId);
    examples.push({ runId: occurrence.runId, sessionId: occurrence.sessionId, input: occurrence.display });
    if (examples.length >= MAX_EXAMPLES) break;
  }
  return examples;
}

// ---------- (a) 반복 명령 ----------

interface CommandGroup {
  service: string;
  command: string[];
  occurrences: Array<{ runId: string; sessionId: string; chars: number; display: string }>;
}

function findRepeatedCommands(runs: readonly RunRecord[]): RepeatedActionCandidate[] {
  const groups = new Map<string, CommandGroup>();
  for (const run of runs) {
    for (const call of run.calls) {
      if (call.name !== 'run_in_service') continue;
      const { service, command } = commandOf(call.input);
      if (command.length === 0) continue;
      const key = normalizeCommandText(service, command);
      const group = groups.get(key) ?? { service, command, occurrences: [] };
      group.occurrences.push({ runId: run.runId, sessionId: run.sessionId, chars: call.chars, display: `${service} ${command.join(' ')}`.trim() });
      groups.set(key, group);
    }
  }

  const candidates: RepeatedActionCandidate[] = [];
  for (const [key, group] of groups) {
    const runIds = new Set(group.occurrences.map((occurrence) => occurrence.runId));
    if (group.occurrences.length < MIN_COMMAND_OCCURRENCES || runIds.size < MIN_COMMAND_RUNS) continue;
    const sessionIds = new Set(group.occurrences.map((occurrence) => occurrence.sessionId));
    const totalChars = group.occurrences.reduce((sum, occurrence) => sum + occurrence.chars, 0);
    const scriptName = slugify(`${group.service}-${group.command[0] ?? ''}`);
    const commandLine = `${group.command.join(' ')}`;
    candidates.push({
      id: `command-${hashKey(key)}`,
      kind: 'command',
      title: `${group.service} 서비스에서 "${commandLine}" 명령을 ${group.occurrences.length}번(실행 ${runIds.size}개에 걸쳐) 반복했습니다`,
      occurrences: group.occurrences.length,
      runCount: runIds.size,
      sessionCount: sessionIds.size,
      runIds: [...runIds],
      sessionIds: [...sessionIds],
      totalChars,
      examples: examplesOf(group.occurrences),
      suggestion: {
        scriptName,
        scriptBody: [
          '#!/bin/sh',
          `# 되풀이된 명령을 굳힌 스크립트. run_in_service(${group.service}, [...]) 대신 이 스크립트를 실행하세요.`,
          '# 이 서비스 컨테이너 안(서비스 루트가 작업 폴더)에서 실행한다고 가정합니다.',
          'set -e',
          group.command.map(shellQuote).join(' '),
          '',
        ].join('\n'),
      },
    });
  }
  return candidates;
}

function shellQuote(token: string): string {
  return /^[A-Za-z0-9_.\-/:@%]+$/.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`;
}

// ---------- (b) 반복 순서 ----------

interface SequenceAgg {
  tokens: string[];
  occurrences: Array<{ runId: string; sessionId: string; chars: number }>;
  exampleCalls: RunCall[];
}

function containsWindow(long: readonly string[], short: readonly string[]): boolean {
  if (short.length >= long.length) return false;
  for (let start = 0; start + short.length <= long.length; start += 1) {
    if (short.every((token, offset) => long[start + offset] === token)) return true;
  }
  return false;
}

function findRepeatedSequences(runs: readonly RunRecord[]): RepeatedActionCandidate[] {
  // 길이별로 따로 모은다(2, 3, 4). 인덱스 0이 길이 2
  const byLength: Array<Map<string, SequenceAgg>> = [new Map(), new Map(), new Map()];
  for (const run of runs) {
    const signatures = run.calls.map((call) => callSignature(call.name, call.input));
    for (let length = SEQUENCE_MIN_LEN; length <= SEQUENCE_MAX_LEN; length += 1) {
      const map = byLength[length - SEQUENCE_MIN_LEN]!;
      for (let start = 0; start + length <= signatures.length; start += 1) {
        const tokens = signatures.slice(start, start + length);
        const key = tokens.join('|');
        const calls = run.calls.slice(start, start + length);
        const agg = map.get(key) ?? { tokens, occurrences: [], exampleCalls: calls };
        const chars = calls.reduce((sum, call) => sum + call.chars, 0);
        agg.occurrences.push({ runId: run.runId, sessionId: run.sessionId, chars });
        map.set(key, agg);
      }
    }
  }

  // 긴 순서부터 후보로 뽑고, 이미 뽑힌 긴 순서 안에 통째로 들어가는 짧은 순서는 버린다(같은 반복을 두 번 보여주지 않는다)
  const accepted: SequenceAgg[] = [];
  for (let index = byLength.length - 1; index >= 0; index -= 1) {
    for (const agg of byLength[index]!.values()) {
      const runIds = new Set(agg.occurrences.map((occurrence) => occurrence.runId));
      if (runIds.size < MIN_SEQUENCE_RUNS) continue;
      if (accepted.some((longer) => longer.tokens.length > agg.tokens.length && containsWindow(longer.tokens, agg.tokens))) continue;
      accepted.push(agg);
    }
  }

  return accepted.map((agg) => buildSequenceCandidate(agg));
}

function buildSequenceCandidate(agg: SequenceAgg): RepeatedActionCandidate {
  const runIds = new Set(agg.occurrences.map((occurrence) => occurrence.runId));
  const sessionIds = new Set(agg.occurrences.map((occurrence) => occurrence.sessionId));
  const totalChars = agg.occurrences.reduce((sum, occurrence) => sum + occurrence.chars, 0);
  const key = agg.tokens.join('|');
  const displaySteps = agg.exampleCalls.map((call) => `${call.name}(${callDisplay(call.name, call.input)})`);
  const examples = examplesOf(
    agg.occurrences.map((occurrence) => ({ runId: occurrence.runId, sessionId: occurrence.sessionId, display: displaySteps.join(' → ') })),
  );
  const scriptName = slugify(displaySteps.map((step) => step.split('(')[0]).join('-'));
  return {
    id: `sequence-${hashKey(key)}`,
    kind: 'sequence',
    title: `${displaySteps.join(' → ')} 순서가 실행 ${runIds.size}개에서 반복됐습니다`,
    occurrences: agg.occurrences.length,
    runCount: runIds.size,
    sessionCount: sessionIds.size,
    runIds: [...runIds],
    sessionIds: [...sessionIds],
    totalChars,
    examples,
    suggestion: {
      scriptName,
      scriptBody: [
        '#!/bin/sh',
        '# 되풀이된 탐색·명령 순서를 굳힌 스크립트. 아래 단계를 대신 실행하세요.',
        'set -e',
        ...agg.exampleCalls.map((call) => scriptLineFor(call)),
        '',
      ].join('\n'),
    },
  };
}

function scriptLineFor(call: RunCall): string {
  const args = asRecord(call.input);
  switch (call.name) {
    case 'run_in_service': {
      const { command } = commandOf(call.input);
      return command.map(shellQuote).join(' ');
    }
    case 'read_file':
      return typeof args.path === 'string' ? `cat ${shellQuote(args.path)}` : '# read_file: 경로를 확인하세요';
    case 'list_files':
      return typeof args.path === 'string' ? `ls -la ${shellQuote(args.path)}` : '# list_files: 경로를 확인하세요';
    default:
      return `# ${call.name}은(는) 셸 명령이 아닙니다. 직접 옮기세요: ${callDisplay(call.name, call.input)}`;
  }
}

// ---------- (c) 반복해서 크게 읽는 파일 ----------

interface BigReadGroup {
  path: string;
  occurrences: Array<{ runId: string; sessionId: string; chars: number }>;
}

function findBigRepeatedReads(runs: readonly RunRecord[]): RepeatedActionCandidate[] {
  const groups = new Map<string, BigReadGroup>();
  for (const run of runs) {
    for (const call of run.calls) {
      if (call.name !== 'read_file' || call.chars < BIG_READ_CHARS) continue;
      const args = asRecord(call.input);
      const path = typeof args.path === 'string' ? args.path : '';
      if (!path) continue;
      const key = normalizeWhitespace(stripVolatile(path));
      const group = groups.get(key) ?? { path, occurrences: [] };
      group.occurrences.push({ runId: run.runId, sessionId: run.sessionId, chars: call.chars });
      groups.set(key, group);
    }
  }

  const candidates: RepeatedActionCandidate[] = [];
  for (const [key, group] of groups) {
    const runIds = new Set(group.occurrences.map((occurrence) => occurrence.runId));
    if (runIds.size < MIN_BIG_READ_RUNS) continue;
    const sessionIds = new Set(group.occurrences.map((occurrence) => occurrence.sessionId));
    const totalChars = group.occurrences.reduce((sum, occurrence) => sum + occurrence.chars, 0);
    candidates.push({
      id: `big_read-${hashKey(key)}`,
      kind: 'big_read',
      title: `"${group.path}" 파일을 크게(총 ${totalChars.toLocaleString('ko-KR')}자) ${group.occurrences.length}번(실행 ${runIds.size}개에서) 다시 읽었습니다`,
      occurrences: group.occurrences.length,
      runCount: runIds.size,
      sessionCount: sessionIds.size,
      runIds: [...runIds],
      sessionIds: [...sessionIds],
      totalChars,
      examples: examplesOf(group.occurrences.map((occurrence) => ({ ...occurrence, display: group.path }))),
      suggestion: {
        noteText: `"${group.path}" 요약을 프로젝트 노트에 남겨, 다음부터는 이 노트를 먼저 보게 하세요`,
      },
    });
  }
  return candidates;
}

// ---------- 공개 API ----------

/** 프로젝트 세션 기록에서 되풀이 후보를 찾는다. 글자 수(totalChars)가 큰 순서로 돌려준다 */
export function findRepeatedActions(
  sessions: readonly RepeatedActionsSessionInput[],
  options: RepeatedActionsOptions = {},
): RepeatedActionCandidate[] {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const capped = sessions.slice(0, maxSessions);
  const runs = extractRuns(capped).slice(0, maxRuns);
  return [...findRepeatedCommands(runs), ...findRepeatedSequences(runs), ...findBigRepeatedReads(runs)].sort(
    (a, b) => b.totalChars - a.totalChars,
  );
}

/**
 * "스크립트로 만들기" 버튼이 대화 입력창에 채울 요청 글. 사람이 검토해 고친 뒤 직접 보낸다(자동으로 보내지 않는다).
 * command·sequence 후보에만 쓴다(big_read는 buildNoteSummaryRequest를 쓴다)
 */
export function buildScriptRequest(candidate: RepeatedActionCandidate): string {
  const name = candidate.suggestion.scriptName ?? 'repeated-action';
  const scriptPath = `scripts/${name}.sh`;
  const original = candidate.examples[0]?.input ?? candidate.title;
  return [
    `로그를 보니 다음이 반복됐어: ${candidate.title}`,
    '',
    `${scriptPath} 스크립트를 아래 초안을 참고해 만들어줘. 서비스 컨테이너 안에서 실행할 스크립트라 알맞은 서비스 폴더 밑에 둬.`,
    '```sh',
    candidate.suggestion.scriptBody ?? '# 초안이 없습니다. 위 반복 내용을 보고 직접 작성하세요.',
    '```',
    '',
    `1) ${scriptPath}로 저장하고 실행 권한을 줘(chmod +x).`,
    `2) 앞으로는 "${original}" 대신 ${scriptPath}를 실행하도록 프로젝트 노트에 한 줄 남겨줘.`,
  ].join('\n');
}

/** "노트에 요약 남기기" 버튼이 채울 요청 글. big_read 후보에만 쓴다 */
export function buildNoteSummaryRequest(candidate: RepeatedActionCandidate): string {
  const path = candidate.examples[0]?.input ?? candidate.title;
  return [
    `"${path}" 파일을 여러 실행에서 크게(총 ${candidate.totalChars.toLocaleString('ko-KR')}자) 반복해서 읽고 있어.`,
    '이 파일의 핵심 내용을 프로젝트 노트에 요약해서 남겨줘. 다음부터는 이 노트를 먼저 보고, 필요할 때만 파일을 다시 읽어줘.',
  ].join('\n');
}
