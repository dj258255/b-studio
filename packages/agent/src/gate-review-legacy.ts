// 차등 시험의 기준: ADR-191 3단계 3e에서 Rust로 옮기기 전의 TS 구현을 그대로 복사한 것이다(declared-checks.ts, check-evidence.ts, load-check.ts, contract-diff.ts).
// 고치지 않는다. 시험(gate-review-differential.test.ts)만 불러 쓰고 제품 코드는 불러 쓰지 않는다.
import type { LoadRequest, LoadResult } from '@b-studio/sandbox';
import type { LoadExpect, WorkflowLoadCheck, WorkflowPageCheck, WorkflowSpec } from '@b-studio/spec';
import type { BrowserPageResult } from './browser-check';

// ════ declared-checks.ts ════

/** 게이트의 리뷰 단계에 남기는 "확인 선언이 바뀌었다" 기록의 이름 */
export const DECLARED_CHECKS_CHECK = 'declared-checks';

/**
 * 게이트가 무엇을 확인할지 정하는 선언. 사용자가 그 요청에서 허용했을 때만 실행 중에 바뀐 값을 받아들인다(ADR-164).
 * 허용 도구·금지 명령·보호 경로·승인 대상·배포 조건 같은 실행 정책은 여기에 없다 — 그것들은 언제나 실행을 시작할 때의 값이다
 */
const DECLARED_FIELDS = ['required', 'tests', 'pageChecks', 'concurrencyChecks', 'loadChecks', 'autoPageChecks'] as const;

export interface DeclaredCheckChange {
  added: string[];
  removed: string[];
  changed: string[];
}

/** 선언 하나하나에 사람이 읽는 이름을 붙인다. 같은 화면을 두 번 확인하면 둘째부터 번호를 붙여 구별한다 */
function entries(workflow: WorkflowSpec | undefined): Map<string, string> {
  const found = new Map<string, string>();
  const put = (label: string, value: unknown) => {
    let key = label;
    for (let count = 2; found.has(key); count++) key = `${label} #${count}`;
    found.set(key, JSON.stringify(value));
  };
  for (const test of workflow?.tests ?? []) put(`테스트 ${test.name}`, test);
  for (const page of workflow?.pageChecks ?? []) put(`화면 ${page.service} ${page.path}`, page);
  for (const check of workflow?.concurrencyChecks ?? []) put(`동시 요청 ${check.name}`, check);
  for (const check of workflow?.loadChecks ?? []) put(`부하 ${check.name}`, check);
  // sample 값(sampleParams·sampleIdFrom)은 허용 없이도 실행 중에 받아들이는 값이라(ADR-159) 선언의 변경으로 세지 않는다
  if (workflow?.autoPageChecks) {
    const { sampleParams: _sampleParams, sampleIdFrom: _sampleIdFrom, ...rest } = workflow.autoPageChecks;
    put('바뀐 페이지 자동 확인', rest);
  }
  if (workflow?.required) put('필수 단계', workflow.required);
  return found;
}

/** 실행을 시작할 때의 선언과 지금 파일의 선언을 견준다. 실행 정책의 차이는 보지 않는다 */
export function diffDeclaredChecks(started: WorkflowSpec | undefined, latest: WorkflowSpec | undefined): DeclaredCheckChange {
  const before = entries(started);
  const after = entries(latest);
  return {
    added: [...after.keys()].filter((key) => !before.has(key)),
    removed: [...before.keys()].filter((key) => !after.has(key)),
    changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)),
  };
}

export function hasDeclaredCheckChange(change: DeclaredCheckChange): boolean {
  return change.added.length + change.removed.length + change.changed.length > 0;
}

/** 약해졌는지 보는 실행 정책 목록과 사람이 읽는 이름. 시작할 때 있던 항목이 빠지면 약해진 것이다 */
const POLICY_LISTS: ReadonlyArray<{ field: 'protectedPaths' | 'evaluationAssets' | 'deniedCommands' | 'requireApprovalFor' | 'releaseRequires'; label: string }> = [
  { field: 'protectedPaths', label: '보호 경로' },
  { field: 'evaluationAssets', label: '평가 자산' },
  { field: 'deniedCommands', label: '금지 명령' },
  { field: 'requireApprovalFor', label: '승인 대상 도구' },
  { field: 'releaseRequires', label: '배포 조건 단계' },
];

/**
 * 실행을 시작할 때보다 지금 선언이 약해진 항목을 사람이 읽는 목록으로 돌려준다(#767). 확인 선언은 삭제·변경만 보고,
 * 실행 정책은 시작할 때 있던 값이 빠진 것을 본다. maxTurns는 보호가 아니므로 보지 않는다.
 */
export function weakenedDeclarations(started: WorkflowSpec | undefined, latest: WorkflowSpec | undefined): string[] {
  const weakened: string[] = [];
  const change = diffDeclaredChecks(started, latest);
  for (const name of change.removed) weakened.push(`삭제: ${name}`);
  for (const name of change.changed) weakened.push(`변경: ${name}`);
  for (const { field, label } of POLICY_LISTS) {
    const after: readonly string[] = latest?.[field] ?? [];
    for (const item of started?.[field] ?? []) {
      if (!after.includes(item)) weakened.push(`삭제: ${label} ${item}`);
    }
  }
  // 시작할 때 목록이 없었으면(모든 도구 허용) 지금 목록을 더 봐도 약해진 것이 아니다
  if (started?.allowedTools) {
    if (!latest?.allowedTools) weakened.push('삭제: 허용 도구(모든 도구 허용)');
    else for (const tool of latest.allowedTools) if (!started.allowedTools.includes(tool)) weakened.push(`추가: 허용 도구 ${tool}`);
  }
  if (started?.maxChangedFiles !== undefined) {
    if (latest?.maxChangedFiles === undefined) weakened.push('삭제: 변경 파일 수 상한');
    else if (latest.maxChangedFiles > started.maxChangedFiles) weakened.push(`변경: 변경 파일 수 상한 ${started.maxChangedFiles} → ${latest.maxChangedFiles}`);
  }
  return weakened;
}

/** 예: "추가: 부하 orders-p95 · 삭제: 테스트 unit · 변경: 화면 web /cart" */
export function describeDeclaredCheckChange(change: DeclaredCheckChange): string {
  const part = (label: string, names: readonly string[]) => (names.length > 0 ? [`${label}: ${names.join(', ')}`] : []);
  return [...part('추가', change.added), ...part('삭제', change.removed), ...part('변경', change.changed)].join(' · ');
}

/** 실행 정책은 시작할 때의 것을 그대로 두고, 확인 선언만 지금 파일의 것으로 바꾼 workflow */
export function withDeclaredChecks(started: WorkflowSpec | undefined, latest: WorkflowSpec | undefined): WorkflowSpec | undefined {
  const merged: Record<string, unknown> = { ...started };
  for (const field of DECLARED_FIELDS) {
    if (latest?.[field] === undefined) delete merged[field];
    else merged[field] = latest[field];
  }
  return Object.keys(merged).length > 0 ? (merged as WorkflowSpec) : undefined;
}

// ════ check-evidence.ts ════

/**
 * 통과한 확인이 무엇을 쟀는지 사람이 읽을 줄로 남긴다(ADR-161 덧붙임).
 * 실패는 사유가 자세한데 통과는 이름과 "통과"만 남아, 단언이 실제로 재졌는지 화면으로는 알 수 없었다.
 *
 * 판정을 다시 하지 않는다 — 판정에 쓴 것과 같은 결과에서 **잰 값**만 적는다. 건수는 결과에서 직접 세고,
 * 문구는 실제로 있는 것만 적으며, 보지 않았거나 허용한 것은 그렇다고 적는다. 통과했다는 사실에서 거꾸로 채우지 않는다.
 * 모델에게 가는 피드백(실패한 확인의 detail)에는 섞이지 않는다.
 */

/** 한 확인의 근거 줄 수 상한. 결과가 이벤트 기록과 체크포인트 기록에 실리므로 크기를 묶어 둔다 */
export const MAX_EVIDENCE_LINES = 12;
const MAX_LINE_LENGTH = 240;
const MAX_VALUE_LENGTH = 60;

type Redact = (text: string) => string;

/**
 * 값을 따옴표로 감싸 적는다. **가린 뒤에 자른다** — 먼저 자르면 긴 시크릿 값의 앞부분이 가림 대상과 일치하지 않아 그대로 남는다
 */
const quote = (value: string | number, redact: Redact): string => {
  const text = redact(String(value));
  return `'${text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text}'`;
};
const quoteAll = (values: readonly string[], redact: Redact): string => values.map((value) => quote(value, redact)).join(', ');

/** 줄 수와 길이를 묶고 시크릿 값을 가린다. 화면·api에서 온 값이 섞일 수 있다 */
export function finishEvidence(lines: readonly string[], redact: Redact): string[] {
  const capped = lines.length > MAX_EVIDENCE_LINES ? [...lines.slice(0, MAX_EVIDENCE_LINES - 1), `그 밖에 ${lines.length - (MAX_EVIDENCE_LINES - 1)}가지`] : lines;
  return capped.map((line) => {
    const safe = redact(line);
    return safe.length > MAX_LINE_LENGTH ? `${safe.slice(0, MAX_LINE_LENGTH)}…` : safe;
  });
}

export interface PageEvidenceContext {
  /** autoPageChecks가 스스로 연 화면이면 true. Next.js 오류 화면 표지까지 본다 */
  auto?: boolean;
  /** 추정한 id로 열었으면 그 값. 상태 코드는 404·500만 실패로 본다 */
  probedId?: string;
  /** expectFromApi로 꺼낸 값이 화면에 있었으면 그 값 */
  api?: { service: string; jsonPath: string; value: string | number };
  /** 시크릿 값을 가리는 함수. 화면·api에서 온 값을 적기 전에 거친다 */
  redact?: Redact;
}

function textLines(page: WorkflowPageCheck, text: string, where: string, redact: Redact): string[] {
  const lines: string[] = [];
  if (page.expectText && text.includes(page.expectText)) lines.push(`${quote(page.expectText, redact)} ${where}에 있음`);
  if (page.expectAnyText) {
    const found = page.expectAnyText.filter((candidate) => text.includes(candidate));
    if (found.length > 0) lines.push(`${quoteAll(found, redact)} ${where}에 있음 (적은 ${page.expectAnyText.length}개 중 하나면 통과)`);
  }
  if (page.expectAllText) {
    const found = page.expectAllText.filter((candidate) => text.includes(candidate));
    if (found.length > 0) lines.push(`${quoteAll(found, redact)} ${where}에 ${found.length === page.expectAllText.length ? '모두 ' : ''}있음`);
  }
  return lines;
}

function statusLine(status: number | null, page: WorkflowPageCheck, context: PageEvidenceContext): string {
  const got = `HTTP ${status ?? '응답 없음'}`;
  if (context.probedId !== undefined) return `${got} — 추정한 id(${context.probedId})로 열어 404·500만 실패로 봤습니다`;
  return `${got} (기대 ${page.expectStatus})`;
}

/** browser 모드 화면 확인이 통과했을 때의 근거. 판정에 쓴 result 그대로에서 만든다 */
export function browserPageEvidence(page: WorkflowPageCheck, result: BrowserPageResult, context: PageEvidenceContext = {}): string[] {
  const redact = context.redact ?? ((text: string) => text);
  const lines: string[] = [statusLine(result.status, page, context)];
  lines.push(...textLines(page, result.text, '화면', redact));
  const viewport = result.viewportTexts;
  if (page.expectInViewport && viewport) {
    const visible = viewport.findings.filter((finding) => finding.visible && page.expectInViewport!.includes(finding.text)).map((finding) => finding.text);
    if (visible.length > 0) lines.push(`첫 화면에 온전히 보임 (창 ${viewport.width}x${viewport.height}): ${quoteAll(visible, redact)}`);
  }
  if (context.api) lines.push(`${context.api.service}의 ${context.api.jsonPath} 값 ${quote(context.api.value, redact)} 화면에 있음`);
  const tolerated = `console.error ${result.consoleErrors.length}건 · 실패한 요청 ${result.failedRequests.length}건 · 미디어 오류 ${result.mediaErrors.length}건`;
  lines.push(page.allowConsoleErrors ? `스크립트 예외 ${result.pageErrors.length}건 — ${tolerated}은 실패로 보지 않았습니다(allowConsoleErrors)` : `스크립트 예외 ${result.pageErrors.length}건 · ${tolerated}`);
  if (page.allowLoadingPlaceholder) lines.push('로딩 문구에서 멈췄는지는 보지 않았습니다(allowLoadingPlaceholder)');
  if (page.noHorizontalScroll) lines.push(`가로 넘침 ${result.horizontalOverflowPx}px`);
  if (result.loadMs !== undefined) {
    lines.push(`로드 ${result.loadMs.toLocaleString('ko-KR')}ms${page.maxLoadMs !== undefined ? ` (예산 ${page.maxLoadMs.toLocaleString('ko-KR')}ms)` : ''}`);
  }
  // 첫 항목은 페이지를 연 것(open <경로>)이라 선언한 단계 수와 맞춘다
  const ran = page.steps?.length ? result.steps.slice(1) : [];
  if (ran.length > 0) lines.push(`단계 ${ran.filter((step) => step.ok).length}/${ran.length}개 실행: ${ran.map((step) => step.label).join(' → ')}`);
  if (context.auto) lines.push('Next.js 오류 화면 표지 없음');
  return lines;
}

/** http 모드 화면 확인이 통과했을 때의 근거. 자바스크립트를 실행하지 않았다는 사실을 함께 적는다 */
export function httpPageEvidence(page: WorkflowPageCheck, response: { status: number; text: string }, context: PageEvidenceContext = {}): string[] {
  const redact = context.redact ?? ((text: string) => text);
  const lines: string[] = [statusLine(response.status, page, context)];
  lines.push(...textLines(page, response.text, '응답 본문', redact));
  if (context.api) lines.push(`${context.api.service}의 ${context.api.jsonPath} 값 ${quote(context.api.value, redact)} 응답 본문에 있음`);
  if (context.auto) lines.push('Next.js 오류 화면 표지 없음');
  lines.push('HTTP 확인이라 자바스크립트를 실행하지 않았습니다 — 화면에 그려졌는지, 콘솔 오류·실패한 요청은 보지 않았습니다');
  return lines;
}

/** 테스트 명령이 통과했을 때의 근거. 무엇을 어디서 돌렸고 얼마나 걸렸는지 — 아무것도 돌지 않고 끝난 명령이 시간으로 드러난다 */
export function testEvidence(service: string, command: readonly string[], elapsedMs: number): string[] {
  const seconds = elapsedMs / 1000;
  return [`${service}에서 \`${command.join(' ')}\` 종료 코드 0`, `걸린 시간 ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toLocaleString('ko-KR')}초`];
}

// ════ load-check.ts ════

/** 부하 확인 한 번의 판정. note는 통과·실패와 상관없이 남기는 요약, problems가 비어야 통과다 */
export interface LoadJudgement {
  note: string;
  problems: string[];
  /** 통과했을 때 사람에게 보여 줄 근거. 판정에 쓴 값만 적는다 */
  evidence: string[];
}

const LATENCY_KEYS = [
  ['p50Ms', 'p50'],
  ['p95Ms', 'p95'],
  ['p99Ms', 'p99'],
  ['maxMs', 'max'],
] as const;

/** studio.yaml의 선언을 러너에 넘길 요청으로 바꾼다. requests를 생략하면 연결마다 한 건이다 */
export function loadRequestFor(check: WorkflowLoadCheck): LoadRequest {
  return {
    service: check.service,
    method: check.method,
    path: check.path,
    ...(check.headers ? { headers: check.headers } : {}),
    ...(check.body !== undefined ? { body: check.body } : {}),
    concurrent: check.concurrent,
    requests: check.requests ?? check.concurrent,
    warmup: check.warmup,
    ...(check.expect.latencyOf ? { latencyOf: check.expect.latencyOf } : {}),
  };
}

const ms = (value: number): string => `${value}ms`;
const tally = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, amount]) => `${key}:${amount}`)
    .join(', ');
const total = (counts: Record<string, number>): number => Object.values(counts).reduce((sum, amount) => sum + amount, 0);

/** 응답 시간 기준을 사람이 읽는 한 줄로. 예: "p95 200ms 이하, 409 응답만" */
export function describeLoadExpect(expect: LoadExpect): string {
  const limits = LATENCY_KEYS.flatMap(([key, label]) => (expect[key] !== undefined ? [`${label} ${ms(expect[key])} 이하`] : []));
  return [...limits, ...(expect.latencyOf ? [`${expect.latencyOf.join('·')} 응답만`] : [])].join(', ');
}

/**
 * 러너가 잰 값으로 통과 여부를 정한다. 원인을 추정하지 않고 숫자만 남긴다.
 * 응답을 받지 못한 요청이 하나라도 있으면 실패다 — 느리거나 끊긴 요청이 표본에서 빠진 채 응답 시간만 보고 통과하지 않게 한다.
 * 응답 시간을 잴 응답이 없어도 실패다(기준을 확인하지 못한 것을 통과로 세지 않는다).
 * 서버 오류(5xx)도 allStatusIn에 적지 않았으면 실패다
 */
export function judgeLoad(check: WorkflowLoadCheck, result: LoadResult): LoadJudgement {
  const { expect } = check;
  const { latency } = result;
  const scope = expect.latencyOf ? `${expect.latencyOf.join('·')} 응답 ` : '';
  const sample = expect.latencyOf ? `${expect.latencyOf.join('·')} 응답` : '응답';
  const failed = total(result.errors);
  const statusDetail = tally(result.statuses) || '없음';
  const seconds = result.elapsedMs / 1000;
  const rate = seconds > 0 ? Math.round(result.completed / seconds) : 0;
  // 1초가 안 되는 측정을 "0.0초"로 적지 않는다
  const took = seconds >= 1 ? `${seconds.toFixed(1)}초` : `${Math.round(result.elapsedMs)}ms`;

  const latencyLine =
    latency.count > 0
      ? `응답 시간(${scope}${latency.count}건) p50 ${ms(latency.p50!)} · p95 ${ms(latency.p95!)} · p99 ${ms(latency.p99!)} · 최대 ${ms(latency.max!)}`
      : `응답 시간을 잴 ${sample} 없음`;
  const parts = [
    `동시 ${result.concurrent} · ${result.requests}건 중 응답 ${result.completed}건 (${took}, 초당 ${rate}건)`,
    `상태 ${statusDetail}`,
    latencyLine,
    `연결 p95 ${result.connect.p95 !== undefined ? ms(result.connect.p95) : '-'} · 러너 밀림 p99 ${ms(result.loopDelay.p99)}`,
  ];
  if (result.warmup.requests > 0) parts.push(`준비 요청 ${result.warmup.requests}건${result.warmup.errors > 0 ? ` (실패 ${result.warmup.errors}건)` : ''}`);

  const problems: string[] = [];
  if (failed > 0) problems.push(`응답을 받지 못한 요청 ${failed}건 (${tally(result.errors)})`);

  const successCount = Object.entries(result.statuses).reduce((sum, [status, amount]) => (status.startsWith('2') ? sum + amount : sum), 0);
  if (expect.successCount?.exactly !== undefined && successCount !== expect.successCount.exactly) {
    problems.push(`성공 ${successCount}/${result.requests} (기대: 정확히 ${expect.successCount.exactly})`);
  }
  if (expect.successCount?.atMost !== undefined && successCount > expect.successCount.atMost) {
    problems.push(`성공 ${successCount}/${result.requests} (기대: 최대 ${expect.successCount.atMost})`);
  }
  if (expect.allStatusIn) {
    const allowed = new Set(expect.allStatusIn.map(String));
    const outside = Object.keys(result.statuses).filter((status) => !allowed.has(status));
    if (outside.length > 0) problems.push(`기대 밖 상태 코드: ${outside.sort().join(', ')} (기대: ${expect.allStatusIn.join(', ')})`);
  } else {
    // 상태 코드 기대를 적지 않았어도 서버 오류는 통과로 세지 않는다. 빨리 실패하는 서비스가 응답 시간 기준을 통과하는 일을 막는다
    const serverErrors = Object.fromEntries(Object.entries(result.statuses).filter(([status]) => status.startsWith('5')));
    if (total(serverErrors) > 0) problems.push(`서버 오류 응답 ${total(serverErrors)}건 (${tally(serverErrors)}). 의도한 응답이면 expect.allStatusIn에 적으세요`);
  }

  const exceeded: number[] = [];
  if (latency.count === 0) {
    problems.push(`응답 시간을 잴 ${sample}이 없습니다 (기준: ${describeLoadExpect(expect)})`);
  } else {
    for (const [key, label] of LATENCY_KEYS) {
      const limit = expect[key];
      const actual = latency[label];
      if (limit === undefined || actual === undefined) continue;
      if (actual > limit) {
        problems.push(`${scope}${label} ${ms(actual)} (기준: ${ms(limit)} 이하)`);
        exceeded.push(limit);
      }
    }
  }
  // 러너는 응답을 늦게 받아 적을 수는 있어도 일찍 적지는 못한다. 그래서 통과에는 영향이 없고, 기준을 넘겼을 때만 러너의 밀림이 섞였을 수 있다고 알린다
  if (exceeded.length > 0 && result.loopDelay.p99 >= Math.max(5, Math.min(...exceeded) * 0.1)) {
    problems.push(`러너 자신이 p99 ${ms(result.loopDelay.p99)} 밀렸습니다. 이 값이 응답 시간에 섞였을 수 있습니다 — concurrent나 requests를 줄여 다시 재 보세요`);
  }

  const limits = LATENCY_KEYS.flatMap(([key, label]) =>
    expect[key] !== undefined && latency[label] !== undefined ? [`${scope}${label} ${ms(latency[label])} (기준 ${ms(expect[key])} 이하, ${latency.count}건)`] : [],
  );
  const evidence = [
    `샌드박스 네트워크 안에서 ${check.method} ${check.path} · 동시 ${result.concurrent} · ${result.requests}건 (${took})`,
    ...limits,
    `상태 ${statusDetail} · 응답을 받지 못한 요청 0건`,
    `러너 밀림 p99 ${ms(result.loopDelay.p99)} · 연결 p95 ${result.connect.p95 !== undefined ? ms(result.connect.p95) : '-'}`,
  ];
  return { note: parts.join(' · '), problems, evidence };
}

// ════ contract-diff.ts ════
/** 비교에 필요한 만큼만 정의한 OpenAPI 문서 형태 */
export interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, SchemaObject> };
}

interface SchemaObject {
  type?: string | string[];
  $ref?: string;
  format?: string;
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
}

export type ContractChangeKind =
  | 'operation-added'
  | 'operation-removed'
  | 'schema-added'
  | 'schema-removed'
  | 'property-added'
  | 'property-removed'
  | 'property-type-changed'
  | 'property-became-required';

export interface ContractChange {
  kind: ContractChangeKind;
  /** `GET /api/orders` 또는 `Order.memo` */
  target: string;
  /** 기존 클라이언트를 깨뜨릴 수 있는 변경인지 */
  breaking: boolean;
  detail?: string;
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * 실행 중인 서버에서 추출한 두 OpenAPI 문서를 비교한다.
 * 에이전트가 "필드 추가"를 요청받고 필드를 지우거나 타입을 바꾸면 검증 단계에서 드러나게 하는 것이 목적이다.
 */
export function diffContracts(before: OpenApiDocument | undefined, after: OpenApiDocument): ContractChange[] {
  const changes: ContractChange[] = [];

  const beforeOps = operations(before);
  const afterOps = operations(after);
  for (const op of afterOps) if (!beforeOps.has(op)) changes.push({ kind: 'operation-added', target: op, breaking: false });
  for (const op of beforeOps) if (!afterOps.has(op)) changes.push({ kind: 'operation-removed', target: op, breaking: true });

  const beforeSchemas = before?.components?.schemas ?? {};
  const afterSchemas = after.components?.schemas ?? {};

  for (const name of Object.keys(afterSchemas)) {
    if (!(name in beforeSchemas)) changes.push({ kind: 'schema-added', target: name, breaking: false });
  }
  for (const [name, previous] of Object.entries(beforeSchemas)) {
    const next = afterSchemas[name];
    if (!next) {
      changes.push({ kind: 'schema-removed', target: name, breaking: true });
      continue;
    }
    changes.push(...diffProperties(name, previous, next));
  }

  // 로케일에 따라 순서가 바뀌지 않도록 코드포인트 순으로 정렬한다
  return changes.sort((a, b) => Number(b.breaking) - Number(a.breaking) || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

function diffProperties(schema: string, previous: SchemaObject, next: SchemaObject): ContractChange[] {
  const changes: ContractChange[] = [];
  const beforeProps = previous.properties ?? {};
  const afterProps = next.properties ?? {};
  const beforeRequired = new Set(previous.required ?? []);
  const afterRequired = new Set(next.required ?? []);

  for (const [prop, definition] of Object.entries(afterProps)) {
    const target = `${schema}.${prop}`;
    const old = beforeProps[prop];
    if (!old) {
      // 새 필드가 처음부터 필수면 기존 요청 본문이 거부될 수 있다
      const required = afterRequired.has(prop);
      changes.push({ kind: 'property-added', target, breaking: required, detail: describeType(definition) + (required ? ', required' : '') });
      continue;
    }
    const oldType = describeType(old);
    const newType = describeType(definition);
    if (oldType !== newType) {
      changes.push({ kind: 'property-type-changed', target, breaking: true, detail: `${oldType} → ${newType}` });
    }
    if (!beforeRequired.has(prop) && afterRequired.has(prop)) {
      changes.push({ kind: 'property-became-required', target, breaking: true });
    }
  }
  for (const prop of Object.keys(beforeProps)) {
    if (!(prop in afterProps)) changes.push({ kind: 'property-removed', target: `${schema}.${prop}`, breaking: true });
  }
  return changes;
}

function operations(document: OpenApiDocument | undefined): Set<string> {
  const result = new Set<string>();
  for (const [route, item] of Object.entries(document?.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toLowerCase())) result.add(`${method.toUpperCase()} ${route}`);
    }
  }
  return result;
}

function describeType(schema: SchemaObject): string {
  if (schema.$ref) return schema.$ref.split('/').at(-1) ?? schema.$ref;
  const type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== 'null').join('|') : (schema.type ?? 'any');
  if (type === 'array' && schema.items) return `${describeType(schema.items)}[]`;
  return schema.format ? `${type}(${schema.format})` : type;
}

/** 에이전트에게 보여줄 계약 요약. 원본 JSON보다 훨씬 짧다 */
export function summarizeContract(document: OpenApiDocument): string {
  const ops = [...operations(document)].sort();
  const schemas = Object.entries(document.components?.schemas ?? {}).map(([name, schema]) => {
    const required = new Set(schema.required ?? []);
    const props = Object.entries(schema.properties ?? {})
      .map(([prop, definition]) => `${prop}${required.has(prop) ? '' : '?'}: ${describeType(definition)}`)
      .join(', ');
    return `${name} { ${props} }`;
  });
  return ['operations:', ...ops.map((op) => `  ${op}`), 'schemas:', ...schemas.map((line) => `  ${line}`)].join('\n');
}

export function formatContractChanges(changes: readonly ContractChange[]): string {
  if (changes.length === 0) return '계약 변경 없음';
  return changes
    .map((change) => `${change.breaking ? '⚠️ 호환 깨짐' : '＋'} ${change.kind} ${change.target}${change.detail ? ` (${change.detail})` : ''}`)
    .join('\n');
}
