import { describe, expect, it } from 'vitest';
import { requestSummaryLine, requestTotals, summarizeRequests } from './request-outcomes';
import type { StudioEvent } from './studio-events';

type Finished = Extract<StudioEvent, { type: 'run_finished' }>;

const started = (runId: string, request = `요청 ${runId}`): StudioEvent => ({ type: 'run_started', runId, request });
const finished = (runId: string, status: Finished['status'] = 'done', extra: Partial<Finished> = {}): StudioEvent => ({ type: 'run_finished', runId, status, summary: status === 'done' ? '끝' : '못 끝냄', ...extra });
const checkpoint = (runId: string, files: string[]): StudioEvent =>
  ({ type: 'checkpoint', runId, checkpoint: { sha: `${runId}-sha`, shortSha: runId, message: 'm', createdAt: '2026-10-12T00:00:00Z', files } }) as StudioEvent;
const reverted = (runId: string, files: string[]): StudioEvent => ({ type: 'reverted', runId, files, patch: '', restarted: [], databases: [] }) as StudioEvent;
const gateRound = (runId: string, failedCheck?: string, report: { ok: boolean; platformFailure?: string } = { ok: true }): StudioEvent[] => [
  { type: 'agent', runId, event: { type: 'verify_start', files: [] } } as StudioEvent,
  { type: 'agent', runId, event: { type: 'verify_result', report, text: '' } } as unknown as StudioEvent,
  ...(failedCheck ? [{ type: 'agent', runId, event: { type: 'workflow_check', check: { stage: 'test', name: failedCheck, ok: false, attempts: 1 } } } as unknown as StudioEvent] : []),
];
/** 요청 하나: 시작 → (게이트) → (체크포인트) → 끝 */
const run = (runId: string, files: string[] = [], request?: string): StudioEvent[] => [started(runId, request), ...gateRound(runId), ...(files.length > 0 ? [checkpoint(runId, files)] : []), finished(runId)];

const flags = (events: StudioEvent[]) =>
  Object.fromEntries(summarizeRequests(events).outcomes.map((outcome) => [outcome.runId, outcome.oneShot ? '한번에' : (outcome.redo?.reason ?? '아님')]));

describe('한 번에 끝난 요청을 세션 기록에서 센다(#668)', () => {
  it('이어지는 새 일은 각각 한 번에 끝난 것으로 센다', () => {
    const summary = summarizeRequests([...run('a', ['x.ts']), ...run('b', ['y.ts']), ...run('c')]);
    expect(summary).toMatchObject({ total: 3, oneShot: 3, redone: 0, asked: 0, reverted: 0, gateFailures: 0, gateFailedRuns: 0, turnLimited: 0 });
  });

  it('실패로 끝난 요청과 그 뒤의 요청은 한 번에 끝난 것이 아니다', () => {
    const events = [started('a'), ...gateRound('a', 'unit'), reverted('a', ['x.ts']), finished('a', 'failed'), ...run('b', ['x.ts']), ...run('c', ['y.ts'])];
    expect(flags(events)).toEqual({ a: '아님', b: 'after_unfinished', c: '한번에' });
    expect(summarizeRequests(events)).toMatchObject({ total: 3, oneShot: 1, redone: 1, reverted: 1 });
  });

  it('오류와 취소로 끝난 요청 뒤의 요청도 다시 시킨 것으로 본다', () => {
    expect(flags([started('a'), finished('a', 'error'), ...run('b')])).toEqual({ a: '아님', b: 'after_unfinished' });
    expect(flags([started('a'), finished('a', 'cancelled'), ...run('b')])).toEqual({ a: '아님', b: 'after_unfinished' });
  });

  it('되묻고 멈춘 요청과 그 답은 한 번에 끝난 것이 아니고, 되묻기로 따로 센다', () => {
    const events = [started('a'), finished('a', 'awaiting_input'), ...run('b', ['x.ts']), ...run('c')];
    expect(flags(events)).toEqual({ a: '아님', b: 'answer', c: '한번에' });
    expect(summarizeRequests(events)).toMatchObject({ asked: 1, redone: 1, oneShot: 1 });
  });

  it('턴 상한에 닿은 요청은 통과해 남았어도 한 번에 끝난 것이 아니고, 그 뒤의 요청은 이어서 시킨 것이다', () => {
    const marked = [started('a'), ...gateRound('a'), checkpoint('a', ['x.ts']), finished('a', 'done', { incomplete: 'max_turns' }), ...run('b', ['x.ts'])];
    expect(flags(marked)).toEqual({ a: '아님', b: 'after_turn_limit' });
    expect(summarizeRequests(marked).turnLimited).toBe(1);
    // 표시가 생기기 전의 기록은 요약 글로 알아본다
    const old = [started('a'), finished('a', 'done', { summary: '최대 턴 수(40)를 넘었습니다. 다만 지금까지의 변경이 검증 게이트를 통과해 체크포인트로 남깁니다(요청의 일부만 끝났을 수 있습니다).' }), ...run('b')];
    expect(flags(old)).toEqual({ a: '아님', b: 'after_turn_limit' });
    // 실패로 끝난 턴 상한도 턴 상한으로 센다
    const failed = [started('a'), finished('a', 'error', { summary: 'Claude Code returned an error result: Reached maximum number of turns (80)' }), ...run('b')];
    expect(summarizeRequests(failed)).toMatchObject({ turnLimited: 1, redone: 1 });
    expect(flags(failed).b).toBe('after_unfinished');
  });

  it('되돌려진 파일을 나중 요청이 다시 고치면, 사이에 다른 요청이 끼어 있어도 다시 시킨 것으로 본다', () => {
    const events = [started('a'), reverted('a', ['x.ts', 'studio.yaml']), finished('a', 'failed'), ...run('b'), ...run('c', ['x.ts']), ...run('d', ['x.ts'])];
    // b는 실패 바로 뒤라서, c는 되돌려진 x.ts를 다시 고쳐서. d는 이미 다시 남은 파일을 고친 새 일이다
    expect(flags(events)).toEqual({ a: '아님', b: 'after_unfinished', c: 'reverted_files', d: '한번에' });
    expect(summarizeRequests(events).outcomes[2]!.redo).toEqual({ reason: 'reverted_files', of: 'a' });
  });

  it('같은 글을 다시 보내면 앞의 요청도 한 번에 끝난 것이 아니다', () => {
    const events = [...run('a', [], '지시문을 옮겨 적어 주세요'), ...run('b', [], ' 지시문을 옮겨 적어 주세요 '), ...run('c', [], '다른 요청')];
    expect(flags(events)).toEqual({ a: '아님', b: 'same_request', c: '한번에' });
  });

  it('앞 요청과 같은 파일을 고쳤다는 것만으로는 다시 시킨 것으로 보지 않는다', () => {
    // 이어지는 다른 일도 같은 파일을 고친다(실제 세션에서 이 규칙은 하나를 더 잡고 하나를 틀리게 잡았다)
    expect(flags([...run('a', ['Controller.java']), ...run('b', ['Controller.java'])])).toEqual({ a: '한번에', b: '한번에' });
  });

  it('게이트가 실패한 회차를 세고, 스스로 고쳐 통과한 요청은 한 번에 끝난 것으로 둔다', () => {
    const events = [started('a'), ...gateRound('a', 'unit'), ...gateRound('a', undefined, { ok: false }), ...gateRound('a'), checkpoint('a', ['x.ts']), finished('a')];
    const summary = summarizeRequests(events);
    expect(summary.outcomes[0]).toMatchObject({ oneShot: true, gateFailures: 2 });
    expect(summary).toMatchObject({ gateFailures: 2, gateFailedRuns: 1 });
  });

  it('샌드박스 쪽 문제로 끝내지 못한 게이트 회차는 실패로 세지 않는다', () => {
    const events = [started('a'), ...gateRound('a', undefined, { ok: false, platformFailure: '도커에 닿지 못함' }), ...gateRound('a'), finished('a')];
    expect(summarizeRequests(events).gateFailures).toBe(0);
  });

  it('진행 중인 요청과 시작이 기록에서 잘린 요청은 세지 않는다', () => {
    const events = [finished('gone'), checkpoint('gone', ['x.ts']), ...run('a'), started('running'), ...gateRound('running', 'unit')];
    const summary = summarizeRequests(events);
    expect(summary.outcomes.map((outcome) => outcome.runId)).toEqual(['a']);
    expect(summary).toMatchObject({ total: 1, oneShot: 1, gateFailures: 0 });
  });

  it('화면에 보내는 합계에는 요청별 판정이 들어가지 않는다', () => {
    const totals = requestTotals(summarizeRequests([...run('a'), started('b'), finished('b', 'failed')]));
    expect(totals).toEqual({ total: 2, oneShot: 1, redone: 0, asked: 0, reverted: 0, gateFailedRuns: 0, gateFailures: 0, turnLimited: 0 });
  });

  it('한 줄로 적을 때 0인 항목은 빼고, 끝난 요청이 없으면 아무것도 적지 않는다', () => {
    expect(requestSummaryLine(summarizeRequests([]))).toBe('');
    expect(requestSummaryLine(summarizeRequests([...run('a'), ...run('b')]))).toBe('요청 2건 가운데 한 번에 끝난 것 2건');
    const mixed = [started('a'), ...gateRound('a', 'unit'), reverted('a', ['x.ts']), finished('a', 'failed'), ...run('b', ['x.ts']), started('c'), finished('c', 'awaiting_input'), ...run('d'), started('e'), finished('e', 'done', { incomplete: 'max_turns' })];
    expect(requestSummaryLine(summarizeRequests(mixed))).toBe('요청 5건 가운데 한 번에 끝난 것 0건 · 다시 손댄 요청 2건 · 되묻기 1건 · 되돌림 1건 · 게이트 실패 1회(1건) · 턴 상한 1건');
  });
});
