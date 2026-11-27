import { describe, expect, it } from 'vitest';
import { openRecords, rangeFrom, recordsKey, recordsLines, recordsScrollLimit, type RecordsReport, type RecordsState, type RecordsStats } from './records';
import { stripAnsi } from './screen';
import { DEFAULT_THEME } from './theme';

/**
 * 기록 화면(#891): AI별 결과와 프로젝트 토큰 보고서. 웹의 결과표·토큰 보고서 화면을 터미널로 옮긴다.
 * 키는 순수 함수라 상태와 불러올 것(load)만 본다. 그리기는 글만 본다(색은 지운다)
 */
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const projects = [
  { id: 'p1', name: 'shop' },
  { id: 'p2', name: 'blog' },
];
const usage = (total: number) => ({ inputTokens: total, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

const stats: RecordsStats = {
  rows: [],
  excluded: { asks: 4, unfinished: 2 },
  byAccount: [
    { backend: 'claude-code', accountId: 'pio', runs: 12, passed: 10, failed: 1, errors: 1, passRate: 10 / 12, averageTokens: 123_000, averageCostUsd: 0.41 },
    { backend: 'codex', runs: 3, passed: 1, failed: 2, errors: 0, passRate: 1 / 3, averageTokens: 5_100 },
  ],
  recentFailures: [{ sessionId: 's9', backend: 'codex', request: '결제 실패 경로 테스트 보강', at: '2026-10-22T05:03:00.000Z', outcome: 'failed' }],
};

const report: RecordsReport = {
  projectId: 'p1',
  projectName: 'shop',
  generatedAt: '2026-10-23T12:00:00.000Z',
  sessions: 2,
  requests: [
    { sessionId: 's1', kind: 'normal', request: '주문 모듈 나누기', at: '2026-10-22T01:00:00.000Z', usage: usage(90_000), costUsd: 1.2, result: 'changed' },
    { sessionId: 's1', kind: 'normal', request: '테스트 더하기', usage: usage(30_000), costUsd: 0.3, result: 'changed' },
    { sessionId: 's2', kind: 'normal', request: '로그인 오류', usage: usage(20_000), result: 'failed' },
  ],
  totals: usage(140_000),
  estimatedCostUsd: 1.5,
  usageByModel: { sonnet: usage(120_000), 'gpt-5-codex': usage(20_000) },
  modelCosts: { sonnet: 1.5 },
};

function text(state: RecordsState, extra: Partial<Parameters<typeof recordsLines>[1]> = {}): string {
  return recordsLines(state, { theme: DEFAULT_THEME, width: 100, height: 30, now: NOW, ...extra })
    .map(stripAnsi)
    .join('\n');
}

describe('모델별 결과 표', () => {
  const withModels: RecordsStats = {
    ...stats,
    byModel: [
      { backend: 'claude-code', model: 'claude-sonnet-5', runs: 8, oneShot: 5, passed: 7, failed: 1, reverted: 1, judged: 8, retries: 6, averageRetries: 0.75 },
      { backend: 'codex', model: '(모름)', runs: 2, oneShot: 0, passed: 1, failed: 1, reverted: 0, judged: 2, retries: 0, averageRetries: 0 },
      { backend: 'claude-code', model: 'claude-opus-5', effort: 'high', runs: 1, oneShot: 1, passed: 1, failed: 0, reverted: 0, judged: 1, retries: 0, averageRetries: 0 },
    ],
  };
  const open = (value: RecordsStats): RecordsState => ({ ...openRecords(projects), loading: false, stats: value });

  it('모델마다 실행 수·한 번에 통과·평균 재시도·실패/되돌림을 한 줄로 보인다', () => {
    const out = text(open(withModels), { height: 60 });
    expect(out).toContain('모델별');
    const sonnet = out.split('\n').find((line) => line.includes('claude-sonnet-5'))!;
    expect(sonnet).toMatch(/Claude/);
    expect(sonnet).toMatch(/\b8\b.*5\/8.*0\.8.*1\/1/);
    expect(out.split('\n').find((line) => line.includes('claude-opus-5'))).toContain('high');
  });
  it('모델을 알리지 않은 실행은 (모름)으로 보이고, 읽기만 하는 표라는 것과 값의 출처를 적는다', () => {
    const out = text(open(withModels), { height: 60 });
    expect(out.split('\n').find((line) => line.includes('(모름)'))).toContain('Codex');
    expect(out).toContain('CLI가 알린 값');
  });
  it('옛 서버(byModel 없음)나 빈 표면 절을 그리지 않는다', () => {
    expect(text(open(stats), { height: 60 })).not.toContain('모델별');
    expect(text(open({ ...stats, byModel: [] }), { height: 60 })).not.toContain('모델별');
  });
  it('모양이 틀린 값은 0으로 꾸미지 않고 줄을 건너뛴다', () => {
    const bad = { ...withModels, byModel: [{ backend: 'claude-code', model: 'x', runs: 'many' }, ...withModels.byModel!] } as unknown as RecordsStats;
    const out = text(open(bad), { height: 60 });
    expect(out).toContain('claude-sonnet-5');
    expect(out).not.toContain('many');
  });
});

describe('기록 화면 키', () => {
  it('열면 AI별 결과 탭이고, 고른 세션의 프로젝트를 토큰 보고서의 프로젝트로 고른다', () => {
    const state = openRecords(projects, 'blog');
    expect(state).toMatchObject({ tab: 'ai', projectIndex: 1, range: 'all', loading: true, scroll: 0 });
    expect(openRecords(projects, '없는 곳').projectIndex).toBe(0);
  });

  it('Tab으로 토큰 보고서로 가면 그 프로젝트의 보고서를 불러오고, 다시 Tab이면 AI별 결과로 온다', () => {
    const first = recordsKey({ ...openRecords(projects), loading: false, stats }, '\t', NOW);
    expect(first.records?.tab).toBe('tokens');
    expect(first.load).toEqual({ kind: 'report', projectId: 'p1' });
    const back = recordsKey({ ...first.records!, report }, '\t', NOW);
    expect(back.records?.tab).toBe('ai');
    // 이미 받은 결과는 다시 부르지 않는다
    expect(back.load).toBeUndefined();
  });

  it('토큰 보고서에서 ←→는 프로젝트, d는 기간(전체 → 7일 → 30일)을 바꾸고 보고서를 다시 부른다', () => {
    const tokens: RecordsState = { ...openRecords(projects), tab: 'tokens', loading: false, report };
    const next = recordsKey(tokens, '\x1b[C', NOW);
    expect(next.records?.projectIndex).toBe(1);
    expect(next.load).toEqual({ kind: 'report', projectId: 'p2' });
    const week = recordsKey(tokens, 'd', NOW);
    expect(week.records?.range).toBe('7d');
    expect(week.load).toEqual({ kind: 'report', projectId: 'p1', from: '2026-10-16T12:00:00.000Z' });
    expect(recordsKey(week.records!, 'd', NOW).records?.range).toBe('30d');
    expect(recordsKey({ ...week.records!, range: '30d' }, 'd', NOW).load).toEqual({ kind: 'report', projectId: 'p1' });
  });

  it('r은 지금 탭을 다시 부르고, ↑↓·PgUp PgDn은 본문을 굴리고, Esc·q는 닫는다', () => {
    const ai: RecordsState = { ...openRecords(projects), loading: false, stats };
    expect(recordsKey(ai, 'r', NOW).load).toEqual({ kind: 'stats' });
    expect(recordsKey(ai, '\x1b[B', NOW).records?.scroll).toBe(1);
    expect(recordsKey({ ...ai, scroll: 3 }, '\x1b[A', NOW).records?.scroll).toBe(2);
    expect(recordsKey(ai, '\x1b[A', NOW).records?.scroll).toBe(0);
    expect(recordsKey(ai, '\x1b[6~', NOW).records?.scroll).toBe(10);
    expect(recordsKey(ai, '\x1b', NOW).records).toBeUndefined();
    expect(recordsKey(ai, 'q', NOW).records).toBeUndefined();
  });

  it('기간의 시작은 지금에서 7일·30일 전이고, 전체면 없다', () => {
    expect(rangeFrom('all', NOW)).toBeUndefined();
    expect(rangeFrom('30d', NOW)).toBe('2026-09-23T12:00:00.000Z');
  });
});

describe('기록 화면 그리기', () => {
  it('AI·계정마다 요청 수, 통과율 막대와 %, 평균 토큰·비용을 보이고, 계정 이름을 붙인다', () => {
    const out = text({ ...openRecords(projects), loading: false, stats }, { names: { pio: '피오' } });
    expect(out).toContain('AI별 결과');
    expect(out).toContain('토큰 보고서');
    expect(out).toMatch(/Claude · 피오\s+12\s.*83%\s+12\.3만\s+\$0\.41/);
    expect(out).toMatch(/Codex · 기본\s+3\s.*33%\s+5\.1천\s+-/);
    expect(out).toContain('최근 실패');
    expect(out).toMatch(/10\/22 \d\d:03\s+Codex\s+검증 실패\s+결제 실패 경로 테스트 보강/);
    expect(out).toContain('질문 4건과 끝나지 않은 실행 2건은 넣지 않았습니다');
  });

  it('옛 서버가 계정별 묶음을 주지 않으면 AI별 줄로 대신하고, 기록이 없으면 그렇게 말한다', () => {
    const old: RecordsStats = {
      rows: [
        { backend: 'claude-code', model: 'sonnet', runs: 2, passed: 1, failed: 1, errors: 0, passRate: 0.5 },
        { backend: 'claude-code', model: 'opus', runs: 1, passed: 1, failed: 0, errors: 0, passRate: 1 },
      ],
      excluded: { asks: 0, unfinished: 0 },
    };
    expect(text({ ...openRecords(projects), loading: false, stats: old })).toMatch(/Claude\s+3\s.*67%/);
    expect(text({ ...openRecords(projects), loading: false, stats: { rows: [], excluded: { asks: 0, unfinished: 0 } } })).toContain('아직 끝난 만들기 요청이 없습니다');
  });

  it('불러오는 중과 실패를 보인다', () => {
    expect(text(openRecords(projects))).toContain('불러오는 중');
    expect(text({ ...openRecords(projects), loading: false, statsError: '스튜디오가 500으로 답했습니다' })).toContain('불러오지 못했습니다: 스튜디오가 500으로 답했습니다');
  });

  it('토큰 보고서는 프로젝트·기간, 합계, 세션별·모델별 막대를 보이고 세션은 desk가 아는 제목으로 쓴다', () => {
    const out = text({ ...openRecords(projects), tab: 'tokens', loading: false, report, range: '7d' }, { titles: { s1: '주문 모듈 리팩터링' } });
    expect(out).toContain('‹shop›');
    expect(out).toContain('최근 7일');
    expect(out).toMatch(/합계 14만 토큰 · \$1\.50 · 세션 2 · 요청 3/);
    expect(out).toMatch(/주문 모듈 리팩터링\s+█+.*12만\s+\$1\.50/);
    // desk가 모르는 세션은 그 세션의 첫 요청 글로 쓴다
    expect(out).toMatch(/로그인 오류\s+.*2만\s+-/);
    expect(out).toMatch(/sonnet\s+█+.*12만\s+\$1\.50/);
    expect(out).toMatch(/gpt-5-codex\s+.*2만\s+-/);
  });

  it('줄 수는 정확히 height이고, 굴린 만큼 본문이 올라간다', () => {
    const state: RecordsState = { ...openRecords(projects), loading: false, stats };
    const lines = recordsLines(state, { theme: DEFAULT_THEME, width: 60, height: 12, now: NOW });
    expect(lines).toHaveLength(12);
    const scrolled = recordsLines({ ...state, scroll: 2 }, { theme: DEFAULT_THEME, width: 60, height: 6, now: NOW }).map(stripAnsi);
    expect(scrolled.join('\n')).not.toContain('AI · 계정');
    // 탭 줄은 굴려도 남는다
    expect(scrolled[0]).toContain('AI별 결과');
    // 끝보다 더 굴려도 마지막 쪽에 멈춘다
    expect(recordsScrollLimit(state, { theme: DEFAULT_THEME, width: 60, height: 6, now: NOW })).toBe(4);
  });

  it('토큰 보고서에 한 번에 끝난 요청을 "n/m"으로 보이고, 한쪽으로 치우친 값이라는 것을 적는다', () => {
    const withOutcomes: RecordsReport = { ...report, requestOutcomes: { total: 3, oneShot: 2, redone: 1, asked: 0, reverted: 0, gateFailedRuns: 0, gateFailures: 0, turnLimited: 0 } };
    const out = text({ ...openRecords(projects), tab: 'tokens', loading: false, report: withOutcomes });
    expect(out).toContain('한 번에 끝난 요청 2/3');
    expect(out).toContain('다시 손댄 요청 1건');
    expect(out).toMatch(/많아야/);
  });

  it('집계 값이 없으면(옛 서버 등) 0이 아니라 "모름"으로 보인다', () => {
    const out = text({ ...openRecords(projects), tab: 'tokens', loading: false, report });
    expect(out).toContain('한 번에 끝난 요청: 모름');
    expect(out).not.toContain('한 번에 끝난 요청 0/');
  });

  it('끝난 요청이 하나도 없으면 0/0이라 적지 않고 없다고 적는다', () => {
    const none: RecordsReport = { ...report, requestOutcomes: { total: 0, oneShot: 0, redone: 0, asked: 0, reverted: 0, gateFailedRuns: 0, gateFailures: 0, turnLimited: 0 } };
    const out = text({ ...openRecords(projects), tab: 'tokens', loading: false, report: none });
    expect(out).toContain('한 번에 끝난 요청: 끝난 요청 없음');
  });
});
