/**
 * 스크립트 제어 명령의 몸. 모두 스튜디오 API를 부르기만 한다: 게이트·권한·소유자 검사는 서버가 하고, 새 판정은 여기에 없다.
 * 터미널 입력은 desk가 쓰는 같은 입력 길(StudioClient.input → POST /api/sessions/:id/terminal)로 보낸다
 */
import { StudioRequestError, type StudioClient } from '../desk/client';
import { cleanText } from '../desk/screen';
import type { DeskItem } from '../desk/types';
import { CtlError } from './connect';
import { keyBytes, KEY_HELP } from './keys';
import { EXIT, gateOf, GATE_LABEL, judgeWait, matchSession, PHASE_LABEL, phaseOf, type Phase, type WaitTarget } from './phase';
import { pickLines, readScreen } from './screen-read';
import { watchSessions, type WatchOptions } from './watch';

export interface Timing {
  /** send: 글을 붙여 넣고 Enter를 보내기 전 간격(CLI가 붙여넣기를 다 받게) */
  enterGapMs: number;
  /** send: 상태가 바뀌었는지 보는 간격과, Enter 한 번당 기다리는 상한 */
  confirmPollMs: number;
  confirmMs: number;
  /** wait: 쉬는 상태가 이만큼 그대로일 때 확정한다 */
  settleMs: number;
  /** keys: 키 사이 간격 */
  keyGapMs: number;
  /** read */
  readSettleMs: number;
  watch: WatchOptions;
}

export const DEFAULT_TIMING: Timing = { enterGapMs: 150, confirmPollMs: 250, confirmMs: 5_000, settleMs: 1_500, keyGapMs: 80, readSettleMs: 200, watch: {} };

export interface Ctx {
  client: StudioClient;
  json: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  timing: Timing;
  /** events가 끝나는 신호(SIGINT 등) */
  signal?: AbortSignal;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function emitJson(ctx: Ctx, value: unknown): void {
  ctx.out(JSON.stringify(value));
}

/** 사람에게 보이는 글에서 제어 문자를 지운다(세션 제목·메시지는 AI가 쓴 글이다) */
const clean = (text: string | undefined): string => cleanText(text ?? '').replace(/\s+/g, ' ').trim();

async function sessionsOf(ctx: Ctx): Promise<DeskItem[]> {
  return (await ctx.client.agents()).items;
}

async function findSession(ctx: Ctx, ref: string): Promise<DeskItem> {
  const found = matchSession(await sessionsOf(ctx), ref);
  if ('error' in found) throw new CtlError(found.error, EXIT.notFound);
  return found.item;
}

function ago(iso: string | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '-';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86_400)}일 전`;
}

/** 목록·상태에 싣는 세션 요약(--json의 한 항목과 같은 꼴) */
export function summaryOf(item: DeskItem): Record<string, unknown> {
  const phase = phaseOf(item);
  return {
    id: item.id,
    title: item.title,
    project: item.projectName,
    ...(item.backend ? { backend: item.backend } : {}),
    ...(item.model ? { model: item.model } : {}),
    state: item.state,
    phase,
    ...(item.terminal ? { cli: item.terminal.cli } : {}),
    ...(item.terminal?.waiting ? { waiting: item.terminal.waiting } : {}),
    gate: gateOf(item),
    ...(item.attention ? { attention: item.attention } : {}),
    lastActivityAt: item.lastActivityAt,
  };
}

// ─── ls ───

export async function ls(ctx: Ctx, options: { project?: string }): Promise<number> {
  let items = (await sessionsOf(ctx)).filter((item) => item.kind === 'session' && !item.id.startsWith('plan:'));
  if (options.project) {
    const wanted = options.project;
    // 프로젝트는 id나 이름으로 줄 수 있다. 목록을 읽지 못해도 이름으로는 거른다
    const projects = await ctx.client.projects().catch(() => []);
    const names = new Set([wanted, ...projects.filter((project) => project.id === wanted).map((project) => project.name)]);
    items = items.filter((item) => names.has(item.projectName));
  }
  if (ctx.json) {
    emitJson(ctx, items.map(summaryOf));
    return EXIT.ok;
  }
  if (items.length === 0) {
    ctx.err('세션이 없습니다');
    return EXIT.ok;
  }
  for (const item of items) {
    const gate = gateOf(item);
    ctx.out([item.id, PHASE_LABEL[phaseOf(item)], gate === 'none' ? '-' : `게이트 ${GATE_LABEL[gate]}`, item.projectName, item.backend ?? '-', clean(item.title) || '(제목 없음)', ago(item.lastActivityAt)].join('\t'));
  }
  return EXIT.ok;
}

// ─── new ───

export async function newSession(ctx: Ctx, options: { project: string; request: string; backend?: string; account?: string; model?: string }): Promise<number> {
  const projects = await ctx.client.projects();
  const byId = projects.find((project) => project.id === options.project);
  const byName = projects.filter((project) => project.name === options.project);
  const project = byId ?? (byName.length === 1 ? byName[0] : undefined);
  if (!project) {
    const reason = byName.length > 1 ? `프로젝트 이름 ${options.project}이(가) 여럿입니다. id로 주세요` : `프로젝트 ${options.project}을(를) 찾을 수 없습니다`;
    throw new CtlError(`${reason}${projects.length ? ` (있는 프로젝트: ${projects.map((entry) => `${entry.id}(${entry.name})`).join(', ')})` : ''}`, EXIT.notFound);
  }
  if (project.error) throw new CtlError(`프로젝트 ${project.name}을(를) 쓸 수 없습니다: ${project.error}`, EXIT.failed);
  if ((options.account || options.model) && !options.backend) throw new CtlError('--account·--model은 --backend와 함께 줍니다(규칙으로 고를 때는 스튜디오가 AI·모델을 정합니다)', EXIT.usage);
  const choice = options.backend ? (options.account ? `${options.backend}@${options.account}` : options.backend) : 'rules';
  const result = await ctx.client.start({ projectId: project.id, request: options.request, choice, ...(options.model ? { model: options.model } : {}) });
  const id = result.session.id;
  const routing = result.routing;
  // 요청을 CLI 실행 인자로 넘겼는데 CLI가 시작 창(폴더 신뢰 등)에서 기다리면, 세션은 정상이고 사람이 답할 차례다
  const waitingForDialog = result.terminal?.pasted === true && result.terminal.pasteError !== undefined;
  const notDelivered = result.sendError !== undefined || (result.terminal !== undefined && !result.terminal.pasted);
  const problem = result.sendError ?? (notDelivered ? result.terminal?.pasteError : undefined);
  const note = waitingForDialog ? result.terminal?.pasteError : undefined;
  if (ctx.json) {
    emitJson(ctx, {
      ok: !notDelivered,
      id,
      ...(routing ? { backend: routing.backend, ...(routing.model ? { model: routing.model } : {}), ...(routing.matched ? { matched: routing.matched } : {}) } : {}),
      ...(result.terminal ? { terminal: result.terminal } : {}),
      ...(problem ? { error: problem } : {}),
      ...(note ? { warning: note } : {}),
    });
  } else {
    ctx.out(id);
    if (routing?.backend) ctx.err(`AI: ${routing.backend}${routing.model ? ` (${routing.model})` : ''}${routing.matched ? ` · ${routing.matched}` : ''}`);
    if (problem) ctx.err(`세션은 만들었지만 첫 요청을 CLI에 넣지 못했습니다: ${problem}`);
    if (note) ctx.err(note);
  }
  return notDelivered ? EXIT.failed : EXIT.ok;
}

// ─── send·keys ───

/** 터미널에 글이나 키를 보내도 되는 세션인가. 안 되면 까닭과 함께 던진다 */
function assertTypable(item: DeskItem, what: 'text' | 'keys'): void {
  const phase = phaseOf(item);
  if (phase === 'done') throw new CtlError('세션이 끝났습니다(멈춘 세션에는 보낼 수 없습니다)', EXIT.ended);
  // CLI가 아니라 셸이 떠 있으면 글이 명령으로 실행된다. 모르면 보내지 않는다(서버가 붙여 넣기 전에 CLI를 확인하는 것과 같은 이유)
  if (item.terminal?.cli !== 'up') throw new CtlError('이 세션의 터미널에 CLI가 떠 있지 않습니다. 글이나 키가 셸에 들어가 명령으로 실행될 수 있어 보내지 않습니다', EXIT.failed);
  if (what === 'text') {
    // 권한·질문 창에서 글 뒤의 Enter는 그 창의 기본 선택이 된다. 사람(또는 keys를 부르는 스크립트)이 고르게 한다
    if (phase === 'permission') throw new CtlError('권한 확인 창이 떠 있습니다. 글 대신 studio keys로 답하세요(예: studio keys <세션> 1)', EXIT.permission);
    if (phase === 'question' || phase === 'input') throw new CtlError('CLI가 질문이나 입력 요구로 기다립니다. 글 대신 studio keys로 답하거나 studio read로 화면을 보세요', EXIT.input);
  }
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** 붙여 넣을 글. 붙여넣기 표지와 제어 글자(ESC 등)는 지운다 — 글 안의 표지가 붙여넣기를 일찍 끝내거나 키 입력이 되지 못하게 */
export function pasteText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(PASTE_END)
    .join('')
    .split(PASTE_START)
    .join('')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

interface Mark {
  phase: Phase;
  workingSince?: string;
  lastActivityAt: string;
}

function markOf(item: DeskItem): Mark {
  return { phase: phaseOf(item), ...(item.workingSince ? { workingSince: item.workingSince } : {}), lastActivityAt: item.lastActivityAt };
}

/**
 * 보낸 글을 CLI가 받았는가(Enter가 먹었는가). 받았다면 스튜디오의 상태에 흔적이 남는다: 작업이 시작되거나(workingSince가 새로 찍힘),
 * 마지막 활동 시각이 앞서거나, 권한·질문 창으로 넘어갔다. 이미 작업 중이었다면 "작업 중"은 증거가 아니라서 앞의 두 가지만 본다
 */
export function reacted(before: Mark, now: DeskItem): boolean {
  const phase = phaseOf(now);
  if (phase === 'done' || phase === 'error') return true;
  if (before.phase !== 'working' && (phase === 'working' || phase === 'permission' || phase === 'question' || phase === 'input')) return true;
  if (now.workingSince && now.workingSince !== before.workingSince) return true;
  return Date.parse(now.lastActivityAt) > Date.parse(before.lastActivityAt);
}

async function confirmSubmitted(ctx: Ctx, id: string, before: Mark): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const now = matchSession(await sessionsOf(ctx), id);
    if ('item' in now && reacted(before, now.item)) return true;
    if (Date.now() - started >= ctx.timing.confirmMs) return false;
    await sleep(ctx.timing.confirmPollMs);
  }
}

export async function send(ctx: Ctx, ref: string, rawText: string): Promise<number> {
  const text = pasteText(rawText);
  if (!text.trim()) throw new CtlError('보낼 글이 비어 있습니다', EXIT.usage);
  const item = await findSession(ctx, ref);
  assertTypable(item, 'text');
  const before = markOf(item);
  // 서버가 CLI에 요청을 넣을 때와 같다: 붙여넣기 표지로 감싼 글, 그리고 따로 Enter
  await ctx.client.input(item.id, `${PASTE_START}${text}${PASTE_END}`);
  await sleep(ctx.timing.enterGapMs);
  await ctx.client.input(item.id, '\r');
  let retried = false;
  let confirmed = await confirmSubmitted(ctx, item.id, before);
  if (!confirmed) {
    // Enter가 먹지 않는 일이 있다(붙여넣기 직후 등). 한 번만 더 보낸다 — 빈 입력줄의 Enter는 CLI가 무시한다
    retried = true;
    await ctx.client.input(item.id, '\r');
    confirmed = await confirmSubmitted(ctx, item.id, before);
  }
  if (!confirmed) {
    const screen = await readScreen(ctx.client, item.id, { settleMs: ctx.timing.readSettleMs }).catch(() => undefined);
    const tail = screen ? pickLines(screen, { lines: 8 }) : [];
    const message = 'Enter를 두 번 보냈지만 CLI가 요청을 받았다는 흔적(작업 시작·활동 시각 갱신)이 없습니다. studio read로 입력줄을 확인하세요';
    if (ctx.json) emitJson(ctx, { ok: false, session: item.id, confirmed: false, retried: true, error: message, screen: tail });
    else {
      ctx.err(message);
      for (const line of tail) ctx.err(`  | ${line}`);
    }
    return EXIT.unconfirmed;
  }
  if (ctx.json) emitJson(ctx, { ok: true, session: item.id, confirmed: true, retried });
  else ctx.err(retried ? '보냈습니다(Enter를 한 번 더 보냈습니다)' : '보냈습니다');
  return EXIT.ok;
}

export async function keys(ctx: Ctx, ref: string, names: readonly string[]): Promise<number> {
  const bytes: string[] = [];
  for (const name of names) {
    const value = keyBytes(name);
    if (value === undefined) throw new CtlError(`모르는 키 이름: ${name} (쓸 수 있는 것: ${KEY_HELP})`, EXIT.usage);
    bytes.push(value);
  }
  if (bytes.length === 0) throw new CtlError('보낼 키가 없습니다', EXIT.usage);
  const item = await findSession(ctx, ref);
  assertTypable(item, 'keys');
  for (let at = 0; at < bytes.length; at++) {
    if (at > 0) await sleep(ctx.timing.keyGapMs);
    await ctx.client.input(item.id, bytes[at]!);
  }
  if (ctx.json) emitJson(ctx, { ok: true, session: item.id, keys: names });
  return EXIT.ok;
}

// ─── wait ───

export interface WaitResult {
  code: number;
  reason: string;
  item?: DeskItem;
  waitedMs: number;
}

export async function waitFor(ctx: Ctx, ref: string, target: WaitTarget, timeoutMs: number | undefined): Promise<WaitResult> {
  const first = await findSession(ctx, ref);
  const id = first.id;
  const started = Date.now();
  const controller = new AbortController();
  let last: DeskItem | undefined = first;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleKey = '';

  return new Promise<WaitResult>((resolve, reject) => {
    let finished = false;
    const finish = (result: Omit<WaitResult, 'waitedMs'>): void => {
      if (finished) return;
      finished = true;
      clearTimeout(settleTimer);
      clearTimeout(deadline);
      controller.abort();
      resolve({ ...result, waitedMs: Date.now() - started });
    };
    const deadline = timeoutMs === undefined ? undefined : setTimeout(() => finish({ code: EXIT.timeout, reason: `${Math.round(timeoutMs / 1000)}초 안에 조건이 되지 않았습니다`, ...(last ? { item: last } : {}) }), timeoutMs);
    const onItems = (items: DeskItem[]): void => {
      if (finished) return;
      const item = items.find((entry) => entry.id === id);
      if (!item) return finish({ code: EXIT.notFound, reason: '세션이 목록에서 사라졌습니다(지워졌을 수 있습니다)' });
      last = item;
      const verdict = judgeWait(item, target);
      if (!verdict) {
        clearTimeout(settleTimer);
        settleKey = '';
        return;
      }
      if (!verdict.settle) return finish({ code: verdict.code, reason: verdict.reason, item });
      // 쉬는 상태는 잠깐 그대로일 때만 확정한다(게이트가 막 시작하거나 다음 작업이 막 시작하는 사이를 건너뛰지 않게)
      const key = `${phaseOf(item)}:${gateOf(item)}:${verdict.code}`;
      if (key === settleKey) return;
      clearTimeout(settleTimer);
      settleKey = key;
      settleTimer = setTimeout(() => finish({ code: verdict.code, reason: verdict.reason, item: last ?? item }), ctx.timing.settleMs);
    };
    onItems([first]);
    watchSessions(ctx.client, onItems, controller.signal, ctx.timing.watch).catch((error: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(settleTimer);
      clearTimeout(deadline);
      controller.abort();
      reject(error);
    });
  });
}

export async function wait(ctx: Ctx, ref: string, target: WaitTarget, timeoutSeconds: number): Promise<number> {
  const result = await waitFor(ctx, ref, target, timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined);
  const item = result.item;
  const phase = item ? phaseOf(item) : undefined;
  const gate = item ? gateOf(item) : undefined;
  if (ctx.json) {
    emitJson(ctx, { ok: result.code === EXIT.ok, code: result.code, reason: result.reason, session: item?.id ?? ref, ...(phase ? { phase } : {}), ...(gate ? { gate } : {}), waitedMs: result.waitedMs });
  } else {
    ctx.out(`${result.reason}${phase ? ` · ${PHASE_LABEL[phase]}` : ''}${gate && gate !== 'none' ? ` · 게이트 ${GATE_LABEL[gate]}` : ''}`);
  }
  return result.code;
}

// ─── read ───

export async function read(ctx: Ctx, ref: string, options: { lines?: number; raw: boolean }): Promise<number> {
  const item = await findSession(ctx, ref);
  const screen = await readScreen(ctx.client, item.id, { settleMs: ctx.timing.readSettleMs });
  if (!screen.open && screen.lines.length === 0) {
    throw new CtlError(screen.closedReason ?? '이 세션의 터미널이 열려 있지 않습니다', EXIT.failed);
  }
  const lines = pickLines(screen, options);
  if (ctx.json) {
    emitJson(ctx, { session: item.id, cols: screen.cols, rows: screen.rows, raw: options.raw, ...(screen.cli === undefined ? {} : { cli: screen.cli }), lines });
  } else {
    for (const line of lines) ctx.out(line);
  }
  return EXIT.ok;
}

// ─── status ───

export async function status(ctx: Ctx, ref: string): Promise<number> {
  const item = await findSession(ctx, ref);
  // 체크포인트·지금 변경은 세션 기록이 있을 때만 있다. 못 읽은 것은 "없음"이 아니라 "모름"으로 적는다
  const [detail, live] = await Promise.all([
    ctx.client.session(item.id).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    ),
    ctx.client.liveChanges(item.id).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    ),
  ]);
  const checkpoints = 'value' in detail ? detail.value.checkpoints : undefined;
  const changed = 'value' in live ? live.value.files : undefined;
  const needs: string[] = [];
  if (item.attention) needs.push(`${item.attention}${item.reason ? `: ${clean(item.reason)}` : ''}`);
  if (item.terminal?.waiting && item.terminal.waiting !== 'idle') needs.push(`${item.terminal.waiting}${item.terminal.message ? `: ${clean(item.terminal.message)}` : ''}`);
  if (gateOf(item) === 'failed' && !item.attention) needs.push(`gate_failed${item.reason ? `: ${clean(item.reason)}` : ''}`);
  if (item.turnDenied) needs.push(`관문이 쓰기 ${item.turnDenied}건을 거절했습니다`);
  if (item.terminal?.draft) needs.push('입력창에 되살리지 못한 쓰다 만 글이 있습니다');
  for (const checkpoint of checkpoints ?? []) if (checkpoint.incomplete) needs.push(`체크포인트 ${checkpoint.shortSha}: ${clean(checkpoint.incomplete)}`);
  if (ctx.json) {
    emitJson(ctx, {
      ...summaryOf(item),
      ...(item.reason ? { reason: clean(item.reason) } : {}),
      gateDetail: { state: gateOf(item), checkpoints: item.gate?.checkpoints ?? 0 },
      checkpoints: checkpoints === undefined ? { unknown: 'error' in detail ? detail.error : true } : checkpoints.map((entry) => ({ sha: entry.sha, shortSha: entry.shortSha, message: clean(entry.message), createdAt: entry.createdAt, files: entry.files, ...(entry.verify ? { verify: entry.verify } : {}), ...(entry.incomplete ? { incomplete: clean(entry.incomplete) } : {}) })),
      changedFiles: changed === undefined ? { unknown: 'error' in live ? live.error : true } : changed.map((entry) => ({ file: entry.file, change: entry.change, added: entry.added, removed: entry.removed })),
      ...(item.tokens ? { tokens: item.tokens } : {}),
      ...(item.costUsd === undefined ? {} : { costUsd: item.costUsd }),
      needsAttention: needs,
    });
    return EXIT.ok;
  }
  const phase = phaseOf(item);
  ctx.out(`세션   ${item.id} · ${clean(item.title) || '(제목 없음)'}`);
  ctx.out(`프로젝트 ${item.projectName} · ${item.backend ?? '-'}${item.model ? ` (${item.model})` : ''}`);
  ctx.out(`상태   ${PHASE_LABEL[phase]} · 마지막 활동 ${ago(item.lastActivityAt)}`);
  ctx.out(`게이트 ${GATE_LABEL[gateOf(item)]} · 체크포인트 ${item.gate?.checkpoints ?? 0}개`);
  if (checkpoints === undefined) ctx.out(`체크포인트 목록을 읽지 못했습니다(${'error' in detail ? detail.error : '모름'})`);
  else for (const entry of checkpoints.slice(-5)) ctx.out(`  ${entry.shortSha} ${clean(entry.message)}${entry.incomplete ? ` [미완: ${clean(entry.incomplete)}]` : ''}`);
  if (changed === undefined) ctx.out(`지금 변경을 읽지 못했습니다(${'error' in live ? live.error : '모름'})`);
  else {
    ctx.out(`바뀐 파일 ${changed.length}개`);
    for (const entry of changed.slice(0, 30)) ctx.out(`  ${entry.change === 'added' ? 'A' : entry.change === 'deleted' ? 'D' : 'M'} ${clean(entry.file)} (+${entry.added} -${entry.removed})`);
    if (changed.length > 30) ctx.out(`  … 외 ${changed.length - 30}개`);
  }
  if (item.tokens) ctx.out(`토큰   입력 ${item.tokens.inputTokens} · 출력 ${item.tokens.outputTokens} · 캐시 읽기 ${item.tokens.cacheReadTokens}${item.costUsd === undefined ? '' : ` · $${item.costUsd.toFixed(2)}`}`);
  ctx.out(needs.length === 0 ? '확인 필요 없음' : `확인 필요 ${needs.length}건`);
  for (const line of needs) ctx.out(`  - ${line}`);
  return EXIT.ok;
}

// ─── stop(세션) ───

export async function stopSession(ctx: Ctx, ref: string): Promise<number> {
  const item = await findSession(ctx, ref);
  await ctx.client.stop(item.id);
  if (ctx.json) emitJson(ctx, { ok: true, session: item.id, stopped: true });
  else ctx.err('세션을 멈췄습니다(기록과 작업 복사본은 남습니다)');
  return EXIT.ok;
}

// ─── events ───

interface Seen {
  phase: Phase;
  gate: string;
}

export interface SessionEventLine {
  at: string;
  type: 'snapshot' | 'added' | 'phase' | 'gate' | 'removed';
  session: string;
  project?: string;
  title?: string;
  phase?: Phase;
  prevPhase?: Phase;
  gate?: string;
  prevGate?: string;
}

/** 목록 두 개의 차이를 이벤트 줄로. first면 지금 있는 세션을 snapshot으로 알린다 */
export function diffEvents(previous: ReadonlyMap<string, Seen> | undefined, items: readonly DeskItem[], now: string, only?: string): { events: SessionEventLine[]; next: Map<string, Seen> } {
  const next = new Map<string, Seen>();
  const events: SessionEventLine[] = [];
  for (const item of items) {
    if (item.id.startsWith('plan:') || item.kind !== 'session') continue;
    if (only !== undefined && item.id !== only) continue;
    const phase = phaseOf(item);
    const gate = gateOf(item);
    next.set(item.id, { phase, gate });
    const base = { at: now, session: item.id, project: item.projectName, title: clean(item.title) };
    const before = previous?.get(item.id);
    if (!previous) events.push({ ...base, type: 'snapshot', phase, gate });
    else if (!before) events.push({ ...base, type: 'added', phase, gate });
    else {
      if (before.phase !== phase) events.push({ ...base, type: 'phase', phase, prevPhase: before.phase, gate });
      if (before.gate !== gate) events.push({ ...base, type: 'gate', phase, gate, prevGate: before.gate });
    }
  }
  if (previous) for (const id of previous.keys()) if (!next.has(id)) events.push({ at: now, type: 'removed', session: id });
  return { events, next };
}

export async function events(ctx: Ctx, options: { session?: string }): Promise<number> {
  const only = options.session === undefined ? undefined : (await findSession(ctx, options.session)).id;
  const controller = new AbortController();
  ctx.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  if (ctx.signal?.aborted) return EXIT.ok;
  let seen: Map<string, Seen> | undefined;
  const print = (line: SessionEventLine): void => {
    if (ctx.json) return emitJson(ctx, line);
    const label = line.phase ? PHASE_LABEL[line.phase] : '';
    const change = line.type === 'phase' && line.prevPhase ? `${PHASE_LABEL[line.prevPhase]} → ${label}` : line.type === 'gate' ? `게이트 ${GATE_LABEL[(line.prevGate ?? 'none') as keyof typeof GATE_LABEL]} → ${GATE_LABEL[(line.gate ?? 'none') as keyof typeof GATE_LABEL]}` : line.type === 'removed' ? '목록에서 사라짐' : label;
    ctx.out(`${line.at}\t${line.type}\t${line.session}\t${change}${line.title ? `\t${line.title}` : ''}`);
  };
  await watchSessions(
    ctx.client,
    (items) => {
      const result = diffEvents(seen, items, new Date().toISOString(), only);
      seen = result.next;
      for (const line of result.events) print(line);
    },
    controller.signal,
    ctx.timing.watch,
  );
  return EXIT.ok;
}

/** 오류를 종료 코드로 옮긴다. 스튜디오의 거절 메시지는 그대로 보여 준다 */
export function exitFor(error: unknown): { code: number; message: string } {
  if (error instanceof CtlError) return { code: error.code, message: error.message };
  if (error instanceof StudioRequestError) {
    if (error.status === 401) return { code: EXIT.unreachable, message: `인증이 거절됐습니다: ${error.message}` };
    if (error.status === 404) return { code: EXIT.notFound, message: error.message };
    return { code: EXIT.failed, message: error.message };
  }
  // fetch가 연결하지 못했다(스튜디오가 꺼져 있다)
  if (error instanceof TypeError) return { code: EXIT.unreachable, message: `스튜디오에 붙지 못했습니다: ${error.cause instanceof Error ? error.cause.message : error.message}. 먼저 \`studio launch\`로 띄우세요` };
  return { code: EXIT.failed, message: error instanceof Error ? error.message : String(error) };
}
