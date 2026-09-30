/**
 * PR 자동 리뷰 라운드(ADR-074)의 순수 상태 기계.
 *
 * 실제 diff 읽기·PR 댓글·고침 요청·올리기는 sessions.ts가 함수(ReviewRoundDeps)로 넘기고,
 * 이 모듈은 "이번 라운드에서 무엇을 하고 다음에 뭘 할지"만 정한다 — 세션·샌드박스·Docker 없이 vitest로 그대로 검증한다.
 *
 * 규칙(과제 1-c·1-d):
 *  - 차단·주요 지적이 없으면 그 라운드에서 통과(사람 검토 대기)
 *  - 지적이 있고 라운드가 남았으면 같은 세션에 고침을 요청하고, 통과하면 브랜치를 올린 뒤 다음 라운드로 이어간다
 *  - 라운드 상한에 이르렀으면 남은 지적과 함께 사람에게 넘긴다
 *  - 고침 요청이 검증을 통과하지 못하거나 올리기가 실패하면 멈춘다(사람이 봐야 한다)
 *  - PR 댓글 올리기가 실패해도 라운드 자체는 멈추지 않는다(commentError로만 남긴다)
 *  - 절대 병합하지 않고, 강제 푸시도 하지 않는다(이 모듈은 그런 도구를 아예 받지 않는다)
 */
import { buildPrReviewComment, buildPrReviewFixRequest, nextPrReviewStep, PrReviewError, requestPrReview, truncateDiff, type ModelAsk, type PrReviewFinding } from '@b-studio/agent';
import type { AgentUsage } from '@b-studio/agent';
import type { ReviewRoundView, ReviewStateView } from '../studio-events';

/** 고침 요청(sendMessage) 한 번의 결과. 검증을 통과하지 못했거나 시간 안에 끝나지 않았으면 ok:false */
export type ReviewFixResult = { ok: true; checkpoint?: { sha: string; shortSha: string } } | { ok: false; error: string };

/** sessions.ts가 세션 상태에 연결해 주는 실제 동작. 이 인터페이스만 맞으면 세션 없이도 라운드 진행을 검증할 수 있다 */
export interface ReviewRoundDeps {
  /** 도구 없이 한 번 묻는 호출 경로가 없는 백엔드면 undefined — 라운드 1에서 바로 멈춘다(오류) */
  ask: ModelAsk | undefined;
  /** PR base...head 전체 diff(unified diff 문자열). 크기 제한은 이 모듈이 truncateDiff로 한다 */
  diff: () => Promise<string>;
  /** 세션의 원래 사용자 요청들(오래된 것부터) */
  requests: () => readonly string[];
  /** 이 PR이 구현하는 요구사항의 압축 목록(ADR-089). 없으면 undefined(요구사항을 안 쓰거나 계산이 실패했다 — 리뷰는 그대로 진행한다) */
  requirementsContext?: () => string;
  /** PR에 댓글 하나를 남긴다. 실패하면 던진다 — 이 모듈이 잡아 commentError로만 남기고 라운드는 계속한다 */
  postComment: (body: string) => Promise<{ url?: string }>;
  /** 같은 세션에 고침을 요청하고 검증 게이트를 통과한 체크포인트까지 기다린다 */
  requestFix: (text: string) => Promise<ReviewFixResult>;
  /** 고침이 검증을 통과한 뒤 브랜치를 올린다(같은 PR을 갱신, 새 PR은 만들지 않는다). 실패하면 던진다 */
  push: () => Promise<void>;
  /** 라운드 시각을 넣을 시계. 테스트가 결정적인 값을 주입한다. 기본은 실제 시각 */
  now?: () => string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 백엔드가 리뷰어 호출을 지원하지 않을 때 남기는 문구. sessions.ts의 reviewAsk가 undefined를 주면 라운드 1에서 이 문구로 멈춘다 */
export const REVIEW_UNSUPPORTED_BACKEND = '이 세션 백엔드는 AI 리뷰를 지원하지 않습니다(claude-code·api 백엔드만 지원합니다)';

/**
 * 1라운드부터 라운드 상한까지(또는 통과·오류까지) 안에서 이어 돈다. rounds는 오래된 라운드가 먼저 온다.
 * onUpdate는 상태가 바뀔 때마다 전체 상태를 통째로 받는다(다시 재생해도 같은 결과가 나오도록 exported 이벤트와 같은 규칙).
 */
export async function runReviewRounds(deps: ReviewRoundDeps, maxRounds: number, onUpdate: (state: ReviewStateView) => void): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString());
  const rounds: ReviewRoundView[] = [];
  const publish = (state: ReviewStateView['state']): void => onUpdate({ state, maxRounds, rounds: [...rounds] });
  const setRound = (round: ReviewRoundView): void => {
    rounds[rounds.length - 1] = round;
  };

  for (let round = 1; round <= maxRounds; round++) {
    const startedAt = now();
    rounds.push({ round, status: 'running', startedAt });
    publish('running');

    if (!deps.ask) {
      setRound({ round, status: 'error', error: REVIEW_UNSUPPORTED_BACKEND, startedAt, finishedAt: now() });
      publish('stopped');
      return;
    }

    let findings: PrReviewFinding[];
    let tokens: AgentUsage | undefined;
    let omittedFiles: string[] = [];
    try {
      const diff = await deps.diff();
      const truncated = truncateDiff(diff);
      omittedFiles = [...truncated.omittedFiles];
      const result = await requestPrReview(deps.ask, { diff: truncated.diff, requests: deps.requests(), round, omittedFiles, requirementsContext: deps.requirementsContext?.() });
      findings = result.findings;
      tokens = result.usage;
    } catch (error) {
      // 형식 오류로 리뷰가 실패해도 그때까지 쓴 토큰은 잃지 않는다(PrReviewError가 들고 있다)
      const usage = error instanceof PrReviewError ? error.usage : undefined;
      setRound({ round, status: 'error', error: describeError(error), tokens: usage, startedAt, finishedAt: now() });
      publish('stopped');
      return;
    }

    const outcome = nextPrReviewStep(findings, round, maxRounds);
    const comment = buildPrReviewComment({ round, maxRounds, findings, outcome, omittedFiles });
    let commentUrl: string | undefined;
    let commentError: string | undefined;
    try {
      commentUrl = (await deps.postComment(comment)).url;
    } catch (error) {
      // 댓글 올리기 실패는 라운드를 막지 않는다(과제 1-b) — 이유만 남기고 계속한다
      commentError = describeError(error);
    }

    if (outcome === 'pass' || outcome === 'cap') {
      setRound({ round, status: outcome === 'pass' ? 'passed' : 'blocked_capped', findings, tokens, commentUrl, commentError, startedAt, finishedAt: now() });
      publish(outcome === 'pass' ? 'passed' : 'capped');
      return;
    }

    // outcome === 'fix': 차단·주요 지적을 같은 세션의 정상 요청 경로로 보낸다(검증 게이트·체크포인트를 그대로 거친다)
    setRound({ round, status: 'fixing', findings, tokens, commentUrl, commentError, startedAt });
    publish('running');

    const fix = await deps.requestFix(buildPrReviewFixRequest(findings));
    if (!fix.ok) {
      setRound({ round, status: 'fix_failed', findings, tokens, commentUrl, commentError, error: fix.error, startedAt, finishedAt: now() });
      publish('stopped');
      return;
    }

    try {
      await deps.push();
    } catch (error) {
      setRound({
        round,
        status: 'error',
        findings,
        tokens,
        commentUrl,
        commentError,
        error: `고친 변경을 올리지 못했습니다: ${describeError(error)}`,
        startedAt,
        finishedAt: now(),
      });
      publish('stopped');
      return;
    }

    setRound({ round, status: 'blocked_continue', findings, tokens, commentUrl, commentError, fixCheckpoint: fix.checkpoint, startedAt, finishedAt: now() });
    publish('running');
    // 다음 라운드로 이어간다(for 루프)
  }
}
