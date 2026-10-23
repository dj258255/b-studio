import { describe, expect, it } from 'vitest';
import { handleInput, initialState, type DeskState } from './keys';
import { laneTargets, openPlans, planStages, planStatus, plansHint, plansKey, plansPaste, plansScreen, type DeskPlan, type DeskPlanLane, type PlansState } from './plans';
import { stringWidth, stripAnsi } from './screen';
import type { DeskItem } from './types';

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ESC = '\x1b';

const lane = (id: string, tasks: Array<{ id: string; title: string; dependsOn?: string[] }>, patch: Partial<DeskPlanLane> = {}): DeskPlanLane => ({
  id,
  status: 'queued',
  paths: [],
  tasks: tasks.map((task) => ({ id: task.id, title: task.title, dependsOn: task.dependsOn ?? [], status: 'queued' })),
  ...patch,
});

const plan = (patch: Partial<DeskPlan> = {}): DeskPlan => ({
  id: 'p1',
  projectId: 'shop',
  request: '주문 모듈을 나눠서 고친다',
  status: 'awaiting_approval',
  createdAt: '2026-10-23T00:00:00Z',
  lanes: [
    lane('lane-1', [{ id: 'a', title: '주문 저장소' }]),
    lane('lane-2', [{ id: 'b', title: '결제 연결', dependsOn: ['a'] }]),
    lane('lane-3', [{ id: 'c', title: '문서' }]),
  ],
  ...patch,
});

const listState = (plans: DeskPlan[] = [plan(), plan({ id: 'p2', request: '로그인 고치기', status: 'done' })]): PlansState => ({ ...openPlans(), loading: false, list: plans });
const detailState = (value: DeskPlan = plan(), extra: Partial<PlansState> = {}): PlansState => ({ ...openPlans(), mode: 'detail', loading: false, detail: value, lane: 0, ...extra });

describe('작업 나누기 계획의 단계', () => {
  it('다른 레인의 작업에 기대는 레인은 다음 단계에 놓고, 기대지 않는 레인은 같은 단계에 둔다', () => {
    expect(planStages(plan()).map((stage) => stage.map((entry) => entry.id))).toEqual([['lane-1', 'lane-3'], ['lane-2']]);
  });

  it('고르는 차례는 단계 차례이고 통합이 있으면 맨 끝이다', () => {
    const value = plan({ integration: { status: 'queued', files: [], deleted: [] } });
    expect(laneTargets(value).map((target) => (target.kind === 'lane' ? target.lane.id : 'integration'))).toEqual(['lane-1', 'lane-3', 'lane-2', 'integration']);
  });

  it('돌고 있는 계획은 끝남·실행 중·승인 대기처럼 사람 말로 보인다', () => {
    expect(planStatus('done').label).toBe('끝남');
    expect(planStatus('awaiting_approval').label).toBe('승인 대기');
    expect(planStatus('running').label).toBe('실행 중');
    expect(planStatus('planning').label).toBe('계획 짜는 중');
    expect(planStatus('interrupted').label).toBe('멈춤');
  });
});

describe('계획 목록의 키', () => {
  it('↑↓로 고르고 Enter로 그 계획을 연다', () => {
    const moved = plansKey(listState(), DOWN).state!;
    expect(moved.row).toBe(1);
    const opened = plansKey(moved, '\r');
    expect(opened.state?.mode).toBe('detail');
    expect(opened.effects).toEqual([{ type: 'detail', id: 'p2' }]);
    expect(plansKey(moved, UP).state!.row).toBe(0);
  });

  it('n은 새 계획을 시작하고 프로젝트를 묻는다', () => {
    const result = plansKey(listState(), 'n');
    expect(result.state?.mode).toBe('new');
    expect(result.effects).toEqual([{ type: 'projects' }]);
  });

  it('d는 한 번 묻고 y로 지운다. 다른 키면 그만둔다', () => {
    const asked = plansKey(listState(), 'd').state!;
    expect(asked.confirm).toEqual({ kind: 'delete', planId: 'p1', title: '주문 모듈을 나눠서 고친다' });
    expect(plansKey(asked, 'y').effects).toEqual([{ type: 'delete', id: 'p1' }]);
    const kept = plansKey(asked, 'n');
    expect(kept.effects).toEqual([]);
    expect(kept.state?.confirm).toBeUndefined();
  });

  it('r은 다시 읽고 Esc는 화면을 닫는다', () => {
    expect(plansKey(listState(), 'r').effects).toEqual([{ type: 'list' }]);
    const closed = plansKey(listState(), ESC);
    expect(closed.state).toBeUndefined();
    expect(closed.effects).toEqual([{ type: 'close' }]);
  });
});

describe('새 계획', () => {
  const form = (): PlansState => ({ ...openPlans(), mode: 'new', loading: false, form: { step: 'project', projects: [{ id: 'shop', name: 'shop' }, { id: 'blog', name: 'blog' }], projectIndex: 0, text: '' } });

  it('프로젝트를 고른 뒤 요청을 쓰고 Enter로 만든다(한글과 지우기)', () => {
    let state = plansKey(form(), DOWN).state!;
    state = plansKey(state, '\r').state!;
    expect(state.form?.step).toBe('request');
    for (const char of '문서 정리해') state = plansKey(state, char).state!;
    state = plansKey(state, '\x7f').state!;
    expect(state.form?.text).toBe('문서 정리');
    const sent = plansKey(state, '\r');
    expect(sent.effects).toEqual([{ type: 'create', projectId: 'blog', request: '문서 정리' }]);
    expect(sent.state?.form?.sending).toBe(true);
  });

  it('붙여 넣은 여러 줄은 한 줄로 들어간다', () => {
    const state = plansKey(form(), '\r').state!;
    expect(plansPaste(state, '첫 줄\n둘째 줄\x07').form?.text).toBe('첫 줄 둘째 줄');
  });

  it('빈 요청은 보내지 않고, Esc는 목록으로 돌아간다', () => {
    const state = plansKey(form(), '\r').state!;
    expect(plansKey(state, '\r').effects).toEqual([]);
    const back = plansKey(state, ESC);
    expect(back.state?.mode).toBe('list');
    expect(back.effects).toEqual([{ type: 'list' }]);
  });
});

describe('계획 보기의 키', () => {
  it('Enter는 고른 레인의 세션을 칸에 연다. 세션이 아직 없으면 알린다', () => {
    const value = plan({ status: 'running', lanes: [lane('lane-1', [{ id: 'a', title: '저장소' }], { sessionId: 's-1', status: 'running' }), lane('lane-2', [{ id: 'b', title: '문서' }])] });
    expect(plansKey(detailState(value), '\r').effects).toEqual([{ type: 'open', sessionId: 's-1' }]);
    const none = plansKey(detailState(value, { lane: 1 }), '\r');
    expect(none.effects).toEqual([]);
    expect(none.state?.note).toContain('아직');
  });

  it('승인 대기에서 b는 레인 AI·계정을 고르게 하고 Enter로 바꾼다', () => {
    const state = detailState(plan(), {
      choices: [
        { backend: '', label: '세션과 같음' },
        { backend: 'codex', label: 'Codex' },
        { backend: 'codex', accountId: 'marco', label: 'Codex · 마르코' },
      ],
    });
    const picking = plansKey(state, 'b').state!;
    expect(picking.picker?.laneId).toBe('lane-1');
    const moved = plansKey(plansKey(picking, DOWN).state!, DOWN).state!;
    const chosen = plansKey(moved, '\r');
    expect(chosen.effects).toEqual([{ type: 'lane', id: 'p1', laneId: 'lane-1', backend: 'codex', accountId: 'marco' }]);
    expect(chosen.state?.picker).toBeUndefined();
  });

  it('고를 AI 목록이 아직 없으면 받아 온다', () => {
    const result = plansKey(detailState(), 'b');
    expect(result.effects).toEqual([{ type: 'lane-choices' }]);
    expect(result.state?.picker?.laneId).toBe('lane-1');
  });

  it('승인한 뒤에는 레인 AI를 바꾸지 않는다', () => {
    const result = plansKey(detailState(plan({ status: 'running' })), 'b');
    expect(result.effects).toEqual([]);
    expect(result.state?.note).toContain('승인 대기');
  });

  it('a는 한 번 묻고 y로 승인, i로 승인하고 이슈로 올린다', () => {
    const asked = plansKey(detailState(), 'a').state!;
    expect(asked.confirm?.kind).toBe('approve');
    expect(plansKey(asked, 'y').effects).toEqual([{ type: 'approve', id: 'p1', publishIssues: false }]);
    expect(plansKey(asked, 'i').effects).toEqual([{ type: 'approve', id: 'p1', publishIssues: true }]);
  });

  it('x는 묻고 거부한다. 재시작으로 멈춘 계획은 e로 통합을 다시 시작한다', () => {
    const asked = plansKey(detailState(), 'x').state!;
    expect(plansKey(asked, 'y').effects).toEqual([{ type: 'reject', id: 'p1' }]);
    const stopped = plansKey(detailState(plan({ status: 'interrupted' })), 'e').state!;
    expect(plansKey(stopped, 'y').effects).toEqual([{ type: 'resume', id: 'p1' }]);
    expect(plansKey(detailState(), 'e').state?.note).toContain('멈춘');
  });

  it('g는 세션이 있는 레인을 최대 넷까지 칸에 나란히 연다', () => {
    const lanes = ['1', '2', '3', '4', '5'].map((n) => lane(`lane-${n}`, [{ id: n, title: n }], { sessionId: `s-${n}`, status: 'running' }));
    expect(plansKey(detailState(plan({ status: 'running', lanes })), 'g').effects).toEqual([{ type: 'grid', sessionIds: ['s-1', 's-2', 's-3', 's-4'] }]);
    expect(plansKey(detailState(), 'g').state?.note).toContain('세션');
  });

  it('o는 올린 추적 이슈를 브라우저로 연다', () => {
    const value = plan({ status: 'running', issues: { tracking: { number: 7, url: 'https://github.com/o/r/issues/7' } } });
    expect(plansKey(detailState(value), 'o').effects).toEqual([{ type: 'open-url', url: 'https://github.com/o/r/issues/7' }]);
  });

  it('Esc는 목록으로 돌아가 다시 읽는다', () => {
    const back = plansKey(detailState(), ESC);
    expect(back.state?.mode).toBe('list');
    expect(back.effects).toEqual([{ type: 'list' }]);
  });
});

describe('작업 나누기 화면 그리기', () => {
  const rect = { x: 0, y: 1, w: 100, h: 30 };
  const desk = (plans: PlansState, items: DeskItem[] = []): DeskState => ({ ...initialState(), items, plans });
  const text = (lines: string[]) => lines.map(stripAnsi).join('\n');

  it('목록은 계획마다 상태·요청·레인 수를 보이고, 줄마다 폭이 꼭 맞다', () => {
    const screen = plansScreen(desk(listState()), rect);
    const all = text(screen.lines);
    expect(all).toContain('작업 나누기');
    expect(all).toContain('승인 대기');
    expect(all).toContain('주문 모듈을 나눠서 고친다');
    expect(all).toContain('레인 3');
    expect(all).toContain('끝남');
    expect(screen.lines).toHaveLength(rect.h);
    for (const line of screen.lines) expect(stringWidth(stripAnsi(line))).toBe(rect.w);
  });

  it('계획 보기는 단계마다 레인 카드를 놓고, 레인의 AI·계정·상태·게이트·토큰과 통합을 보인다', () => {
    const value = plan({
      status: 'running',
      lanes: [
        lane('lane-1', [{ id: 'a', title: '주문 저장소' }], { sessionId: 's-1', status: 'running', backend: 'codex', accountId: 'marco', waiting: 'CLI 답을 기다리는 중' }),
        lane('lane-2', [{ id: 'b', title: '결제 연결', dependsOn: ['a'] }], { status: 'queued' }),
      ],
      integration: { status: 'queued', files: [], deleted: [] },
    });
    const items: DeskItem[] = [
      { kind: 'session', id: 's-1', title: '주문 저장소', projectName: 'shop', state: 'working', backend: 'codex', lastActivityAt: '2026-10-23T00:00:00Z', gate: { state: 'passed', checkpoints: 2 }, tokens: { inputTokens: 12000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ];
    const screen = plansScreen(desk(detailState(value, { accounts: [{ id: 'marco', name: '마르코', backend: 'codex' }] }), items), rect);
    const all = text(screen.lines);
    expect(all).toContain('1단계');
    expect(all).toContain('2단계');
    expect(all).toContain('주문 저장소');
    expect(all).toContain('Codex · 마르코');
    expect(all).toContain('CLI 답을 기다리는 중');
    expect(all).toContain('통과');
    expect(all).toContain('1.2만');
    expect(all).toContain('통합');
    for (const line of screen.lines) expect(stringWidth(stripAnsi(line))).toBe(rect.w);
  });

  it('끝난 계획은 끝남과 통합 결과(파일 수·체크포인트)를 보인다', () => {
    const value = plan({ status: 'done', lanes: [lane('lane-1', [{ id: 'a', title: '저장소' }], { status: 'done' })], integration: { status: 'done', files: ['a.ts', 'b.ts'], deleted: ['c.ts'], checkpoint: { shortSha: 'abc1234' } } });
    const all = text(plansScreen(desk(detailState(value)), rect).lines);
    expect(all).toContain('끝남');
    expect(all).toContain('파일 2');
    expect(all).toContain('지움 1');
    expect(all).toContain('abc1234');
  });

  it('승인을 묻는 중이면 그 질문이 안내 줄에 나온다', () => {
    const asked = plansKey(detailState(), 'a').state!;
    expect(plansHint(asked)).toContain('승인');
    expect(plansHint(asked)).toContain('이슈');
  });
});

describe('desk 키와 작업 나누기 화면', () => {
  it('Ctrl-b t로 열고 다시 Ctrl-b t로 닫는다', () => {
    const opened = handleInput(initialState(), '\x02t');
    expect(opened.state.plans?.mode).toBe('list');
    expect(opened.effects).toEqual([{ type: 'plans-open' }]);
    const closed = handleInput(opened.state, '\x02t');
    expect(closed.state.plans).toBeUndefined();
    expect(closed.effects).toEqual([{ type: 'plans', effect: { type: 'close' } }]);
  });

  it('열려 있으면 키는 작업 나누기 화면으로 가고 칸으로 보내지 않는다', () => {
    const base: DeskState = { ...initialState(), slots: ['s-1', undefined, undefined, undefined], plans: listState() };
    const result = handleInput(base, `${DOWN}r`);
    expect(result.state.plans?.row).toBe(1);
    expect(result.effects).toEqual([{ type: 'plans', effect: { type: 'list' } }]);
  });

  it('앞글쇠 다음 다른 화면 키(w)는 작업 나누기를 닫고 그 화면으로 간다', () => {
    const result = handleInput({ ...initialState(), plans: listState() }, '\x02w');
    expect(result.state.plans).toBeUndefined();
    expect(result.state.view).toBe('space');
    expect(result.effects).toContainEqual({ type: 'plans', effect: { type: 'close' } });
  });

  it('새 계획 요청을 쓰는 중의 앞글쇠 글자는 입력이 아니라 앞글쇠다', () => {
    const state: DeskState = { ...initialState(), plans: { ...openPlans(), mode: 'new', loading: false, form: { step: 'request', projects: [{ id: 'shop', name: 'shop' }], projectIndex: 0, text: '가' } } };
    const result = handleInput(state, '나');
    expect(result.state.plans?.form?.text).toBe('가나');
  });

  it('마우스는 작업 나누기 화면 아래로 가지 않는다', () => {
    expect(handleInput({ ...initialState(), plans: listState() }, '\x1b[<0;10;5M').effects).toEqual([]);
  });

  it('붙여넣기는 새 계획 요청에 들어간다', () => {
    const state: DeskState = { ...initialState(), slots: ['s-1', undefined, undefined, undefined], plans: { ...openPlans(), mode: 'new', loading: false, form: { step: 'request', projects: [{ id: 'shop', name: 'shop' }], projectIndex: 0, text: '' } } };
    const result = handleInput(state, '\x1b[200~붙인 글\x1b[201~');
    expect(result.state.plans?.form?.text).toBe('붙인 글');
    expect(result.effects).toEqual([]);
  });
});
