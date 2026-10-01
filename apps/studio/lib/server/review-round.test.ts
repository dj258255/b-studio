import { describe, expect, it, vi } from 'vitest';
import type { AgentUsage } from '@b-studio/agent';
import type { ReviewStateView } from '../studio-events';
import { REVIEW_UNSUPPORTED_BACKEND, runReviewRounds, type ReviewFixResult, type ReviewRoundDeps } from './review-round';

const usage: AgentUsage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function askReturning(...replies: string[]) {
  let call = 0;
  return vi.fn(async () => ({ text: replies[Math.min(call++, replies.length - 1)]!, usage }));
}

function baseDeps(overrides: Partial<ReviewRoundDeps> = {}): ReviewRoundDeps {
  return {
    ask: askReturning('{"findings":[]}'),
    diff: async () => 'diff --git a/a.ts b/a.ts\n+x\n',
    requests: () => ['요청1'],
    postComment: async () => ({ url: 'https://github.com/acme/orders/pull/1#issuecomment-1' }),
    requestFix: async (): Promise<ReviewFixResult> => ({ ok: true, checkpoint: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa' } }),
    push: async () => {},
    ...overrides,
  };
}

async function collect(deps: ReviewRoundDeps, maxRounds: number): Promise<ReviewStateView[]> {
  const updates: ReviewStateView[] = [];
  await runReviewRounds(deps, maxRounds, (state) => updates.push(state));
  return updates;
}

describe('runReviewRounds', () => {
  it('1라운드에 차단·주요 지적이 없으면 통과하고 사람 검토를 기다린다', async () => {
    const requestFix = vi.fn(async (): Promise<ReviewFixResult> => ({ ok: true }));
    const deps = baseDeps({ requestFix });
    const updates = await collect(deps, 2);
    const last = updates.at(-1)!;
    expect(last.state).toBe('passed');
    expect(last.rounds).toHaveLength(1);
    expect(last.rounds[0]).toMatchObject({ round: 1, status: 'passed', commentUrl: 'https://github.com/acme/orders/pull/1#issuecomment-1' });
    expect(requestFix).not.toHaveBeenCalled();
  });

  it('requirementsContext를 주면 리뷰어 호출의 사용자 메시지에 그대로 실린다(ADR-092)', async () => {
    const ask = askReturning('{"findings":[]}');
    const deps = baseDeps({ ask, requirementsContext: () => '[이 PR이 구현하는 요구사항]\n- R1. 로그인' });
    await collect(deps, 1);
    const [firstCall] = ask.mock.calls as unknown as Array<[{ user: string }]>;
    expect(firstCall![0].user).toContain('- R1. 로그인');
  });

  it('차단 지적을 고친 뒤 다음 라운드에서 통과하면 라운드 2개가 남고(오래된 순) fixCheckpoint를 담는다', async () => {
    const ask = askReturning('{"findings":[{"severity":"blocker","file":"a.ts","title":"버그","detail":"설명"}]}', '{"findings":[]}');
    const requestFix = vi.fn(async (): Promise<ReviewFixResult> => ({ ok: true, checkpoint: { sha: 'b'.repeat(40), shortSha: 'bbbbbbb' } }));
    const push = vi.fn(async () => {});
    const deps = baseDeps({ ask, requestFix, push });

    const updates = await collect(deps, 2);
    const last = updates.at(-1)!;
    expect(last.state).toBe('passed');
    expect(last.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(last.rounds[0]).toMatchObject({ round: 1, status: 'blocked_continue', fixCheckpoint: { sha: 'b'.repeat(40), shortSha: 'bbbbbbb' } });
    expect(last.rounds[1]).toMatchObject({ round: 2, status: 'passed' });
    expect(requestFix).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('차단 지적이 라운드 상한까지 남으면 더는 고치지 않고 사람에게 넘긴다', async () => {
    const ask = askReturning('{"findings":[{"severity":"major","file":"a.ts","title":"버그","detail":"설명"}]}');
    const requestFix = vi.fn(async (): Promise<ReviewFixResult> => ({ ok: true, checkpoint: { sha: 'c'.repeat(40), shortSha: 'ccccccc' } }));
    const deps = baseDeps({ ask, requestFix });

    const updates = await collect(deps, 2);
    const last = updates.at(-1)!;
    expect(last.state).toBe('capped');
    expect(last.rounds).toHaveLength(2);
    expect(last.rounds[1]).toMatchObject({ round: 2, status: 'blocked_capped' });
    // 상한에 걸린 마지막 라운드는 고치러 보내지 않는다(1라운드에서만 고쳤다)
    expect(requestFix).toHaveBeenCalledTimes(1);
  });

  it('고침 요청이 검증 게이트를 통과하지 못하면 멈추고 사람에게 넘긴다', async () => {
    const ask = askReturning('{"findings":[{"severity":"blocker","file":"a.ts","title":"버그","detail":"설명"}]}');
    const requestFix = vi.fn(async (): Promise<ReviewFixResult> => ({ ok: false, error: '검증 실패: 테스트가 깨졌습니다' }));
    const push = vi.fn(async () => {});
    const deps = baseDeps({ ask, requestFix, push });

    const updates = await collect(deps, 2);
    const last = updates.at(-1)!;
    expect(last.state).toBe('stopped');
    expect(last.rounds[0]).toMatchObject({ status: 'fix_failed', error: '검증 실패: 테스트가 깨졌습니다' });
    expect(push).not.toHaveBeenCalled();
  });

  it('브랜치를 다시 올리지 못해도(네트워크 실패 등) 멈추고 사람에게 넘긴다', async () => {
    const ask = askReturning('{"findings":[{"severity":"blocker","file":"a.ts","title":"버그","detail":"설명"}]}');
    const push = vi.fn(async () => {
      throw new Error('git push 실패');
    });
    const deps = baseDeps({ ask, push });

    const updates = await collect(deps, 2);
    const last = updates.at(-1)!;
    expect(last.state).toBe('stopped');
    expect(last.rounds[0]!.status).toBe('error');
    expect(last.rounds[0]!.error).toContain('git push 실패');
  });

  it('댓글 올리기가 실패해도 라운드를 막지 않고 commentError만 남긴다', async () => {
    const postComment = vi.fn(async () => {
      throw new Error('403 권한 없음');
    });
    const deps = baseDeps({ postComment });

    const updates = await collect(deps, 2);
    const last = updates.at(-1)!;
    expect(last.state).toBe('passed');
    expect(last.rounds[0]).toMatchObject({ status: 'passed', commentError: '403 권한 없음' });
    expect(last.rounds[0]!.commentUrl).toBeUndefined();
  });

  it('리뷰어 호출 자체가 실패하면(형식 오류 등) 멈추고, 그때까지 쓴 토큰을 남긴다', async () => {
    const ask = askReturning('이건 JSON이 아닙니다');
    const deps = baseDeps({ ask });

    const updates = await collect(deps, 2);
    const last = updates.at(-1)!;
    expect(last.state).toBe('stopped');
    expect(last.rounds[0]!.status).toBe('error');
    expect(last.rounds[0]!.tokens).toEqual(usage);
  });

  it('이 세션 백엔드가 리뷰를 지원하지 않으면(ask 없음) 바로 멈춘다', async () => {
    const deps = baseDeps({ ask: undefined });
    const updates = await collect(deps, 2);
    const last = updates.at(-1)!;
    expect(last.state).toBe('stopped');
    expect(last.rounds[0]!.error).toBe(REVIEW_UNSUPPORTED_BACKEND);
  });
});
