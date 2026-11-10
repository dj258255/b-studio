import { appendFileSync } from 'node:fs';
import { native } from '@b-studio/sandbox';
import type { WorkflowPageStep } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, type Outcome } from './differential-kit';
import {
  buildQaSystemPrompt,
  buildQaUserPrompt,
  buildWrapUpPrompt,
  describeScrollPosition,
  diagnosticsCount,
  formatElement,
  formatSnapshot,
  isInspectionGoal,
  judge,
  matchScore,
  normalizeRef,
  toPageCheckSteps,
  type ConvertedSteps,
  type ExploreQaGoal,
  type ExploreQaStatus,
  type ExploreQaStopReason,
  type QaActionRecord,
  type QaDiagnostics,
  type QaElement,
  type RawElement,
  type QaFinding,
  type QaReview,
  type QaScrollPosition,
} from './explore-qa';

/**
 * 탐색 QA의 순수 함수를 Rust로 옮기면서(ADR-191 3p) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을 옛 구현과 새 껍데기에 넣어
 * 결과를 JSON 글자로 견준다. `legacy`는 옮기기 전 `explore-qa.ts`의 해당 함수 본문이다(`export`만 뗐다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 크기는 환경 변수로 바꾼다: EXPLORE_QA_DIFF_SEEDS(쉼표 목록), EXPLORE_QA_DIFF_ITERATIONS, EXPLORE_QA_DIFF_REPORT=<파일 경로>(분포를 그 파일에 덧붙인다)
 */

const legacy = (() => {
  const MAX_SNAPSHOT_ELEMENTS = 40;
  interface RawElement {
    role: string;
    name: string;
    tag: string;
    text: string;
    testId?: string;
  }
  /** 진단 신호 개수의 합(판정에 쓴다). 가로 넘침은 1px이라도 있으면 1건으로 센다 */
  function diagnosticsCount(diagnostics: QaDiagnostics): number {
    return (
      diagnostics.consoleErrors.length +
      diagnostics.pageErrors.length +
      diagnostics.failedRequests.length +
      diagnostics.accessibilityViolations.length +
      (diagnostics.horizontalOverflowPx > 1 ? 1 : 0)
    );
  }


  function matchScore(entry: RawElement, needle: string): number {
    if (!needle) return 0;
    const name = entry.name.toLowerCase();
    const text = entry.text.toLowerCase();
    const role = entry.role.toLowerCase();
    const testId = (entry.testId ?? '').toLowerCase();
    if (name === needle || text === needle || testId === needle) return 100;
    if (name.startsWith(needle) || text.startsWith(needle)) return 80;
    if (name.includes(needle) || text.includes(needle) || testId.includes(needle)) return 60;
    if (role.includes(needle) || entry.tag.toLowerCase() === needle) return 20;
    return 0;
  }


  function describeScrollPosition(position: QaScrollPosition): string {
    if (position.max <= 0) return '문서 자체는 스크롤되지 않습니다(화면 안쪽의 스크롤 영역이 따로 있을 수 있습니다).';
    const where = `현재 y=${position.y} / 최대 ${position.max}`;
    if (position.atBottom) return `${where}, 맨 아래에 닿았습니다.`;
    return `${where}, 맨 아래가 아닙니다${position.atTop ? '(맨 위)' : ''}.`;
  }

  function formatElement(element: QaElement): string {
    const parts = [element.ref, element.role, element.name || '(이름 없음)'];
    if (element.testId) parts.push(`testid=${element.testId}`);
    return parts.join('\t');
  }

  function formatSnapshot(result: { url: string; title: string; elements: QaElement[]; truncated: boolean }): string {
    const header = `${result.url} — ${result.title}`;
    const body = result.elements.length > 0 ? result.elements.map(formatElement).join('\n') : '(인터랙티브 요소가 없습니다)';
    const footer = result.truncated ? `\n(요소가 많아 처음 ${MAX_SNAPSHOT_ELEMENTS}개만 보여줍니다. qa_find로 특정 요소를 찾으세요)` : '';
    return `${header}\n${body}${footer}`;
  }


  function normalizeRef(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const ref = value.replace(/^[\s"'`]+|[\s"'`]+$/g, '');
    return ref === '' ? undefined : ref;
  }


  function isInspectionGoal(goalText: string): boolean {
    return /점검|검사|살펴|찾아|문제|잘리|잘려|겹치|겹쳐|넘치|어색|읽기 어려|깨지|이상한|리뷰|검토|inspect|review|audit|layout/i.test(goalText);
  }

  function buildQaSystemPrompt(goal?: Pick<ExploreQaGoal, 'goal'>): string {
    const lines = [
      '당신은 웹 애플리케이션의 UI/UX를 사람처럼 눈으로 보고 손으로 조작하며 시험하는 QA 에이전트입니다.',
      '주어진 목표를 화면에서 직접 수행하세요. qa_snapshot으로 화면의 인터랙티브 요소를 관찰하고, 필요한 ref를 골라 행동하세요.',
      '화면이 어떻게 보이는지는 접근성 트리로 알 수 없습니다. 잘림·겹침·넘침·대비·여백·정렬처럼 눈으로 봐야 하는 것은 qa_screenshot으로 직접 확인하세요(이미지가 돌아옵니다).',
      '페이지를 내릴 때는 qa_scroll에 ref를 넣지 말고 direction만 주세요. 결과에 맨 아래에 닿았는지가 나옵니다.',
      '화면에서 문제를 보면 그 자리에서 qa_report_issue로 보고하세요. 본 것만 적고(추측 금지), 어느 요소가 어떻게 잘못됐는지 구체적으로 쓰세요. 문제를 찾았어도 점검을 계속할 수 있습니다.',
      '목표를 끝까지 수행했거나 더 진행할 수 없으면 qa_finish를 부르세요. 성공을 선언해도 플랫폼이 진단 신호·확인 문구·보고된 문제를 따로 확인하니 솔직하게 판단하세요. 문제가 없으면 없다고 적으면 됩니다.',
      '일부러 거절될 조작(로그인 없이 주문, 빈 값 제출 등)을 하기 전에는 누를 요소를 먼저 찾아 둔 뒤 조작 바로 앞에서 qa_expect_rejection으로 알리세요(선언과 조작 사이에 다른 도구를 부르면 선언이 사라집니다). 알리지 않은 조작에서 서버가 거절하면 실패한 요청으로 세어 문제로 판정합니다. 화면이 데이터를 읽다 받은 오류와 서버 오류(5xx)는 선언해도 실패입니다.',
      '화면을 바꾸지 않는 관찰은 필요한 만큼 해도 되지만, 같은 화면에서 같은 조작을 되풀이하지 말고 막히면 다른 요소를 시도하거나 qa_finish(success: false)로 알리세요.',
    ];
    if (goal && isInspectionGoal(goal.goal)) {
      lines.push(
        '이 목표는 화면을 점검하는 일입니다. 다음 순서로 하세요.',
        '1) 시작 화면을 qa_screenshot으로 봅니다. 2) qa_scroll로 한 화면씩 내려가며 위치마다 qa_screenshot을 찍어 맨 아래에 닿을 때까지 확인합니다(한 화면만 보고 끝내지 마세요). 3) 각 화면에서 잘리거나 겹치거나 화면 밖으로 나간 요소, 읽기 어려운 글자(크기·대비), 정렬이 어긋나거나 한쪽으로 쏠린 배치, 큰 빈 여백을 찾습니다. 4) 눌러 볼 만한 요소(탭·열기 버튼)가 있으면 눌러 숨은 화면도 봅니다. 5) 본 문제는 모두 qa_report_issue로 보고하고 qa_finish로 마칩니다.',
      );
    }
    return lines.join('\n');
  }

  function buildQaUserPrompt(goal: ExploreQaGoal): string {
    const lines = [`목표: ${goal.goal}`, `시작 화면: ${goal.startPath}`];
    if (goal.confirmText) lines.push(`끝났을 때 화면에 '${goal.confirmText}' 문구가 있어야 합니다.`);
    return lines.join('\n');
  }

  const STOP_REASON_TEXT: Record<ExploreQaStopReason, string> = {
    finish: 'qa_finish로 마침',
    max_actions: '행동 횟수 한도에 도달함',
    max_time: '시간 한도에 도달함',
    repeated_screen: '같은 화면에서 같은 조작이 되풀이됨',
    no_tool_call: '도구를 부르지 않고 글만 냄',
  };

  /** 한도·반복·도구 없음으로 끝날 때 모델에게 마지막 보고를 요청하는 문장. 두 백엔드가 같이 쓴다 */
  function buildWrapUpPrompt(reason: ExploreQaStopReason): string {
    return [
      `점검이 곧 끝납니다(${STOP_REASON_TEXT[reason]}). 더 이상 화면을 조작할 수 없습니다.`,
      '지금까지 본 것으로 마지막 보고를 하세요. 아직 보고하지 않은 문제가 있으면 qa_report_issue로 하나씩 보고하고(이미 보고한 것은 다시 하지 마세요), 마지막으로 qa_finish를 부르세요.',
      '문제를 보지 못했다면 qa_finish의 summary에 문제를 보지 못했다고 적으세요. 목표나 점검을 끝까지 하지 못했다면 success: false로 알리세요.',
    ].join('\n');
  }


  function judge(
    goal: Pick<ExploreQaGoal, 'confirmText'>,
    diagnostics: QaDiagnostics,
    pageText: string,
    review?: QaReview,
  ): { status: ExploreQaStatus; reason: string } {
    const problems: string[] = [];
    if (diagnostics.consoleErrors.length > 0) problems.push(`console.error ${diagnostics.consoleErrors.length}건`);
    if (diagnostics.pageErrors.length > 0) problems.push(`스크립트 예외 ${diagnostics.pageErrors.length}건`);
    if (diagnostics.failedRequests.length > 0) problems.push(`실패한 요청 ${diagnostics.failedRequests.length}건`);
    if (diagnostics.accessibilityViolations.length > 0) problems.push(`접근성 위반 ${diagnostics.accessibilityViolations.length}건`);
    if (diagnostics.horizontalOverflowPx > 1) problems.push(`가로로 ${diagnostics.horizontalOverflowPx}px 넘칩니다`);
    const confirmMissing = Boolean(goal.confirmText) && !pageText.includes(goal.confirmText as string);
    if (confirmMissing) problems.push(`확인 문구 '${goal.confirmText}'를 화면에서 찾지 못했습니다`);

    let minorCount = 0;
    if (review) {
      const serious = review.findings.filter((finding) => finding.severity !== 'minor');
      minorCount = review.findings.length - serious.length;
      if (serious.length > 0) {
        const blockers = serious.filter((finding) => finding.severity === 'blocker').length;
        const counts = [blockers > 0 ? `blocker ${blockers}건` : '', serious.length - blockers > 0 ? `major ${serious.length - blockers}건` : ''].filter(Boolean).join('·');
        const shown = serious.slice(0, 3).map((finding) => `[${finding.severity}] ${finding.summary}`);
        const more = serious.length > shown.length ? ` 외 ${serious.length - shown.length}건` : '';
        problems.push(`모델이 화면에서 본 문제 ${counts} — ${shown.join(' / ')}${more}`);
      }
      if (review.declared && !review.declared.success) {
        problems.push(`모델이 목표를 끝내지 못했다고 보고했습니다${review.declared.summary ? `: ${review.declared.summary}` : ''}`);
      }
    }
    const rejectionNotes = [
      review?.expectedRejections ? `예상된 거절 ${review.expectedRejections}건은 목록 참고` : '',
      review?.unmetRejections ? `거절될 것으로 선언했지만 거절 응답이 없던 조작 ${review.unmetRejections}건은 목록 참고` : '',
    ].filter(Boolean);
    if (problems.length > 0) return { status: 'fail', reason: `${problems.join(' / ')}${rejectionNotes.length > 0 ? ` (${rejectionNotes.join(', ')})` : ''}` };

    if (review && !review.declared) {
      const confirmed = Boolean(goal.confirmText) && !confirmMissing;
      if (!confirmed) {
        const minor = minorCount > 0 ? ` 보고된 minor ${minorCount}건은 목록에 있습니다.` : '';
        const rejections = rejectionNotes.length > 0 ? ` (${rejectionNotes.join(', ')})` : '';
        return { status: 'inconclusive', reason: `점검을 마치지 못했습니다 — ${STOP_REASON_TEXT[review.stoppedBy]}, 모델의 마지막 보고(qa_finish)도 받지 못했습니다.${minor}${rejections}` };
      }
    }
    const notes = [minorCount > 0 ? `minor ${minorCount}건은 목록 참고` : '', ...rejectionNotes].filter(Boolean);
    return { status: 'pass', reason: `진단 신호가 없고 확인 조건을 만족합니다${notes.length > 0 ? `(${notes.join(', ')})` : ''}` };
  }


  function toPageCheckSteps(actions: readonly QaActionRecord[]): ConvertedSteps {
    const steps: WorkflowPageStep[] = [];
    const skipped: ConvertedSteps['skipped'] = [];
    for (const action of actions) {
      if (!action.ok) {
        skipped.push({ index: action.index, tool: action.tool, reason: '실패한 행동이라 저장하지 않습니다' });
        continue;
      }
      switch (action.tool) {
        case 'qa_click':
          if (action.stableSelector) steps.push({ click: action.stableSelector });
          else skipped.push({ index: action.index, tool: action.tool, reason: '안정적인 선택자(role+name·data-testid·고유 텍스트)가 없어 저장하지 않습니다' });
          break;
        case 'qa_fill':
        case 'qa_type':
          if (action.stableSelector) steps.push({ fill: { selector: action.stableSelector, text: String(action.input.text ?? '') } });
          else skipped.push({ index: action.index, tool: action.tool, reason: '안정적인 선택자(role+name·data-testid·고유 텍스트)가 없어 저장하지 않습니다' });
          break;
        case 'qa_press':
          steps.push({ press: String(action.input.key ?? '') });
          break;
        case 'qa_wait': {
          const forText = typeof action.input.forText === 'string' ? action.input.forText : undefined;
          if (forText) steps.push({ waitFor: `text=${forText}` });
          else skipped.push({ index: action.index, tool: action.tool, reason: '시간만 기다린 행동은 저장하지 않습니다(화면 신호가 아니라서 재현성이 없습니다)' });
          break;
        }
        default:
          skipped.push({ index: action.index, tool: action.tool, reason: '이 행동은 click/fill/press/waitFor로 표현할 수 없어 저장하지 않습니다' });
      }
    }
    return { steps, skipped };
  }

  return { diagnosticsCount, matchScore, describeScrollPosition, formatElement, formatSnapshot, normalizeRef, isInspectionGoal, buildQaSystemPrompt, buildQaUserPrompt, buildWrapUpPrompt, judge, toPageCheckSteps };
})();

const SEEDS = readEnvList('EXPLORE_QA_DIFF_SEEDS', [1, 7, 42, 2026]);
const ITERATIONS = readEnvNumber('EXPLORE_QA_DIFF_ITERATIONS', 1500);
const REPORT = process.env.EXPLORE_QA_DIFF_REPORT;

interface Tally {
  compared: number;
  different: number;
  distribution: Map<string, number>;
  examples: string[];
}
const tallies = new Map<string, Tally>();
function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) tallies.set(name, (t = { compared: 0, different: 0, distribution: new Map(), examples: [] }));
  return t;
}

function compare(name: string, input: unknown, old: () => unknown, next: () => unknown, bucket: (o: Outcome) => string): void {
  const a = outcome(old);
  const b = outcome(next);
  const t = tally(name);
  t.compared += 1;
  const key = bucket(a);
  t.distribution.set(key, (t.distribution.get(key) ?? 0) + 1);
  if (!sameOutcome(a, b)) {
    t.different += 1;
    if (t.examples.length < 3) t.examples.push(`입력 ${safeJson(input)}\n옛 ${safeJson(a)}\n새 ${safeJson(b)}`);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
  } catch {
    return String(value);
  }
}

const rank: Record<ExploreQaStatus, number> = { fail: 0, inconclusive: 1, pass: 2 };
/** 판정이 열린 쪽(통과에 가까운 쪽)으로 뒤집힌 수를 가른다 */
const flips = { failToPass: 0, failToInconclusive: 0, inconclusiveToPass: 0, closed: 0, judged: 0 };
function countFlip(input: unknown, old: Outcome, next: Outcome): void {
  if (old.threw || next.threw) return;
  const a = (old.value as { status: ExploreQaStatus }).status;
  const b = (next.value as { status: ExploreQaStatus }).status;
  flips.judged += 1;
  if (a === b) return;
  if (a === 'fail' && b === 'pass') flips.failToPass += 1;
  else if (a === 'fail' && b === 'inconclusive') flips.failToInconclusive += 1;
  else if (a === 'inconclusive' && b === 'pass') flips.inconclusiveToPass += 1;
  else flips.closed += 1;
  void input;
  void rank;
}

/** 짝 없는 서로게이트·예약 글자(U+E000..U+E01F)가 든 확인 문구·화면 글자의 judge. 이유 글자는 경계에서 U+FFFD가 되어 달라지므로(의도한 차이) 상태만 견준다 */
const SURROGATE_ALPHABET = ['\ud800', '\udbff', '\udc00', '\udfff', '😀', '\ud83d', '\ude00', '\ue000', '\ue01f', '\ue010', '\ue011', '\ufffd', 'd', '8', '0', 'a'];
const surrogateFlips = { judged: 0, open: 0, closed: 0 };
function surrogateJudge(g: Gen): void {
  const page = g.text(SURROGATE_ALPHABET, g.int(7));
  const from = g.int(page.length + 1);
  const confirm = g.chance(0.6) && page.length > 0 ? page.slice(from, from + 1 + g.int(3)) || 'a' : g.text(SURROGATE_ALPHABET, 1 + g.int(3));
  const diagnostics = diagnosticsOf(g);
  const review = reviewOf(g);
  const a = legacy.judge({ confirmText: confirm }, diagnostics, page, review).status;
  const b = judge({ confirmText: confirm }, diagnostics, page, review).status;
  surrogateFlips.judged += 1;
  if (a === b) return;
  if (rank[b] > rank[a]) surrogateFlips.open += 1;
  else surrogateFlips.closed += 1;
}

const WORDS = ['버튼', '목록', 'x', 'Submit', '완료', '완료되었습니다', 'Σ', 'ΑΣ', 'İ', 'ı', 'ß', 'ſ', 'K', 'ǅ', 'Ａ', '😀', 'é', 'é', '', ' '];
const KEYWORDS = ['점검', '검사', '살펴', '찾아', '문제', '잘리', '잘려', '겹치', '겹쳐', '넘치', '어색', '읽기 어려', '깨지', '이상한', '리뷰', '검토', 'inspect', 'review', 'audit', 'layout'];
const WS = ['', '', ' ', '\n', '\t', '\u00a0', '\ufeff', '\u0085', '\u2028', '\u3000', '\u180e', '\u200b'];
const STOPS: ExploreQaStopReason[] = ['finish', 'max_actions', 'max_time', 'repeated_screen', 'no_tool_call'];

function diagnosticsOf(g: Gen): QaDiagnostics {
  const list = (): string[] => g.list(0, g.chance(0.6) ? 0 : 3, () => g.pick(['err', '요청 실패', '']));
  const overflow = g.pick([0, 0, 0, 1, 1.0001, 0.9999, 2, 1.5, NaN, -1, -0, 100, 1e21, Infinity, -Infinity, 12.5, 1e-7]);
  return { consoleErrors: list(), pageErrors: list(), failedRequests: list(), blockedRequests: list(), horizontalOverflowPx: overflow, accessibilityViolations: list() };
}

function textOf(g: Gen): string {
  const words = g.list(0, 4, () => g.pick(WORDS));
  return g.pick(WS) + words.join(g.pick(['', ' ', '\n'])) + g.pick(WS);
}

function findingOf(g: Gen): QaFinding {
  return {
    severity: g.pick(['blocker', 'major', 'minor', 'minor', 'Minor', 'minor ', 'MINOR', 'Blocker', 'blocker ', '', 'critical']) as QaFinding['severity'],
    summary: g.pick(['버튼이 잘림', '', 'a / b', '겹침 [major]', '긴 요약 '.repeat(3), 'x']),
  } as QaFinding;
}

function reviewOf(g: Gen): QaReview | undefined {
  if (g.chance(0.2)) return undefined;
  const review: QaReview = { findings: g.list(0, g.chance(0.5) ? 0 : 5, () => findingOf(g)), stoppedBy: g.pick(STOPS) };
  if (g.chance(0.5)) review.declared = { success: g.chance(0.6), summary: g.pick(['', '완료', '못 했습니다', ' ']) };
  const count = () => g.pick<number | undefined>([undefined, undefined, 0, 1, 2, 5, NaN, -1]);
  const expected = count();
  const unmet = count();
  if (expected !== undefined || g.chance(0.1)) review.expectedRejections = expected;
  if (unmet !== undefined || g.chance(0.1)) review.unmetRejections = unmet;
  return review;
}

function goalOf(g: Gen): ExploreQaGoal {
  return { goal: textOf(g) + g.pick(['', ...KEYWORDS]), startPath: g.pick(['/', '/products', '', '/a b', '한글']), ...(g.chance(0.6) ? { confirmText: g.pick(['', '완료', '완료되었습니다', 'Σ', 'ΑΣ', 'İ', ' 완료', 'x', '😀']) } : {}) } as ExploreQaGoal;
}

function elementOf(g: Gen): QaElement {
  return {
    ref: g.pick(['e1', 'e2', 'e10', '']),
    role: g.pick(['button', 'link', 'textbox', '']),
    name: g.pick(['', '저장', 'Save', '(이름)', 'a\tb', '😀', 'ΑΣ']),
    tag: 'a',
    ...(g.chance(0.5) ? { testId: g.pick(['', 'save-btn', 'x']) } : {}),
    selector: 'x',
    rect: { x: 0, y: 0, width: 1, height: 1 },
  };
}

function actionOf(g: Gen, index: number): QaActionRecord {
  const tool = g.pick(['qa_click', 'qa_fill', 'qa_type', 'qa_press', 'qa_wait', 'qa_snapshot', 'qa_find', 'qa_screenshot', 'qa_hover', 'qa_scroll', 'qa_navigate', 'qa_other', 'qa_click ', 'QA_CLICK', '']);
  const valueOf = (): unknown =>
    g.pick<unknown>(['', '글자', 'a b', 0, 5, 1.5, NaN, -0, 1e21, true, false, null, undefined, [], ['a', 'b'], [1, [2, 3]], [null, undefined], {}, { a: 1 }, ' ', '😀']);
  const input: Record<string, unknown> = {};
  if (g.chance(0.8)) input.text = valueOf();
  if (g.chance(0.8)) input.key = valueOf();
  if (g.chance(0.8)) input.forText = g.pick<unknown>(['', 'x', '완료', ' ', 5, true, null, undefined, ['x'], 'text=x']);
  return {
    index,
    tool,
    input,
    ok: g.chance(0.8),
    ...(g.chance(0.6) ? { stableSelector: g.pick(['role=button[name="저장"]', '', '[data-testid=x]', ' ']) } : {}),
  } as QaActionRecord;
}

/** 코드 포인트 단위로 자른다(짝 없는 서로게이트는 napi 경계에서 U+FFFD가 되는 의도한 차이라 만들지 않는다) */
const cp = (text: string, from: number, to?: number): string => Array.from(text).slice(from, to).join('');
const asScroll = (y: number, max: number, atBottom: boolean, atTop: boolean): QaScrollPosition => ({ y, max, atBottom, atTop });

function runSeed(seed: number): void {
  const g = new Gen(seed);
  for (let i = 0; i < ITERATIONS; i++) {
    // judge: 확인 문구는 화면 글자에 있을 수도 없을 수도 있다
    const goal = goalOf(g);
    const diagnostics = diagnosticsOf(g);
    let pageText = textOf(g);
    if (goal.confirmText && g.chance(0.5)) pageText += g.pick(['', ' ', '\n']) + g.pick([goal.confirmText, goal.confirmText.toUpperCase(), goal.confirmText.toLowerCase(), cp(goal.confirmText, 1), cp(goal.confirmText, 0, -1)]);
    const review = reviewOf(g);
    const a = outcome(() => legacy.judge(goal, diagnostics, pageText, review));
    const b = outcome(() => judge(goal, diagnostics, pageText, review));
    countFlip({ goal, diagnostics, pageText, review }, a, b);
    compare('judge', { goal, diagnostics, pageText, review }, () => legacy.judge(goal, diagnostics, pageText, review), () => judge(goal, diagnostics, pageText, review), (o) => (o.threw ? '던짐' : (o.value as { status: string }).status));

    surrogateJudge(g);
    compare('diagnosticsCount', diagnostics, () => legacy.diagnosticsCount(diagnostics), () => diagnosticsCount(diagnostics), (o) => (o.threw ? '던짐' : String((o.value as number) > 0)));

    const actions = g.list(0, 6, () => actionOf(g, 0)).map((action, index) => ({ ...action, index: index + 1 }));
    compare('toPageCheckSteps', actions, () => legacy.toPageCheckSteps(actions), () => toPageCheckSteps(actions), (o) => (o.threw ? '던짐' : `steps ${Math.min((o.value as ConvertedSteps).steps.length, 3)}`));

    const entry = { name: g.pick(WORDS), text: g.pick(WORDS) + g.pick(WORDS), role: g.pick(['button', 'link', 'İ', 'ΑΣ', '']), tag: g.pick(['a', 'BUTTON', 'İ', 'ΑΣ', 'button']), ...(g.chance(0.6) ? { testId: g.pick(['', 'save-btn', 'ΑΣ', 'X']) } : {}) };
    const sources = [entry.name, entry.text, entry.role, entry.tag, entry.testId ?? '', '버튼', 'button', 'a'];
    const base = g.pick(sources);
    const needle = g.pick([base.trim().toLowerCase(), cp(base.trim().toLowerCase(), 1), cp(base.trim().toLowerCase(), 0, -1), base, base.toUpperCase(), '', ' ', g.pick(WORDS).toLowerCase()]);
    compare('matchScore', { entry, needle }, () => legacy.matchScore(entry, needle), () => matchScore(entry as unknown as RawElement, needle), (o) => (o.threw ? '던짐' : String(o.value)));

    const position = asScroll(g.pick([0, 600, 1200.5, -1, NaN, Infinity, 1e21, -0, 1e-7, 3]), g.pick([0, -1, 1, 600, 1800.25, NaN, Infinity, 1e21, -0]), g.chance(0.5), g.chance(0.5));
    compare('describeScrollPosition', position, () => legacy.describeScrollPosition(position), () => describeScrollPosition(position), (o) => (o.threw ? '던짐' : String(o.value).includes('스크롤되지 않습니다') ? '스크롤 없음' : String(o.value).includes('맨 아래에 닿았') ? '맨 아래' : String(o.value).includes('(맨 위)') ? '맨 위' : '중간'));

    const snapshot = { url: g.pick(['http://localhost:3100/', '/a', '']), title: g.pick(['제목', '', 'T — t']), elements: g.list(0, 4, () => elementOf(g)), truncated: g.chance(0.4) };
    const element = elementOf(g);
    compare('formatElement', element, () => legacy.formatElement(element), () => formatElement(element), (o) => (o.threw ? '던짐' : String(o.value).includes('(이름 없음)') ? '이름 없음' : String(o.value).includes('testid=') ? 'testid' : '일반'));
    compare('formatSnapshot', snapshot, () => legacy.formatSnapshot(snapshot), () => formatSnapshot(snapshot), (o) => (o.threw ? '던짐' : `요소 ${snapshot.elements.length}${snapshot.truncated ? ' 잘림' : ''}`));

    const ref = g.pick<unknown>([undefined, null, 5, true, {}, [], ['e3'], ...Array.from({ length: 14 }, () => g.pick(['', ' ', '"', "'", '`', '""', '"e3"', "'e3'", '`e3`', ' e3 ', '" e3 "', 'e3', "e'3", 'e3"', '"e3', '\u00a0e3\u00a0', '\ufeffe3\ufeff', '\u0085e3\u0085', '\u2028e3', '\u180ee3', '\u200be3', '“e3”', '‘e3’', 'e 3', '\n"\n', '""\u00a0""', ' " \' ` '])).map((s) => s + g.pick(['', '', '"', ' ']))]);
    compare('normalizeRef', ref, () => legacy.normalizeRef(ref), () => normalizeRef(ref), (o) => (o.threw ? '던짐' : o.value === undefined ? '없음' : '값'));

    const goalText = g.pick(['', ...KEYWORDS, ...KEYWORDS.map((k) => k.toUpperCase()), ...KEYWORDS.map((k) => k[0]!.toUpperCase() + k.slice(1)), 'ınspect', 'inſpect', 'revıew', 'AUDİT', 'Layout', 'LAYOUT', 'lAyOuT', 'laｙout', 'lay out', 'layou', 'inspec', 'rev iew', '읽기어려', '읽기 어렵', '잘', '찾', '검', '상품 목록에서 상세로 가서 댓글을 쓴다']);
    const padded = g.pick(['', '앞 ', 'x']) + goalText + g.pick(['', ' 뒤', 'y']);
    compare('isInspectionGoal', padded, () => legacy.isInspectionGoal(padded), () => isInspectionGoal(padded), (o) => (o.threw ? '던짐' : String(o.value)));
    compare('buildQaSystemPrompt', goal.goal, () => legacy.buildQaSystemPrompt(goal), () => buildQaSystemPrompt(goal), (o) => (o.threw ? '던짐' : String(o.value).includes('점검하는 일입니다') ? '점검형' : '일반'));
    compare('buildQaSystemPrompt(목표 없음)', null, () => legacy.buildQaSystemPrompt(), () => buildQaSystemPrompt(), (o) => (o.threw ? '던짐' : '일반'));
    compare('buildQaUserPrompt', goal, () => legacy.buildQaUserPrompt(goal), () => buildQaUserPrompt(goal), (o) => (o.threw ? '던짐' : String(o.value).includes('문구가 있어야') ? '확인 문구' : '없음'));
    const reason = g.pick<ExploreQaStopReason>([...STOPS, 'bogus' as ExploreQaStopReason]);
    compare('buildWrapUpPrompt', reason, () => legacy.buildWrapUpPrompt(reason), () => buildWrapUpPrompt(reason), (o) => (o.threw ? '던짐' : reason));
  }
}

describe('탐색 QA 차등 시험(옛 TS와 Rust 껍데기)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: ${ITERATIONS}회 × 함수 12개가 옛 TS와 같다`, () => {
      runSeed(seed);
    }, 600_000);
  }

  it('모든 함수에서 다른 결과가 0이고 판정이 열린 쪽으로 뒤집힌 수가 0이다', () => {
    if (REPORT) {
      for (const [name, t] of tallies) appendFileSync(REPORT, `${name}: 비교 ${t.compared}, 다름 ${t.different}, 분포 ${JSON.stringify(Object.fromEntries(t.distribution))}\n`);
      appendFileSync(REPORT, `judge 뒤집힘: ${JSON.stringify(flips)}\n`);
    }
    const bad = [...tallies].filter(([, t]) => t.different > 0).map(([name, t]) => `${name}: ${t.different}건\n${t.examples.join('\n')}`);
    expect(bad).toEqual([]);
    expect(tallies.size).toBe(13);
    expect(flips.failToPass).toBe(0);
    expect(flips.failToInconclusive).toBe(0);
    expect(flips.inconclusiveToPass).toBe(0);
    expect(flips.closed).toBe(0);
    expect(flips.judged).toBeGreaterThan(0);
    if (REPORT) appendFileSync(REPORT, `서로게이트 judge: ${JSON.stringify(surrogateFlips)}\n`);
    // 짝 없는 서로게이트: 열린 쪽(옛 fail·inconclusive가 더 통과 쪽으로) 뒤집힘은 0, 닫는 쪽은 B의 짝 없는 서로게이트가 A의 짝 일부일 때뿐(서로게이트 경계 시험이 원인을 따로 단언한다)
    expect(surrogateFlips.open).toBe(0);
    expect(surrogateFlips.judged).toBeGreaterThan(0);
  });

  it('결과 분포가 한쪽으로 쏠리지 않았고 입력이 비지 않았다', () => {
    expect([...tally('judge').distribution.keys()].sort()).toEqual(['fail', 'inconclusive', 'pass']);
    expect(tally('judge').distribution.get('pass')).toBeGreaterThan(20);
    expect(tally('judge').distribution.get('inconclusive')).toBeGreaterThan(20);
    expect([...tally('formatElement').distribution.keys()].sort()).toEqual(['testid', '이름 없음', '일반']);
    expect([...tally('diagnosticsCount').distribution.keys()].sort()).toEqual(['false', 'true']);
    expect([...tally('matchScore').distribution.keys()].sort()).toEqual(['0', '100', '20', '60', '80']);
    expect([...tally('describeScrollPosition').distribution.keys()].sort()).toEqual(['맨 아래', '맨 위', '스크롤 없음', '중간']);
    expect([...tally('isInspectionGoal').distribution.keys()].sort()).toEqual(['false', 'true']);
    expect([...tally('normalizeRef').distribution.keys()].sort()).toEqual(['값', '없음']);
    expect([...tally('buildQaSystemPrompt').distribution.keys()].sort()).toEqual(['일반', '점검형']);
    expect([...tally('buildQaUserPrompt').distribution.keys()].sort()).toEqual(['없음', '확인 문구']);
    expect([...tally('toPageCheckSteps').distribution.keys()].length).toBeGreaterThanOrEqual(3);
    expect(tally('toPageCheckSteps').distribution.has('던짐')).toBe(false);
    for (const [name, t] of tallies) {
      if (name === '대조') continue;
      expect([...t.distribution.keys()], name).not.toEqual(['던짐']);
      expect(t.compared, name).toBeGreaterThan(0);
    }
  });

  it('옛 구현이 던지는 입력(문자열로 바꿀 수 없는 text·key, 배열이 아닌 findings)을 새 껍데기도 던진다', () => {
    const bomb = { toString: () => { throw new Error('boom'); } };
    const fill = { index: 1, tool: 'qa_fill', ok: true, stableSelector: 'x', input: { text: bomb } } as unknown as QaActionRecord;
    const click = { index: 1, tool: 'qa_click', ok: true, stableSelector: 'x', input: { text: bomb } } as unknown as QaActionRecord;
    const failed = { index: 1, tool: 'qa_fill', ok: false, stableSelector: 'x', input: { text: bomb } } as unknown as QaActionRecord;
    expect(() => legacy.toPageCheckSteps([fill])).toThrow();
    expect(() => toPageCheckSteps([fill])).toThrow();
    // 쓰지 않는 자리의 값은 건드리지 않는다
    expect(JSON.stringify(toPageCheckSteps([click]))).toBe(JSON.stringify(legacy.toPageCheckSteps([click])));
    expect(JSON.stringify(toPageCheckSteps([failed]))).toBe(JSON.stringify(legacy.toPageCheckSteps([failed])));
    const broken = { findings: undefined, stoppedBy: 'finish' } as unknown as QaReview;
    expect(() => legacy.judge({}, diagnosticsOf(new Gen(1)), '', broken)).toThrow();
    expect(() => judge({}, diagnosticsOf(new Gen(1)), '', broken)).toThrow();
  });

  it('대조 장치: 경계를 ±1 바꾼 옛 구현과 결과 한 글자를 바꾼 값이 차이로 잡힌다', () => {
    const t = tally('대조');
    const clean: QaDiagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 1, accessibilityViolations: [] };
    // 가로 넘침 경계 1px을 >=로 바꾼 옛 구현: 1px에서 fail
    const mutantJudge = (d: QaDiagnostics) => ({ status: d.horizontalOverflowPx >= 1 ? 'fail' : 'pass', reason: '' });
    compare('대조', clean, () => mutantJudge(clean), () => judge({}, clean, '', undefined), () => '글');
    // 점수 100을 99로 바꾼 옛 구현
    compare('대조', 'save', () => 99, () => matchScore({ name: 'save', text: '', role: '', tag: 'a' } as unknown as RawElement, 'save'), () => '글');
    // 결과 한 글자
    const prompt = legacy.buildWrapUpPrompt('finish');
    compare('대조', prompt, () => prompt.replace('qa_finish로 마침', 'qa_finish로 마침.'), () => buildWrapUpPrompt('finish'), () => '글');
    compare('대조', prompt, () => perturb(prompt), () => buildWrapUpPrompt('finish'), () => '글');
    compare('대조', prompt, () => prompt, () => buildWrapUpPrompt('finish'), () => '글');
    // 키 순서
    const same = [{ index: 1, tool: 'qa_click', ok: true, input: {}, stableSelector: 's' }];
    compare('대조', same, () => ({ skipped: [], steps: [{ click: 's' }] }), () => toPageCheckSteps(same as unknown as QaActionRecord[]), () => '글');
    expect(t.different).toBe(5);
    tallies.delete('대조');
  });
});
