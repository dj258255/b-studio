/**
 * 문서용 터미널 작업대(desk) 사진을 찍는다. 스튜디오를 띄우지 않고, desk의 화면 함수(renderScreen)에 가짜 세션·사용량·설정을
 * 넣어 한 프레임을 그린 뒤 그 ANSI 글을 진짜 Chrome(Playwright의 chrome 채널) 안의 xterm.js로 그려 PNG로 남긴다.
 *
 * CI·pnpm test에 쓰지 않는다. 화면을 바꾼 뒤 수동으로 돌린다:
 *   pnpm docs:screenshots            # 전부
 *   ONLY=desk-space pnpm docs:screenshots
 *
 * - 모델·계정·스튜디오를 부르지 않는다. 사진 속 이름·경로·숫자는 모두 아래에 적은 가짜 값이다.
 * - 카드 그림은 desk가 직접 그린 기본 로봇만 쓴다. 사용자 그림 폴더(~/.config/b-studio/sprites)는 읽지 않는다:
 *   남의 캐릭터 그림이 사진에 들어가 저장소로 퍼지지 않게 한다.
 * - 글꼴은 같은 폴더의 fonts/terminal-mono.woff2(한글이 영문 2칸에 맞는 D2Coding 서브셋, OFL)다.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openInside } from '../../apps/cli/src/desk/inside';
import { openRecords, type RecordsStats } from '../../apps/cli/src/desk/records';
import { initialState, type DeskState } from '../../apps/cli/src/desk/keys';
import { openPin, pinId, pinLoaded, pinTitle, renderPin } from '../../apps/cli/src/desk/pinned';
import { renderScreen, type PaneView } from '../../apps/cli/src/desk/render';
import { placePanes, terminalSize } from '../../apps/cli/src/desk/screen';
import { openSettings } from '../../apps/cli/src/desk/settings';
import type { ActivityLogView, DeskItem } from '../../apps/cli/src/desk/types';
import { sessionLimits, usageAccounts } from '../../apps/cli/src/desk/usage';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const outDir = path.join(repoRoot, 'docs', 'images');
const rawDir = path.join(here, '.raw');
const font = path.join(here, 'fonts', 'terminal-mono.woff2');
const xterm = path.dirname(createRequire(import.meta.url).resolve('@xterm/xterm/package.json'));
/** 쉼표로 고른 사진만 찍는다(예: ONLY=desk-space,desk-usage). 비우면 전부 */
const ONLY = (process.env.ONLY ?? '').split(',').map((name) => name.trim()).filter(Boolean);
const BACKGROUND = '#1e1e2e';
const FOREGROUND = '#cdd6f4';

const now = Date.now();
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const fetchedAt = at(-2);

const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 });
const items: DeskItem[] = [
  {
    kind: 'session', id: 's-order', title: '주문 모듈 리팩터링', projectName: 'shop', state: 'working', backend: 'claude-code', accountId: 'acct-pio', lastActivityAt: at(0), workingSince: at(-23),
    terminal: { cli: 'up' }, gate: { state: 'passed', checkpoints: 3 }, tokens: usage(152_000, 30_000), costUsd: 1.37,
    now: { tool: 'Edit', target: 'apps/shop/order.ts', at: new Date(now - 13_000).toISOString() },
    todos: { done: 3, total: 7, current: '주문 상태 전이 테스트' },
    context: { usedPct: 41, used: 82_000, size: 200_000 },
    lastMessage: '주문 상태를 한 곳에서 바꾸게 묶었습니다. 이제 전이 테스트를 씁니다.',
    agents: [
      { id: 'main', name: 'Claude Code', kind: 'main', state: 'working', activity: 'Edit apps/shop/order.ts', tokens: usage(129_000, 25_000) },
      { id: 'sub-1', name: 'Explore', type: 'Explore', description: '주문 호출부 찾기', tool: 'Grep updateOrder', kind: 'subagent', state: 'working', activity: '파일 12개 읽음', startedAt: at(-4), lastAt: new Date(now - 5_000).toISOString(), tokens: usage(20_000, 3_000) },
      { id: 'sub-2', name: 'general-purpose', type: 'general-purpose', description: '결제 이벤트 정리', kind: 'subagent', state: 'working', startedAt: at(-11), lastAt: at(-6), tokens: usage(8_000, 1_000) },
      { id: 'sub-3', name: 'Explore', type: 'Explore', description: '상태 전이 타입 확인', tool: 'Read order-state.ts', kind: 'subagent', state: 'working', startedAt: at(-2), lastAt: new Date(now - 20_000).toISOString(), tokens: usage(6_000, 800) },
      { id: 'sub-4', name: 'test-runner', type: 'test-runner', description: '주문 단위 테스트', tool: 'Bash pnpm test order', kind: 'subagent', state: 'working', startedAt: at(-1), lastAt: new Date(now - 8_000).toISOString(), tokens: usage(3_000, 400) },
      { id: 'sub-5', name: 'Explore', type: 'Explore', description: '환불 흐름 읽기', kind: 'subagent', state: 'done', startedAt: at(-16), lastAt: at(-9), result: '환불은 payment/refund.ts 한 곳에서만 상태를 바꿉니다', tokens: usage(12_000, 2_000) },
    ],
  },
  {
    kind: 'session', id: 's-pay', title: '결제 테스트 보강', projectName: 'shop', state: 'working', backend: 'codex', accountId: 'codex', lastActivityAt: at(-1), workingSince: at(-9),
    terminal: { cli: 'up', waiting: 'permission', message: 'pnpm test 실행 허락' }, gate: { state: 'verifying', checkpoints: 1 }, tokens: usage(55_000, 9_000),
    todos: { done: 5, total: 6, current: '환불 경계값' },
    context: { usedPct: 83 },
    // 거절된 도구(#953): 권한 대기 중에도 지금 줄에 까닭이 빨강으로 보인다
    now: { tool: 'Edit', target: 'infra/prod.yaml', at: new Date(now - 40_000).toISOString(), running: false, error: '거절됨: 쓰기 범위 밖입니다' },
    agents: [{ id: 'main', name: 'Codex', kind: 'main', state: 'working', activity: 'pnpm test 실행 권한을 묻는 중', tokens: usage(55_000, 9_000) }],
  },
  { kind: 'session', id: 's-readme', title: 'README 사진 다시 찍기', projectName: 'shop', state: 'done', backend: 'claude-code', accountId: 'acct-eri', lastActivityAt: at(-48), terminal: { cli: 'down' }, gate: { state: 'passed', checkpoints: 2 }, tokens: usage(36_000, 5_000), lastMessage: '사진 네 장을 다시 찍어 docs/images에 넣었습니다.', agents: [{ id: 'main', name: 'Claude Code', kind: 'main', state: 'idle', tokens: usage(30_000, 4_000) }, { id: 'sub-r1', name: 'Explore', type: 'Explore', description: '문서의 옛 사진 이름 찾기', kind: 'subagent', state: 'done', startedAt: at(-60), lastAt: at(-58), result: 'README와 getting-started에 네 곳', tokens: usage(5_000, 700) }] },
  { kind: 'session', id: 's-login', title: '로그인 오류 고치기', projectName: 'shop', state: 'idle', backend: 'codex', accountId: 'codex', lastActivityAt: at(-7), terminal: { cli: 'up' }, gate: { state: 'failed', checkpoints: 2 }, reason: '로그인 API 계약 테스트 2개 실패', tokens: usage(20_000, 3_000) },
  { kind: 'session', id: 's-blog', title: '글 목록 페이지', projectName: 'blog', state: 'stopped', backend: 'claude-code', lastActivityAt: at(-300) },
];

/** 에이전트 안(#1411) 사진용 활동 기록(가짜). 에이전트마다 다른 코드 조각을 둔다 */
const tAt = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const activity: ActivityLogView = {
  agents: [
    {
      id: 'main',
      main: true,
      entries: [
        { at: tAt(60), endedAt: tAt(58), tool: 'Read', kind: 'read', state: 'done', target: 'apps/shop/order.ts' },
        {
          at: tAt(14),
          endedAt: tAt(13),
          tool: 'Edit',
          kind: 'edit',
          state: 'done',
          target: 'apps/shop/order.ts',
          changes: [{ file: 'apps/shop/order.ts', removed: 'export function createOrder(input) {\n  return repo.save(input);', added: 'export class OrderService {\n  constructor(private readonly repo: OrderRepo) {}' }],
        },
      ],
    },
    { id: 'sub-1', type: 'Explore', description: '주문 호출부 찾기', state: 'working', entries: [{ at: tAt(40), endedAt: tAt(39), tool: 'Grep', kind: 'search', state: 'done', target: 'updateOrder' }, { at: tAt(20), endedAt: tAt(19), tool: 'Read', kind: 'read', state: 'done', target: 'apps/shop/cart.ts' }, { at: tAt(6), tool: 'Read', kind: 'read', state: 'running', target: 'apps/shop/checkout.ts' }] },
    {
      id: 'sub-2',
      type: 'general-purpose',
      description: '결제 이벤트 정리',
      state: 'working',
      entries: [
        {
          at: tAt(420),
          endedAt: tAt(418),
          tool: 'Edit',
          kind: 'edit',
          state: 'done',
          target: 'apps/shop/payment/events.ts',
          changes: [{ file: 'apps/shop/payment/events.ts', removed: "export const PAID = 'paid';\nexport const FAIL = 'fail';", added: "export const PAYMENT_PAID = 'payment.paid';\nexport const PAYMENT_FAILED = 'payment.failed';" }],
        },
      ],
    },
    {
      id: 'sub-3',
      type: 'Explore',
      description: '상태 전이 타입 확인',
      state: 'working',
      entries: [
        {
          at: tAt(30),
          endedAt: tAt(29),
          tool: 'Write',
          kind: 'write',
          state: 'done',
          target: 'apps/shop/order-state.ts',
          changes: [{ file: 'apps/shop/order-state.ts', added: "export type OrderState = 'created' | 'paid' | 'shipped';\nexport const NEXT: Record<OrderState, OrderState[]> = {\n  created: ['paid'],\n  paid: ['shipped'],\n  shipped: [],\n};", truncated: true }],
        },
      ],
    },
    { id: 'sub-4', type: 'test-runner', description: '주문 단위 테스트', state: 'working', entries: [{ at: tAt(50), endedAt: tAt(20), tool: 'Bash', kind: 'run', state: 'failed', command: 'pnpm test order', output: ' ✓ order-create.test.ts (4)\n ✗ order-state.test.ts (2)\n   AssertionError: expected shipped to equal paid\n Tests  1 failed | 4 passed', error: '종료 코드 1' }] },
    { id: 'sub-5', type: 'Explore', description: '환불 흐름 읽기', state: 'done', entries: [{ at: tAt(900), endedAt: tAt(899), tool: 'Write', kind: 'write', state: 'done', target: '.env.local', withheld: 'secret', changes: [{ file: '.env.local' }] }] },
  ],
};

/** 깊이 2·칸 고정 사진용: sub-4(테스트 실행)의 기록을 더 길게 둔 활동 기록 */
const testerActivity: ActivityLogView = {
  agents: [
    ...activity.agents.filter((agent) => agent.id !== 'sub-4'),
    {
      id: 'sub-4',
      type: 'test-runner',
      description: '주문 단위 테스트',
      state: 'working',
      entries: [
        { at: tAt(160), endedAt: tAt(158), tool: 'Read', kind: 'read', state: 'done', target: 'apps/shop/order.test.ts' },
        { at: tAt(120), endedAt: tAt(119), tool: 'Edit', kind: 'edit', state: 'done', target: 'apps/shop/order.test.ts', changes: [{ file: 'apps/shop/order.test.ts', removed: "expect(next('paid')).toBe('paid');", added: "expect(next('paid')).toBe('shipped');" }] },
        { at: tAt(90), endedAt: tAt(60), tool: 'Bash', kind: 'run', state: 'done', command: 'pnpm test order', output: ' ✓ order-create.test.ts (4)\n ✗ order-state.test.ts (2)\n   AssertionError: expected paid to equal shipped\n Tests  1 failed | 4 passed' },
        { at: tAt(50), tool: 'Write', kind: 'write', state: 'denied', target: 'infra/prod.yaml', error: '쓰기 범위 밖입니다' },
        { at: tAt(20), tool: 'Bash', kind: 'run', state: 'running', command: 'pnpm test order' },
      ],
    },
  ],
};

const claude = (id: string, name: string, status: string, five: number | undefined, week: number | undefined, extra: Record<string, unknown> = {}) => ({
  id,
  backend: 'claude-code',
  name,
  plan: 'Max 20x',
  status,
  source: 'claude-oauth',
  fetchedAt,
  windows: [
    ...(five === undefined ? [] : [{ kind: 'five_hour', usedPercent: five, resetsAt: at(five ? 110 : 300) }]),
    ...(week === undefined ? [] : [{ kind: 'weekly', usedPercent: week, resetsAt: at(3 * 1440 + 200) }]),
  ],
  ...extra,
});
const accounts = [
  { id: 'codex', backend: 'codex', name: '마르코', plan: 'Pro', status: 'ok', source: 'codex-app-server', fetchedAt, windows: [{ kind: 'five_hour', usedPercent: 12, resetsAt: at(250) }, { kind: 'weekly', usedPercent: 26, resetsAt: at(4 * 1440) }] },
  claude('acct-pio', '피오', 'warn', 37, 90),
  claude('acct-eri', '에리', 'exhausted', 0, 100),
  claude('acct-trevor', '트레버', 'ok', 28, 18, { recommended: true }),
  claude('acct-clark', '클락', 'idle', 0, 0),
  { id: 'gemini', backend: 'gemini', name: '타마', status: 'unsupported', source: 'none', windows: [] },
];

/** 오늘·7일 쓴 양(가짜). Codex 비용은 단가 표로 낸 추정이라고 표시한다 */
const spend = {
  today: {
    tokens: 1_840_000,
    costUsd: 9.42,
    estimated: true,
    missingPrice: false,
    rows: [
      { backend: 'claude-code', model: 'claude-opus-5-5', tokens: 1_120_000, calls: 41, costUsd: 7.8, estimated: false },
      { backend: 'codex', model: 'gpt-5.5', tokens: 610_000, calls: 22, costUsd: 1.37, estimated: true },
      { backend: 'claude-code', model: 'claude-haiku-5-5', tokens: 110_000, calls: 18, costUsd: 0.25, estimated: false },
    ],
  },
  week: {
    tokens: 9_300_000,
    costUsd: 48.1,
    estimated: true,
    missingPrice: false,
    rows: [
      { backend: 'claude-code', model: 'claude-opus-5-5', tokens: 6_400_000, calls: 230, costUsd: 39.2, estimated: false },
      { backend: 'codex', model: 'gpt-5.5', tokens: 2_900_000, calls: 120, costUsd: 8.9, estimated: true },
    ],
  },
};

const base = (): DeskState =>
  ({ ...initialState(), items, theme: { name: 'dark', depth: 'truecolor' }, sprites: {}, spriteClock: 0, usage: { accounts: usageAccounts(accounts as never), receivedAt: now, spend }, limits: sessionLimits(items, accounts) }) as unknown as DeskState;

/** 칸 화면에 넣을 가짜 CLI 출력. 실제 CLI 화면을 흉내만 낸다 */
const green = (text: string) => `\x1b[32m${text}\x1b[39m`;
const red = (text: string) => `\x1b[31m${text}\x1b[39m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[39m`;
const claudePane: PaneView = {
  lines: [
    `${yellow('✻')} Claude Code`,
    '',
    dim('> 주문 모듈을 서비스 계층으로 나눠 줘'),
    '',
    '● 주문 모듈을 살펴보겠습니다.',
    '',
    `${green('●')} Read(apps/shop/order.ts)`,
    '  └ 248줄 읽음',
    '',
    `${green('●')} Edit(apps/shop/order.ts)`,
    `  └ ${green('+ export class OrderService {')}`,
    `    ${green('+   constructor(private readonly repo: OrderRepo) {}')}`,
    `    ${red('- export function createOrder(input) {')}`,
    '',
    `${yellow('✶')} 테스트를 돌리는 중… ${dim('(esc로 멈춤)')}`,
  ],
};
const codexPane: PaneView = {
  lines: [
    '>_ Codex',
    '',
    dim('› 결제 실패 경로의 테스트를 보강해 줘'),
    '',
    '• 결제 모듈 테스트 파일을 찾았습니다.',
    '',
    yellow('▌ pnpm test payment 를 실행할까요?'),
    yellow('▌  1. 예   2. 이번 세션 동안 예   3. 아니오'),
  ],
};

/** 기록 화면 사진용 가짜 결과표. 모델 이름·숫자는 모두 사진용 값이다 */
const recordsStats: RecordsStats = {
  rows: [],
  excluded: { asks: 3, unfinished: 1 },
  byAccount: [
    { backend: 'claude-code', accountId: 'acct-pio', runs: 12, passed: 10, failed: 1, errors: 1, passRate: 10 / 12, averageTokens: 123_000, averageCostUsd: 0.41 },
    { backend: 'codex', accountId: 'codex', runs: 5, passed: 3, failed: 2, errors: 0, passRate: 3 / 5, averageTokens: 48_000 },
  ],
  byModel: [
    { backend: 'claude-code', model: 'claude-sonnet-5', runs: 8, oneShot: 5, passed: 7, failed: 1, reverted: 1, judged: 8, retries: 6, averageRetries: 0.75 },
    { backend: 'claude-code', model: 'claude-opus-5', runs: 4, oneShot: 4, passed: 4, failed: 0, reverted: 0, judged: 4, retries: 0, averageRetries: 0 },
    { backend: 'codex', model: '(모름)', runs: 5, oneShot: 2, passed: 3, failed: 2, reverted: 1, judged: 5, retries: 4, averageRetries: 0.8 },
  ],
  recentFailures: [{ sessionId: 's-login', backend: 'codex', accountId: 'codex', request: '로그인 API 계약 테스트 고치기', at: at(-70), outcome: 'failed' }],
};

interface Shot {
  name: string;
  cols: number;
  rows: number;
  state: () => DeskState;
  panes?: PaneView[] | ((state: DeskState, size: { cols: number; rows: number }) => PaneView[]);
}

/** 칸에 고정한 상태: 1번 칸 터미널, 2번·4번 칸에 서브에이전트 활동 기록, 3번 칸에 다른 세션 터미널 */
function pinnedState(): DeskState {
  const tester = pinId('s-order', 'sub-4');
  const events = pinId('s-order', 'sub-2');
  return {
    ...base(),
    layout: 4,
    slots: ['s-order', tester, 's-pay', events],
    focus: 0,
    pins: { [tester]: pinLoaded(openPin('s-order', 'sub-4'), testerActivity), [events]: pinLoaded(openPin('s-order', 'sub-2'), testerActivity) },
  } as DeskState;
}

const shots: Shot[] = [
  { name: 'desk-space', cols: 160, rows: 34, state: () => ({ ...base(), view: 'space' }) as DeskState },
  {
    name: 'desk-panes',
    cols: 160,
    rows: 30,
    state: () => ({ ...base(), layout: 2, slots: ['s-order', 's-pay', undefined, undefined], focus: 0 }) as DeskState,
    panes: [claudePane, codexPane],
  },
  // 에이전트 나무 목록: 세션마다 부모 줄, 서브에이전트마다 자식 줄(작업 중·소식 없음·끝남이 섞인다)
  { name: 'desk-agents', cols: 160, rows: 30, state: () => ({ ...base(), tree: { index: 2, session: 's-order', agent: 'sub-2', all: false } }) as DeskState },
  // 에이전트 안 깊이 1(#1411): 메인과 서브에이전트마다 카드, 각자 다른 코드 조각. 비밀 파일은 내용을 보이지 않는다
  { name: 'desk-inside', cols: 160, rows: 34, state: () => ({ ...base(), inside: { ...openInside('s-order', '주문 모듈 리팩터링'), agent: 'sub-2', cursor: 2, data: activity, loading: false } }) as DeskState },
  // 깊이 2: 서브에이전트 하나의 활동 기록(시각·도구·대상·상태·걸린 시간, diff, 명령과 결과)
  {
    name: 'desk-activity',
    cols: 160,
    rows: 30,
    state: () => ({ ...base(), inside: { ...openInside('s-order', '주문 모듈 리팩터링', { depth: 2, agent: 'sub-4' }), data: testerActivity, loading: false } }) as DeskState,
  },
  // 칸에 고정(#1411): 왼쪽 칸은 세션 터미널, 오른쪽 칸 둘은 서브에이전트의 활동 기록. 사이드바에는 서브에이전트가 펼쳐진다
  {
    name: 'desk-pinned',
    cols: 160,
    rows: 34,
    state: () => pinnedState(),
    panes: (state, size) =>
      state.slots.map((id, slot) => {
        if (id === 's-order') return claudePane;
        if (id === 's-pay') return codexPane;
        const rect = placePanes(size.cols, size.rows, state).panes.find((entry) => entry.slot === slot)?.rect;
        return id && rect ? { lines: renderPin(state, id, terminalSize(rect), now), title: pinTitle(state, id) } : { lines: [] };
      }),
  },
  // 기록 화면(#891, #1439): AI별 결과 탭의 계정별 표 아래에 모델별 표가 있다. 모델을 알리지 않은 CLI는 (모름)이다
  {
    name: 'desk-records',
    cols: 140,
    rows: 34,
    state: () => ({ ...base(), records: { ...openRecords([{ id: 'p-shop', name: 'shop' }], 'shop'), loading: false, stats: recordsStats, names: { 'acct-pio': '피오', 'acct-eri': '에리', codex: '마르코' } } }) as unknown as DeskState,
  },
  { name: 'desk-usage', cols: 140, rows: 34, state: () => ({ ...base(), view: 'usage', usageSelected: 1 }) as unknown as DeskState },
  {
    name: 'desk-settings',
    cols: 140,
    rows: 32,
    state: () =>
      ({
        ...base(),
        settings: {
          ...openSettings({ config: { theme: 'dark' }, sprites: [] } as never),
          loading: false,
          backends: ['claude-code', 'codex'],
          defaultBackend: 'claude-code',
          row: 1,
          accounts: [
            { id: 'claude-code', name: '트레버', backend: 'claude-code', status: { connected: true, installed: true, accountKind: 'Max 구독' } },
            { id: 'acct-pio', name: '피오', backend: 'claude-code', configDir: '~/.b-studio/accounts/claude-code-1', status: { connected: true, installed: true, accountKind: 'Max 구독' } },
            { id: 'acct-eri', name: '에리', backend: 'claude-code', configDir: '~/.b-studio/accounts/claude-code-2', status: { connected: false, installed: true, reason: '로그인이 필요합니다. l로 로그인합니다' } },
            { id: 'codex', name: '마르코', backend: 'codex', status: { connected: true, installed: true, accountKind: 'ChatGPT Pro' } },
          ],
          rules: { rules: [{ when: { complexity: ['complex'] }, backend: 'claude-code', accountId: 'acct-pio' }, { when: { keywords: ['테스트'] }, backend: 'codex' }], fallback: { backend: 'claude-code' } },
        },
      }) as unknown as DeskState,
  },
];

async function main(): Promise<void> {
  mkdirSync(rawDir, { recursive: true });
  const chosen = shots.filter((shot) => ONLY.length === 0 || ONLY.includes(shot.name));
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const shot of chosen) {
      const state = shot.state();
      const size = { cols: shot.cols, rows: shot.rows };
      const frame = renderScreen(state, size, typeof shot.panes === 'function' ? shot.panes(state, size) : (shot.panes ?? []));
      const text = frame.lines.join('\r\n');
      const html = [
        '<!doctype html><meta charset="utf-8">',
        `<link rel="stylesheet" href="file://${xterm}/css/xterm.css">`,
        `<style>@font-face{font-family:Mono;src:url(file://${font})}body{margin:0;background:${BACKGROUND};padding:14px}#t{display:inline-block}</style>`,
        '<div id="t"></div>',
        `<script src="file://${xterm}/lib/xterm.js"></script>`,
      ].join('\n');
      const htmlFile = path.join(rawDir, `${shot.name}.html`);
      writeFileSync(htmlFile, html);
      const context = await browser.newContext({ viewport: { width: 1700, height: 1100 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      await page.goto(`file://${htmlFile}`);
      await page.evaluate(() => document.fonts.load('15px Mono'));
      await page.evaluate(
        async ({ text, cols, rows, background, foreground }) => {
          const Terminal = (window as unknown as { Terminal: new (options: object) => { open(el: HTMLElement): void; write(data: string, done: () => void): void } }).Terminal;
          const term = new Terminal({ cols, rows, fontFamily: 'Mono, monospace', fontSize: 15, lineHeight: 1, allowProposedApi: true, theme: { background, foreground } });
          term.open(document.getElementById('t')!);
          await new Promise<void>((resolve) => term.write(text, resolve));
        },
        { text, cols: shot.cols, rows: shot.rows, background: BACKGROUND, foreground: FOREGROUND },
      );
      await page.waitForTimeout(300);
      const out = path.join(outDir, `${shot.name}.png`);
      await page.locator('#t').screenshot({ path: out });
      await context.close();
      console.log(`${path.relative(repoRoot, out)} (${Math.round(readFileSync(out).length / 1024)}KB)`);
    }
  } finally {
    await browser.close();
  }
}

await main();
