import { afterAll, describe, expect, it } from 'vitest';
import type { SessionStatus } from '../studio-events';
import { StudioError } from './errors';
import type { BusyOp, TaskKind } from './session-claim';
import { SessionLife } from './session-status';
import { frozenModule, loadTable } from './frozen-vectors';

const FROZEN = loadTable(new URL('./session-claim-vectors.json', import.meta.url));
const { legacyBusyOpVerdict, legacyCancelVerdict, legacyCatchUpVerdict, legacyDeleteVerdict, legacyExportVerdict, legacyRequestVerdict, legacySteerVerdict, legacyTaskVerdict, legacyTerminalVerdict } = frozenModule(FROZEN, 'session-claim-legacy:');
interface LegacyBusy {
  status: SessionStatus;
  /** 옛 `snapshot.running` */
  running: boolean;
  /** 옛 `session.exporting` */
  exporting: boolean;
  /** 옛 `session.run`. `aborted`는 `run.cancel.signal.aborted` */
  run?: { id: string; aborted: boolean; steering: boolean; terminal: boolean };
}
type LegacyBusyOp = 'set_model' | 'save_requirements' | 'manual_verify' | 'manual_clear' | 'write_requirements_doc';
type LegacyTask = 'restore' | 'restore_backup' | 'sync_remote' | 'reverify';
type Verdict = string;

/**
 * 세션의 바쁨(ADR-207, 4f B3a): Rust `claim`을 옛 TS 판정이 낸 값(`session-claim-vectors.json`, 입력별로 고정)과 상태 × 멈추는 중 여부 × 점유 × 사건 전체로 견준다.
 * 아래 `legacy*Verdict`는 고정한 값을 꺼내는 껍데기다(옛 TS 파일은 지웠다).
 * 같은 첫 오류(코드와 글)를 낸다. 다른 것은 아래 `intended`가 정한 칸(결함 1·2와 그 곁)뿐이고, 그 칸의 목록은 숫자로 고정한다.
 */

const counts = { cells: 0, comparisons: 0, intended: 0, walks: 0, walkSteps: 0, walkIntended: 0 };
afterAll(() => console.log(`[session-claim 벡터] ${JSON.stringify(counts)}`));

const STATUSES: SessionStatus[] = ['idle', 'starting', 'ready', 'failed', 'stopped'];
type Claim = 'none' | 'run' | 'run-cancelling' | 'run-saving' | 'terminal' | 'terminal-cancelling' | 'restore' | 'restore_backup' | 'sync_remote' | 'reverify' | 'catch_up' | 'export' | 'catch_up+export';
const CLAIMS: Claim[] = ['none', 'run', 'run-cancelling', 'run-saving', 'terminal', 'terminal-cancelling', 'restore', 'restore_backup', 'sync_remote', 'reverify', 'catch_up', 'export', 'catch_up+export'];
const TASKS: TaskKind[] = ['restore', 'restore_backup', 'sync_remote', 'reverify'];
const BUSY_OPS: BusyOp[] = ['set_model', 'save_requirements', 'manual_verify', 'manual_clear', 'write_requirements_doc'];

interface Cell {
  status: SessionStatus;
  stopping: boolean;
  claim: Claim;
}

const slotClaim = (claim: Claim): boolean => !['none', 'export'].includes(claim);
const hasExport = (claim: Claim): boolean => claim === 'export' || claim === 'catch_up+export';

/** 이 칸을 만들 수 있는가(옛 판정의 칸은 어떤 조합이든 있지만, 새 코어에서는 만들 길이 있는 것만 견준다) */
function constructible(cell: Cell): boolean {
  const { status, stopping, claim } = cell;
  if (stopping && status === 'stopped') return false;
  if (status === 'stopped' && slotClaim(claim)) return false; // 멈추면 점유가 비워진다
  if (['restore', 'restore_backup', 'sync_remote', 'reverify'].includes(claim) && status !== 'ready') return false; // 보조 작업은 ready에서만 시작한다
  if (claim === 'run' || claim === 'run-cancelling' || claim === 'run-saving') {
    // 요청은 ready·idle에서 시작하고, idle에서 시작한 뒤 켜지는 사이에 starting·ready·failed가 된다
    return status !== 'stopped';
  }
  return true;
}

async function build(cell: Cell): Promise<SessionLife> {
  const life = new SessionLife('idle');
  const slotAt = (): void => {
    switch (cell.claim) {
      case 'run':
      case 'run-cancelling':
      case 'run-saving':
        life.claims.beginRun('r');
        break;
      case 'terminal':
      case 'terminal-cancelling':
        life.claims.beginTerminalRun('r');
        break;
      case 'catch_up':
      case 'catch_up+export':
        life.claims.beginCatchUp();
        break;
      default:
        break;
    }
  };
  const phaseTicketless = (): void => {
    if (cell.claim === 'run-cancelling' || cell.claim === 'terminal-cancelling') life.claims.cancelRun('r');
    if (cell.claim === 'run-saving') {
      // 표는 보관하지 않으므로 단계는 cancel이 아닌 set_phase로 바꾼다: 새로 표를 얻어야 하므로 아래에서 따로 한다
    }
  };
  const moveTo = (status: SessionStatus): void => {
    if (status === 'idle') return;
    const request = life.requestBoot();
    if (request.action !== 'start') throw new Error('켜기를 시작해야 합니다');
    if (status === 'ready') life.bootFinished(request.generation, { ok: true });
    if (status === 'failed') life.bootFinished(request.generation, { ok: false, error: '실패' });
  };

  if (['restore', 'restore_backup', 'sync_remote', 'reverify'].includes(cell.claim)) {
    moveTo('ready');
    life.claims.beginTask(cell.claim as TaskKind);
  } else if (cell.claim === 'run-saving') {
    // 표가 필요하다: 요청을 열고 그 표로 저장 중으로 바꾼다
    const ticket = life.claims.beginRun('r');
    life.claims.setPhase(ticket, 'saving');
    moveTo(cell.status === 'stopped' ? 'ready' : cell.status);
  } else {
    // 올리기가 먼저다: 올리는 동안에 따라잡기가 점유를 잡는다(점유를 잡은 뒤에는 올리기를 시작할 수 없다)
    if (hasExport(cell.claim)) life.claims.beginExport();
    slotAt();
    phaseTicketless();
    moveTo(cell.status === 'stopped' ? 'ready' : cell.status);
  }
  if (cell.status === 'stopped') {
    life.beginStop();
    await life.runStop(Object.fromEntries(['clear_violation', 'clear_terminal_attention', 'settle_terminal_run', 'abort_log_follower', 'clear_usage_timer', 'stop_stall_watch', 'close_file_watcher', 'dispose_terminal', 'close_gateway', 'destroy_sandbox', 'close_preview_proxies', 'mark_services_stopped', 'apply_status', 'clear_sandbox_link', 'flush_persist'].map((name) => [name, () => {}])) as never);
  } else if (cell.stopping) {
    life.beginStop();
  }
  return life;
}

/** 칸의 옛 사실(`running`·`run`·`exporting`). 멈춘 세션은 옛 `mark_services_stopped`가 `running`을 풀었다 */
function legacyFacts(cell: Cell): LegacyBusy {
  const slot = slotClaim(cell.claim) && cell.status !== 'stopped';
  const runLike = ['run', 'run-cancelling', 'terminal', 'terminal-cancelling'].includes(cell.claim);
  return {
    status: cell.status,
    running: slot,
    exporting: hasExport(cell.claim),
    ...(runLike ? { run: { id: 'r', aborted: cell.claim.endsWith('cancelling'), steering: true, terminal: cell.claim.startsWith('terminal') } } : {}),
  };
}

function verdictOf(action: () => unknown): Verdict {
  try {
    action();
    return 'ok';
  } catch (error) {
    if (error instanceof StudioError) return `${error.status}:${error.message}`;
    throw error;
  }
}

const STOP = '409:중지된 세션입니다. 이어서 작업하면 새 샌드박스를 띄웁니다';
const DELETE = '409:실행 중인 세션은 지울 수 없습니다. 먼저 샌드박스를 중지한 뒤 지우세요';
const TERMINAL_STOPPED = '409:[b-studio] 중지하는 중이거나 중지된 세션이라 요청을 받지 않습니다.';

type Event =
  | { kind: 'request' }
  | { kind: 'begin_run' }
  | { kind: 'cancel'; runId: string }
  | { kind: 'steer' }
  | { kind: 'task_check'; task: LegacyTask }
  | { kind: 'task_begin'; task: LegacyTask }
  | { kind: 'catch_up' }
  | { kind: 'busy_op'; op: LegacyBusyOp }
  | { kind: 'export' }
  | { kind: 'delete' }
  | { kind: 'terminal' }
  | { kind: 'terminal_begin' };

const EVENTS: Event[] = [
  { kind: 'request' },
  { kind: 'begin_run' },
  { kind: 'cancel', runId: 'r' },
  { kind: 'cancel', runId: 'other' },
  { kind: 'steer' },
  ...TASKS.flatMap((task): Event[] => [{ kind: 'task_check', task }, { kind: 'task_begin', task }]),
  { kind: 'catch_up' },
  ...BUSY_OPS.map((op): Event => ({ kind: 'busy_op', op })),
  { kind: 'export' },
  { kind: 'delete' },
  { kind: 'terminal' },
  { kind: 'terminal_begin' },
];

/** 상태를 먼저 보고 점유를 보는 TS 쪽의 순서(sessions.ts에서 `rejectBusy` 앞에 있는 `status !== 'ready'` 검사)를 시험에서 같은 모양으로 놓는다 */
function newVerdict(life: SessionLife, status: SessionStatus, event: Event): Verdict {
  const claims = life.claims;
  switch (event.kind) {
    case 'request':
      return verdictOf(() => claims.checkRun());
    case 'begin_run':
      return verdictOf(() => claims.beginRun('new'));
    case 'cancel': {
      let outcome: 'started' | 'already' | undefined;
      const verdict = verdictOf(() => {
        outcome = claims.cancelRun(event.runId);
      });
      return verdict === 'ok' ? outcome! : verdict;
    }
    case 'steer':
      return verdictOf(() => claims.steerTarget());
    case 'task_check':
      return verdictOf(() => claims.checkTask(event.task));
    case 'task_begin':
      return verdictOf(() => claims.beginTask(event.task));
    case 'catch_up':
      return claims.beginCatchUp() === undefined ? 'skip' : 'go';
    case 'busy_op':
      return verdictOf(() => claims.rejectBusy(event.op));
    case 'export':
      return verdictOf(() => claims.beginExport());
    case 'delete': {
      // 상태 판정(Rust `delete_check`)은 옛 글과 같고, 점유 판정은 `checkDelete`다
      if (status !== 'stopped' && status !== 'idle') return DELETE;
      return verdictOf(() => claims.checkDelete());
    }
    case 'terminal': {
      const busy = claims.terminalBusy();
      return busy === undefined ? 'ok' : `409:${busy}`;
    }
    case 'terminal_begin': {
      const result = claims.beginTerminalRun('new');
      return typeof result === 'number' ? 'ok' : `409:${result.busy}`;
    }
  }
}

function legacyVerdict(facts: LegacyBusy, event: Event): Verdict {
  switch (event.kind) {
    case 'request':
    case 'begin_run':
      return legacyRequestVerdict(facts);
    case 'cancel':
      return legacyCancelVerdict(facts, event.runId);
    case 'steer':
      return legacySteerVerdict(facts);
    case 'task_check':
    case 'task_begin':
      return legacyTaskVerdict(facts, event.task);
    case 'catch_up':
      return legacyCatchUpVerdict(facts);
    case 'busy_op':
      return legacyBusyOpVerdict(facts, event.op);
    case 'export':
      return legacyExportVerdict(facts);
    case 'delete':
      return legacyDeleteVerdict(facts);
    case 'terminal':
    case 'terminal_begin':
      return legacyTerminalVerdict(facts);
  }
}

/**
 * 의도한 차이(결함 1·2와 그 곁)의 새 판정. 옛 판정이 통과였던 칸에서만 다르고, 다르면 정해진 글이다. 해당하지 않으면 `undefined`(같아야 한다)
 */
function intended(cell: Cell, event: Event, legacy: Verdict): Verdict | undefined {
  const passes = legacy === 'ok' || legacy === 'go';
  const stopping = cell.stopping && cell.status !== 'stopped';
  switch (event.kind) {
    case 'request':
    case 'begin_run':
    case 'task_check':
    case 'task_begin':
      // 결함 2: 멈추는 중이면 요청·보조 작업을 시작하지 않는다
      return stopping && passes ? STOP : undefined;
    case 'catch_up':
      // 결함 2의 곁: 멈추는 중이거나 멈춘 세션의 따라잡기는 건너뛴다
      return passes && (stopping || cell.status === 'stopped') ? 'skip' : undefined;
    case 'delete':
      // 결함 1: 점유 중이면 상태가 idle이어도 지우지 않는다(올리는 중 포함)
      return passes && (slotClaim(cell.claim) || hasExport(cell.claim)) ? DELETE : undefined;
    case 'terminal':
    case 'terminal_begin':
      // 결함 2의 곁: 멈추는 중이거나 멈춘 세션에서 터미널 실행을 시작하지 않는다
      return passes && (stopping || cell.status === 'stopped') ? TERMINAL_STOPPED : undefined;
    default:
      return undefined;
  }
}

describe('바쁨 판정 벡터(상태 × 멈추는 중 × 점유 × 사건)', () => {
  it('옛 판정과 같은 첫 오류를 낸다. 다른 칸은 결함 1·2 목록뿐이다', async () => {
    const differing: string[] = [];
    for (const status of STATUSES) {
      for (const stopping of [false, true]) {
        for (const claim of CLAIMS) {
          const cell: Cell = { status, stopping, claim };
          if (!constructible(cell)) continue;
          counts.cells += 1;
          const facts = legacyFacts(cell);
          for (const event of EVENTS) {
            const legacy = legacyVerdict(facts, event);
            const actual = newVerdict(await build(cell), status, event);
            const label = `${JSON.stringify(cell)} ${JSON.stringify(event)}`;
            const expected = intended(cell, event, legacy);
            counts.comparisons += 1;
            if (expected !== undefined) {
              counts.intended += 1;
              differing.push(`${event.kind}${'task' in event ? `:${event.task}` : ''} ${status}${stopping ? '+멈추는 중' : ''} ${claim}`);
              expect(actual, label).toBe(expected);
              expect(actual, `${label} (옛 판정과 달라야 목록에 든다)`).not.toBe(legacy);
            } else {
              expect(actual, label).toBe(legacy);
            }
          }
        }
      }
    }
    // 의도한 차이 칸의 수를 고정한다(칸이 늘거나 줄면 이유를 적고 고친다)
    if (process.env.PRINT_INTENDED) console.log(differing.join('\n'));
    expect(differing.length).toBe(counts.intended);
    expect(counts.intended).toBe(EXPECTED_INTENDED);
    const kinds = new Set(differing.map((line) => line.split(' ')[0]!.split(':')[0]));
    expect([...kinds].sort()).toEqual(['begin_run', 'catch_up', 'delete', 'request', 'task_begin', 'task_check', 'terminal', 'terminal_begin']);
  });
});

const EXPECTED_INTENDED = 49;

function prng(seedStart: number): () => number {
  let seed = seedStart;
  return () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff);
}

const NOOP_STOP = Object.fromEntries(['clear_violation', 'clear_terminal_attention', 'settle_terminal_run', 'abort_log_follower', 'clear_usage_timer', 'stop_stall_watch', 'close_file_watcher', 'dispose_terminal', 'close_gateway', 'destroy_sandbox', 'close_preview_proxies', 'mark_services_stopped', 'apply_status', 'clear_sandbox_link', 'flush_persist'].map((name) => [name, () => {}])) as never;

const CHECKS: Event[] = [
  { kind: 'request' },
  { kind: 'cancel', runId: 'zzz' },
  { kind: 'steer' },
  ...TASKS.map((task): Event => ({ kind: 'task_check', task })),
  ...BUSY_OPS.map((op): Event => ({ kind: 'busy_op', op })),
  { kind: 'delete' },
  { kind: 'terminal' },
];

describe('바쁨 점유의 무작위 열(표·단계·멈추기)', () => {
  it('점유를 잡고 풀고 단계를 바꾸고 멈추는 열에서 옛 판정과 같고, 낡은 표는 새 점유를 풀지 못한다', async () => {
    for (let walk = 0; walk < 150; walk += 1) {
      const next = prng(7_000 + walk);
      const life = new SessionLife('idle');
      const facts: LegacyBusy = { status: 'idle', running: false, exporting: false };
      let slot: { ticket: number; kind: 'run' | 'terminal' | 'task' | 'catch_up'; runId?: string } | undefined;
      let exportTicket: number | undefined;
      const stale: number[] = [];
      let runCounter = 0;
      counts.walks += 1;

      const compare = (label: string): void => {
        facts.status = life.status as SessionStatus;
        for (const event of CHECKS) {
          const legacy = legacyVerdict(facts, event);
          const actual = newVerdict(life, facts.status, event);
          const cell: Cell = {
            status: facts.status,
            stopping: life.stopping,
            claim: facts.running ? (facts.exporting ? 'catch_up+export' : 'run') : facts.exporting ? 'export' : 'none',
          };
          const expected = intended(cell, event, legacy);
          counts.walkSteps += 1;
          if (expected !== undefined) {
            counts.walkIntended += 1;
            expect(actual, `${label} ${JSON.stringify(event)}`).toBe(expected);
          } else {
            expect(actual, `${label} ${JSON.stringify(event)} ${JSON.stringify(facts)}`).toBe(legacy);
          }
        }
        expect(life.claims.busy, `${label} busy`).toBe(facts.running);
        expect(life.claims.exporting, `${label} exporting`).toBe(facts.exporting);
      };

      for (let step = 0; step < 24; step += 1) {
        const pick = next() % 14;
        const label = `walk ${walk} step ${step} pick ${pick}`;
        if (pick === 0) {
          const verdict = verdictOf(() => {
            const ticket = life.claims.beginRun(`r${(runCounter += 1)}`);
            slot = { ticket, kind: 'run', runId: `r${runCounter}` };
          });
          if (verdict === 'ok') Object.assign(facts, { running: true, run: { id: `r${runCounter}`, aborted: false, steering: true, terminal: false } });
        } else if (pick === 1) {
          const result = life.claims.beginTerminalRun(`t${(runCounter += 1)}`);
          if (typeof result === 'number') {
            slot = { ticket: result, kind: 'terminal', runId: `t${runCounter}` };
            Object.assign(facts, { running: true, run: { id: `t${runCounter}`, aborted: false, steering: true, terminal: true } });
          }
        } else if (pick === 2) {
          const kind = TASKS[next() % TASKS.length]!;
          const verdict = verdictOf(() => {
            slot = { ticket: life.claims.beginTask(kind), kind: 'task' };
          });
          if (verdict === 'ok') facts.running = true;
        } else if (pick === 3) {
          const ticket = life.claims.beginCatchUp();
          if (ticket !== undefined) {
            slot = { ticket, kind: 'catch_up' };
            facts.running = true;
          }
        } else if (pick === 4) {
          const verdict = verdictOf(() => {
            exportTicket = life.claims.beginExport();
          });
          if (verdict === 'ok') facts.exporting = true;
        } else if (pick === 5 && slot) {
          expect(life.claims.release(slot.ticket), label).toBe(true);
          stale.push(slot.ticket);
          slot = undefined;
          facts.running = false;
          delete facts.run;
        } else if (pick === 6 && exportTicket !== undefined) {
          expect(life.claims.releaseExport(exportTicket), label).toBe(true);
          exportTicket = undefined;
          facts.exporting = false;
        } else if (pick === 7) {
          // 낡은 표·엉뚱한 표로는 아무것도 풀리지 않는다
          const before = { busy: life.claims.busy, exporting: life.claims.exporting };
          const wrong = stale.length > 0 && next() % 2 === 0 ? stale[next() % stale.length]! : 1_000_000 + (next() % 10);
          expect(life.claims.release(wrong), label).toBe(false);
          expect(life.claims.releaseExport(wrong), label).toBe(false);
          expect({ busy: life.claims.busy, exporting: life.claims.exporting }, label).toEqual(before);
        } else if (pick === 8 && slot?.runId) {
          const id = next() % 3 === 0 ? 'other' : slot.runId;
          const legacy = legacyCancelVerdict(facts, id);
          let outcome: string | undefined;
          const result = verdictOf(() => {
            outcome = life.claims.cancelRun(id);
          });
          const actual = result === 'ok' ? outcome! : result;
          expect(actual, label).toBe(legacy);
          if (actual === 'started' && facts.run) facts.run.aborted = true;
        } else if (pick === 9 && slot?.runId) {
          // 저장 중: 옛 코드는 `session.run`만 지웠다
          const moved = life.claims.setPhase(slot.ticket, 'saving');
          if (moved) delete facts.run;
        } else if (pick === 10) {
          const request = life.requestBoot();
          if (request.action === 'start') {
            if (next() % 2 === 0) life.bootFinished(request.generation, { ok: true });
            else if (next() % 2 === 0) life.bootFinished(request.generation, { ok: false, error: '실패' });
          }
        } else if (pick === 11 && next() % 3 === 0) {
          life.beginStop();
        } else if (pick === 12 && life.stopping) {
          await life.runStop(NOOP_STOP);
          // 멈추기가 끝나면 점유가 비워진다(옛 `mark_services_stopped`의 `running=false`와 같다)
          Object.assign(facts, { running: false });
          delete facts.run;
          if (slot) stale.push(slot.ticket);
          slot = undefined;
        }
        compare(label);
      }
    }
    expect(counts.walkSteps).toBeGreaterThan(1_000);
  });
});
