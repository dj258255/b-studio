import type { StudioEvent } from './studio-events';

/**
 * 사람이 다시 손댄 횟수를 세션 기록에서 센다(#668): 요청 가운데 한 번에 끝난 것이 몇 건인가.
 *
 * 모델을 부르지 않고 기록에 남은 사실만 쓴다. 그래서 "다시 시킨 요청"은 기록으로 가를 수 있는 것만 잡는다 —
 * 앞 요청이 끝까지 가지 못했거나(실패·오류·취소·되묻기·턴 상한), 되돌려진 파일을 다시 고쳤거나, 같은 글을 다시 보낸 경우다.
 * 앞 요청이 "완료"로 끝났는데 결과가 틀려서 다시 시킨 것(밖에서 돌린 CI가 실패했다, 컨테이너 안의 준비물이 사라졌다)은
 * 기록에 흔적이 없어 잡지 못한다. 그러니 다시 손댄 수는 "적어도", 한 번에 끝난 수는 "많아야"로 읽는다.
 *
 * 앞 요청과 같은 파일을 고쳤다는 것만으로는 다시 시킨 것으로 보지 않는다. 이어지는 다른 일도 같은 파일을 고친다
 * (실제 세션의 19건에서 그 규칙은 하나를 더 잡고 하나를 틀리게 잡았다, 실험 E18).
 */

/** 이 요청을 앞 요청의 다시 시킴으로 본 까닭 */
export type RedoReason =
  /** 앞 요청이 실패·오류·취소로 끝났다 */
  | 'after_unfinished'
  /** 앞 요청이 되묻고 멈췄고, 이 요청이 그 답이다 */
  | 'answer'
  /** 앞 요청이 턴 상한에 닿아 멈췄다 */
  | 'after_turn_limit'
  /** 앞선 요청에서 되돌려진 뒤 아직 체크포인트로 남지 않은 파일을 이 요청이 고쳤다 */
  | 'reverted_files'
  /** 앞 요청과 글이 같다 */
  | 'same_request';

export interface RequestOutcome {
  runId: string;
  status: Extract<StudioEvent, { type: 'run_finished' }>['status'];
  /** 끝까지 갔고(완료, 턴 상한 아님), 다른 요청의 다시 시킴이 아니며, 뒤의 어떤 요청도 이 요청을 다시 시키지 않았다 */
  oneShot: boolean;
  redo?: { reason: RedoReason; of: string };
  /** 검증 게이트가 실패한 회차 수(플랫폼 쪽 문제로 끝내지 못한 회차는 세지 않는다) */
  gateFailures: number;
  turnLimited: boolean;
  reverted: boolean;
}

export interface RequestSummary {
  /** 끝난 요청 수. 진행 중인 요청과, 시작이 기록에서 잘려 나간 요청은 세지 않는다 */
  total: number;
  /** 한 번에 끝난 요청(많아야 이만큼) */
  oneShot: number;
  /** 앞 요청을 다시 시킨 요청(적어도 이만큼). 되묻기의 답도 들어간다 */
  redone: number;
  /** 되묻고 멈춘 요청 */
  asked: number;
  /** 변경이 되돌려진 요청 */
  reverted: number;
  /** 게이트가 한 번 이상 실패한 요청 수와 실패한 회차의 합 */
  gateFailedRuns: number;
  gateFailures: number;
  /** 턴 상한에 닿은 요청(통과해 체크포인트로 남았든 실패했든) */
  turnLimited: number;
  outcomes: RequestOutcome[];
}

/** 요청별 판정을 뺀 합계. 화면에는 이것만 간다 */
export type RequestTotals = Omit<RequestSummary, 'outcomes'>;

export function requestTotals(summary: RequestSummary): RequestTotals {
  const { total, oneShot, redone, asked, reverted, gateFailedRuns, gateFailures, turnLimited } = summary;
  return { total, oneShot, redone, asked, reverted, gateFailedRuns, gateFailures, turnLimited };
}

interface DraftRun {
  runId: string;
  request: string;
  status?: RequestOutcome['status'];
  summary: string;
  incomplete: boolean;
  checkpointFiles: string[];
  revertedFiles: string[];
  reverted: boolean;
  /** 게이트 회차마다 실패했는가 */
  rounds: boolean[];
}

/** 턴 상한 안내로 시작하는 요약. 표시(run_finished.incomplete)가 생기기 전의 기록과, 실패로 끝난 턴 상한을 함께 잡는다 */
const TURN_LIMIT_SUMMARY = /^최대 턴 수\(\d+\)를 넘었습니다|Reached maximum number of turns/;

function turnLimited(run: DraftRun): boolean {
  return run.incomplete || TURN_LIMIT_SUMMARY.test(run.summary);
}

/** 세션 기록(오래된 것부터)에서 요청별 결과를 뽑는다 */
function collectRuns(events: readonly StudioEvent[]): DraftRun[] {
  const runs: DraftRun[] = [];
  const byId = new Map<string, DraftRun>();
  for (const event of events) {
    if (event.type === 'run_started') {
      const run: DraftRun = { runId: event.runId, request: event.request, summary: '', incomplete: false, checkpointFiles: [], revertedFiles: [], reverted: false, rounds: [] };
      runs.push(run);
      byId.set(run.runId, run);
      continue;
    }
    if (!('runId' in event) || typeof event.runId !== 'string') continue;
    const run = byId.get(event.runId);
    if (!run) continue;
    if (event.type === 'run_finished') {
      run.status = event.status;
      run.summary = event.summary;
      run.incomplete = event.incomplete === 'max_turns';
    } else if (event.type === 'checkpoint') {
      run.checkpointFiles.push(...event.checkpoint.files);
    } else if (event.type === 'reverted') {
      run.reverted = true;
      run.revertedFiles.push(...event.files);
    } else if (event.type === 'agent') {
      const inner = event.event;
      if (inner.type === 'verify_start') run.rounds.push(false);
      else if (inner.type === 'verify_result' && run.rounds.length > 0) {
        // 샌드박스·도커 쪽 문제로 끝내지 못한 회차는 에이전트의 실패가 아니다
        if (!inner.report.ok && !inner.report.platformFailure) run.rounds[run.rounds.length - 1] = true;
      } else if (inner.type === 'workflow_check' && run.rounds.length > 0 && !inner.check.ok) {
        run.rounds[run.rounds.length - 1] = true;
      }
    }
  }
  return runs.filter((run) => run.status !== undefined);
}

export function summarizeRequests(events: readonly StudioEvent[]): RequestSummary {
  const runs = collectRuns(events);
  const redo = new Map<string, { reason: RedoReason; of: string }>();
  // 되돌려진 뒤 아직 체크포인트로 남지 않은 파일 → 그 파일을 되돌린 요청
  const pendingReverted = new Map<string, string>();

  runs.forEach((run, index) => {
    const previous = runs[index - 1];
    if (previous) {
      if (previous.status === 'awaiting_input') redo.set(run.runId, { reason: 'answer', of: previous.runId });
      else if (previous.status !== 'done') redo.set(run.runId, { reason: 'after_unfinished', of: previous.runId });
      else if (turnLimited(previous)) redo.set(run.runId, { reason: 'after_turn_limit', of: previous.runId });
      else if (previous.request.trim() === run.request.trim() && run.request.trim() !== '') redo.set(run.runId, { reason: 'same_request', of: previous.runId });
    }
    const relanded = run.checkpointFiles.filter((file) => pendingReverted.has(file));
    if (relanded.length > 0 && !redo.has(run.runId)) redo.set(run.runId, { reason: 'reverted_files', of: pendingReverted.get(relanded[0]!)! });
    for (const file of run.checkpointFiles) pendingReverted.delete(file);
    for (const file of run.revertedFiles) pendingReverted.set(file, run.runId);
  });

  const redoneTargets = new Set([...redo.values()].map((entry) => entry.of));
  const outcomes = runs.map((run): RequestOutcome => {
    const again = redo.get(run.runId);
    const limited = turnLimited(run);
    return {
      runId: run.runId,
      status: run.status!,
      oneShot: run.status === 'done' && !limited && !again && !redoneTargets.has(run.runId),
      ...(again ? { redo: again } : {}),
      gateFailures: run.rounds.filter(Boolean).length,
      turnLimited: limited,
      reverted: run.reverted,
    };
  });

  return {
    total: outcomes.length,
    oneShot: outcomes.filter((outcome) => outcome.oneShot).length,
    redone: outcomes.filter((outcome) => outcome.redo !== undefined).length,
    asked: outcomes.filter((outcome) => outcome.status === 'awaiting_input').length,
    reverted: outcomes.filter((outcome) => outcome.reverted).length,
    gateFailedRuns: outcomes.filter((outcome) => outcome.gateFailures > 0).length,
    gateFailures: outcomes.reduce((sum, outcome) => sum + outcome.gateFailures, 0),
    turnLimited: outcomes.filter((outcome) => outcome.turnLimited).length,
    outcomes,
  };
}

/** 토큰 화면의 한 줄. 끝난 요청이 없으면 빈 글 */
export function requestSummaryLine(summary: RequestTotals): string {
  if (summary.total === 0) return '';
  const parts = [`요청 ${summary.total}건 가운데 한 번에 끝난 것 ${summary.oneShot}건`];
  if (summary.redone > 0) parts.push(`다시 손댄 요청 ${summary.redone}건`);
  if (summary.asked > 0) parts.push(`되묻기 ${summary.asked}건`);
  if (summary.reverted > 0) parts.push(`되돌림 ${summary.reverted}건`);
  if (summary.gateFailures > 0) parts.push(`게이트 실패 ${summary.gateFailures}회(${summary.gateFailedRuns}건)`);
  if (summary.turnLimited > 0) parts.push(`턴 상한 ${summary.turnLimited}건`);
  return parts.join(' · ');
}
