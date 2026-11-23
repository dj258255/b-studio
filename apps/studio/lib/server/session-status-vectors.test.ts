import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { native } from '@b-studio/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionStatus } from '../studio-events';
import { SessionLife, SessionRegistry, type StopActions } from './session-status';
import { book, ledger, loadTable } from './frozen-vectors';
import { StudioError } from './errors';

/**
 * 세션 상태 전이·멈추기 순서·이어받기 판정·폴더 점유(ADR-205, 4f B2b): Rust `status`·`registry`를 옛 TS가 같은 입력에 낸 값(`session-status-vectors.json`에 고정)과 견준다.
 * 같은 결과를 내고, 다른 것은 아래 "의도한 차이" 시험 둘뿐이다:
 *   1. 멈추는 중이거나 세대가 지난 켜기의 결과는 상태를 바꾸지 않는다
 *   2. 멈추는 중에는 새 켜기를 시작하지 않는다
 * 폴더 점유는 정상(별칭이 아닌) 폴더에서 같고, 별칭(링크·끝의 `/`)은 옛 검사가 놓친 것을 막는다.
 */

const OLD = book(loadTable(new URL('./session-status-vectors.json', import.meta.url)));

/** 옛 상태 모델(옛 `session.status`·`error`·`bootPromise`·`stop.signal.aborted`) */
interface LegacyModel {
  status: SessionStatus;
  error?: string;
  hasBoot: boolean;
  aborted: boolean;
}
const legacyModel = (initial: 'idle' | 'starting'): LegacyModel => ({ status: initial, hasBoot: false, aborted: false });
/** 옛 `stopSession`의 단계 이름과 삼킴(옛 값을 고정했다) */
const LEGACY_STOP_STEPS: readonly { name: string; swallow: boolean }[] = [
  { name: 'clear_violation', swallow: false },
  { name: 'clear_terminal_attention', swallow: false },
  { name: 'settle_terminal_run', swallow: false },
  { name: 'abort_log_follower', swallow: false },
  { name: 'clear_usage_timer', swallow: false },
  { name: 'stop_stall_watch', swallow: false },
  { name: 'close_file_watcher', swallow: false },
  { name: 'dispose_terminal', swallow: false },
  { name: 'close_gateway', swallow: true },
  { name: 'destroy_sandbox', swallow: true },
  { name: 'close_preview_proxies', swallow: true },
  { name: 'mark_services_stopped', swallow: false },
  { name: 'apply_status', swallow: false },
  { name: 'clear_sandbox_link', swallow: false },
  { name: 'flush_persist', swallow: false },
];

const counts = { sequences: 0, ops: 0, stopRuns: 0, gates: 0, folders: 0, intendedStale: 0, intendedStopping: 0, intendedRequest: 0 };
afterAll(() => console.log(`[session-status 벡터] ${JSON.stringify(counts)}`));

function prng(seedStart: number): () => number {
  let seed = seedStart;
  return () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff);
}

const noop: StopActions = Object.fromEntries(LEGACY_STOP_STEPS.map((step) => [step.name, () => {}])) as StopActions;

function sameState(life: SessionLife, model: LegacyModel, label: string): void {
  expect({ status: life.status, error: life.error }, label).toEqual({ status: model.status, error: model.error });
}

type Op = { kind: 'request' } | { kind: 'finish'; ok: boolean; gen: 'current' | 'older' | 'newer' } | { kind: 'begin' } | { kind: 'complete' };

function randomOps(next: () => number): Op[] {
  const length = 1 + (next() % 12);
  const ops: Op[] = [];
  for (let at = 0; at < length; at += 1) {
    const pick = next() % 10;
    if (pick < 3) ops.push({ kind: 'request' });
    else if (pick < 7) ops.push({ kind: 'finish', ok: next() % 2 === 0, gen: (['current', 'current', 'current', 'older', 'newer'] as const)[next() % 5]! });
    else if (pick < 9) ops.push({ kind: 'begin' });
    else ops.push({ kind: 'complete' });
  }
  return ops;
}

describe('상태 전이 벡터(상태 × 켜기 요청·켜기 끝·멈추기 시작·멈추기 끝의 무작위 열)', () => {
  /**
   * 옛 판정이 한 연산마다 낸 값(돌려준 값과 옛 모델의 그 뒤 상태)을 글 한 줄(토큰)로 적고, 같은 토큰은 한 번만 적어 번호로 가리킨다.
   * 열마다 연산 순서대로 토큰 번호를 쉼표로 이은 글 하나다.
   */
  const DICTIONARY = OLD.get('tokens') as string[];
  const SEQUENCES = OLD.get('sequences') as string[];
  const tokenAt = (sequence: number, at: number): { ret: unknown; state: LegacyModel } => {
    const [ret, status, error, hasBoot, aborted] = JSON.parse(DICTIONARY[Number(SEQUENCES[sequence]!.split(',')[at])]!) as [unknown, SessionStatus, string | null, boolean, boolean];
    return { ret, state: { status, error: error === null ? undefined : error, hasBoot, aborted } };
  };

  it('무작위 열에서 옛 판정과 같고, 다른 것은 의도한 차이뿐이다', async () => {
    const next = prng(20_261_117);
    for (let sequence = 0; sequence < 4_000; sequence += 1) {
      const initial = next() % 2 === 0 ? 'idle' : 'starting';
      const life = new SessionLife(initial);
      const model = legacyModel(initial);
      let generation = 0;
      let begun = false;
      let completed = false;
      const ops = randomOps(next);
      counts.sequences += 1;
      for (const [at, op] of ops.entries()) {
        counts.ops += 1;
        const label = `#${sequence} ${initial} ${JSON.stringify(ops.slice(0, at + 1))}`;
        if (op.kind === 'request') {
          const before = model.status;
          const { ret: legacy, state: clone } = tokenAt(sequence, at);
          const fresh = life.requestBoot();
          if (model.aborted && !completed && fresh.action === 'stopped' && legacy !== 'stopped') {
            // 의도한 차이 2: 멈추는 중에는 새 켜기를 시작하지 않는다(옛 코드는 중지 신호가 올라간 세션에서도 켜기를 시작하거나 기다렸다)
            counts.intendedRequest += 1;
            sameState(life, model, label);
            continue;
          }
          expect(fresh.action, label).toBe(legacy);
          Object.assign(model, clone);
          if (fresh.action === 'start') {
            generation = fresh.generation;
            // starting이 아니었다가 starting으로 바뀐 것만 알린다(즉시 기동 세션은 다시 알리지 않는다)
            expect(fresh.change !== undefined, label).toBe(before !== 'starting');
          }
          sameState(life, model, label);
        } else if (op.kind === 'finish') {
          const target = op.gen === 'current' ? generation : op.gen === 'older' ? generation - 1 : generation + 1;
          const outcome = op.ok ? ({ ok: true } as const) : ({ ok: false, error: `실패 ${at}` } as const);
          const { ret: legacyApplied, state: clone } = tokenAt(sequence, at);
          const change = life.bootFinished(target, outcome);
          if (legacyApplied && change === undefined) {
            // 의도한 차이 1: 멈추는 중이거나 세대가 지난 켜기의 결과는 상태를 바꾸지 않는다
            const stale = op.gen !== 'current';
            const stopping = begun || completed;
            expect(stale || stopping, `${label}: 옛 판정은 적용했는데 새 판정이 무시한 까닭이 설명되지 않는다`).toBe(true);
            if (stopping) counts.intendedStopping += 1;
            else counts.intendedStale += 1;
          } else {
            expect(change !== undefined, label).toBe(legacyApplied);
            Object.assign(model, clone);
          }
          sameState(life, model, label);
        } else if (op.kind === 'begin') {
          const { ret: legacy, state: after } = tokenAt(sequence, at);
          Object.assign(model, after);
          const fresh = life.beginStop();
          if (legacy === 'stopped') expect(fresh, label).toBe('stopped');
          else expect(fresh === 'started' || fresh === 'joined', label).toBe(true);
          if (fresh === 'started') begun = true;
          sameState(life, model, label);
        } else if (begun && !completed) {
          await life.runStop(noop);
          Object.assign(model, tokenAt(sequence, at).state);
          completed = true;
          counts.stopRuns += 1;
          sameState(life, model, label);
        } else {
        }
      }
    }
    expect(counts.intendedStopping).toBeGreaterThan(0);
    expect(counts.intendedStale).toBeGreaterThan(0);
    expect(counts.intendedRequest).toBeGreaterThan(0);
  });

  it('의도한 차이: 멈추는 중이거나 세대가 지난 켜기의 결과는 상태를 바꾸지 않는다', async () => {
    for (const ok of [true, false]) {
      const outcome = ok ? ({ ok: true } as const) : ({ ok: false, error: '실패' } as const);
      // 멈추기가 시작된 뒤
      const life = new SessionLife('idle');
      const request = life.requestBoot();
      if (request.action !== 'start') throw new Error('켜기를 시작해야 합니다');
      life.beginStop();
      expect(life.bootFinished(request.generation, outcome)).toBeUndefined();
      expect(life.status).toBe('starting');
      // 옛 코드는 성공이면 ready로 바꿨고(트러블슈팅 213), 실패는 중지 신호를 보고 무시했다
      expect(OLD.get(`late finish ${ok}`)).toBe(ok);
      // 세대가 지난 켜기(다시 켠 뒤의 옛 켜기)
      const retry = new SessionLife('idle');
      const first = retry.requestBoot();
      if (first.action !== 'start') throw new Error('켜기를 시작해야 합니다');
      retry.bootFinished(first.generation, { ok: false, error: '첫 켜기 실패' });
      const second = retry.requestBoot();
      if (second.action !== 'start') throw new Error('다시 켜야 합니다');
      expect(retry.bootFinished(first.generation, outcome)).toBeUndefined();
      expect(retry.status).toBe('starting');
      expect(retry.bootFinished(second.generation, { ok: true })).toEqual({ status: 'ready' });
    }
  });

  it('의도한 차이: 멈추는 중에는 새 켜기를 시작하지 않는다(켜져 있으면 켜져 있다고 답한다)', () => {
    for (const initial of ['idle', 'starting'] as const) {
      const life = new SessionLife(initial);
      life.beginStop();
      expect(life.requestBoot()).toEqual({ action: 'stopped' });
      expect(life.status).toBe(initial);
      expect(OLD.get(`request while stopping ${initial}`)).toBe('start');
    }
    const ready = new SessionLife('idle');
    const request = ready.requestBoot();
    if (request.action !== 'start') throw new Error('켜기를 시작해야 합니다');
    ready.bootFinished(request.generation, { ok: true });
    ready.beginStop();
    expect(ready.requestBoot()).toEqual({ action: 'ready' });
  });
});

function lifeIn(status: SessionStatus): SessionLife {
  const life = new SessionLife(status === 'idle' ? 'idle' : 'starting');
  if (status === 'idle' || status === 'starting') return life;
  const request = life.requestBoot();
  if (request.action !== 'start') throw new Error('켜기를 시작해야 합니다');
  if (status === 'ready') life.bootFinished(request.generation, { ok: true });
  else if (status === 'failed') life.bootFinished(request.generation, { ok: false, error: '실패' });
  return life;
}

async function stopped(): Promise<SessionLife> {
  const life = lifeIn('idle');
  life.beginStop();
  await life.runStop(noop);
  return life;
}

describe('멈추기 순서 벡터(단계 이름·순서·실패 처리·남는 상태)', () => {
  it('단계 이름 목록과 순서, 삼킴·던짐이 옛 `stopSession`과 같다', () => {
    expect(native.sessionStopSteps()).toEqual(LEGACY_STOP_STEPS.map((step) => ({ name: step.name, swallow: step.swallow })));
  });

  async function both(initial: 'idle' | 'starting', failing: ReadonlySet<string>) {
    const key = `stop ${initial} ${[...failing].join(',')}`;
    const recorded = OLD.get(key) as { calls: number; error: string | null; status: SessionStatus; modelError: string | null };
    const model: LegacyModel = { status: recorded.status, error: recorded.modelError === null ? undefined : recorded.modelError, hasBoot: false, aborted: true };
    const legacyCalls = LEGACY_STOP_STEPS.slice(0, recorded.calls).map((step) => step.name);
    const legacyError: unknown = recorded.error === null ? undefined : new Error(recorded.error);

    const life = new SessionLife(initial);
    expect(life.beginStop()).toBe('started');
    const freshCalls: string[] = [];
    const errors = new Map<string, Error>();
    const actions = Object.fromEntries(
      LEGACY_STOP_STEPS.map((step) => [
        step.name,
        () => {
          freshCalls.push(step.name);
          if (failing.has(step.name)) {
            const error = new Error(`${step.name} 실패`);
            errors.set(step.name, error);
            throw error;
          }
        },
      ]),
    ) as StopActions;
    let freshError: unknown;
    try {
      await life.runStop(actions);
    } catch (error) {
      freshError = error;
    }
    return { model, legacyCalls, legacyError, life, freshCalls, freshError, errors };
  }

  it('단계 하나를 실패시키면 옛 코드와 같은 호출 열·던짐·삼킴·남는 상태가 나온다(처음 상태 둘 × 단계 15개)', async () => {
    for (const initial of ['idle', 'starting'] as const) {
      for (const step of LEGACY_STOP_STEPS) {
        const result = await both(initial, new Set([step.name]));
        const label = `${initial} ${step.name}`;
        expect(result.freshCalls, label).toEqual(result.legacyCalls);
        expect(Boolean(result.freshError), label).toBe(Boolean(result.legacyError));
        if (result.freshError) {
          // 던진 오류는 단계가 던진 그 오류다(StudioError 같은 종류를 잃지 않는다)
          expect(result.freshError, label).toBe(result.errors.get(step.name));
          expect((result.freshError as Error).message, label).toBe((result.legacyError as Error).message);
        }
        // 상태는 옛 코드와 같다: 상태를 바꾸는 단계 앞에서 던졌으면 그대로, 뒤였으면 stopped
        sameState(result.life, result.model, label);
        // 멈추는 중으로 영영 남지 않는다
        expect(result.life.stopping, label).toBe(false);
        counts.stopRuns += 1;
      }
    }
  });

  it('여러 단계를 한꺼번에 실패시켜도 같다(무작위 부분집합 1,500개)', async () => {
    const next = prng(20_261_118);
    for (let round = 0; round < 1_500; round += 1) {
      const failing = new Set(LEGACY_STOP_STEPS.filter(() => next() % 4 === 0).map((step) => step.name));
      const initial = next() % 2 === 0 ? 'idle' : 'starting';
      const result = await both(initial, failing);
      const label = `${initial} ${[...failing].join(',')}`;
      expect(result.freshCalls, label).toEqual(result.legacyCalls);
      expect(Boolean(result.freshError), label).toBe(Boolean(result.legacyError));
      if (result.freshError) expect((result.freshError as Error).message, label).toBe((result.legacyError as Error).message);
      sameState(result.life, result.model, label);
      expect(result.life.stopping, label).toBe(false);
      counts.stopRuns += 1;
    }
  });

  it('던져서 멈춘 뒤에도 다시 멈출 수 있다(이미 멈췄으면 할 일이 없다)', async () => {
    const life = new SessionLife('idle');
    life.beginStop();
    await expect(life.runStop({ ...noop, dispose_terminal: () => Promise.reject(new StudioError(500, '터미널')) })).rejects.toBeInstanceOf(StudioError);
    expect(life.stopping).toBe(false);
    expect(life.status).toBe('idle');
    expect(life.beginStop()).toBe('started');
    await life.runStop(noop);
    expect(life.status).toBe('stopped');
    expect(life.beginStop()).toBe('stopped');
  });

  it('동시에 멈추면 하나만 단계를 밟고 나머지는 그 끝을 기다린다(같은 실패를 받는다)', async () => {
    const life = new SessionLife('idle');
    expect(life.beginStop()).toBe('started');
    expect(life.beginStop()).toBe('joined');
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const joined = life.joinStop();
    const run = life.runStop({
      ...noop,
      destroy_sandbox: async () => {
        calls.push('destroy_sandbox');
        await gate;
      },
    });
    release();
    await run;
    await joined;
    expect(calls).toEqual(['destroy_sandbox']);

    const failing = new SessionLife('idle');
    failing.beginStop();
    failing.beginStop();
    const waiting = failing.joinStop();
    const waited = expect(waiting).rejects.toThrow('터미널 정리 실패');
    const fails = failing.runStop({ ...noop, dispose_terminal: () => Promise.reject(new Error('터미널 정리 실패')) });
    await expect(fails).rejects.toThrow('터미널 정리 실패');
    await waited;
  });

  it('콜백이 던진 값이 Error가 아니어도 이유를 글자로 돌린다(콜백이 Rust로 던지지 않는다)', async () => {
    const life = new SessionLife('idle');
    life.beginStop();
    await expect(life.runStop({ ...noop, clear_violation: () => Promise.reject('문자열을 던졌다') })).rejects.toBe('문자열을 던졌다');
    const unknown = new SessionLife('idle');
    unknown.beginStop();
    await expect(unknown.runStop({ ...noop, flush_persist: undefined as unknown as () => void })).rejects.toThrow('알 수 없는 멈추기 단계');
  });
});

describe('이어받기 판정 벡터(상태 × 보관 여부 × 이어받는 중 여부)', () => {
  it('없음 404·멈추지 않음 409·이미 이어받는 중 409가 옛 글과 같다', async () => {
    const statuses: (SessionStatus | undefined)[] = [undefined, 'idle', 'starting', 'ready', 'failed', 'stopped'];
    for (const live of statuses) {
      for (const archived of [false, true]) {
        for (const resuming of [false, true]) {
          const registry = new SessionRegistry();
          // 이어받는 중인 표시를 먼저 둔다(실행 중인 세션이 멈추지 않았으면 이어받기 자체가 거절되므로, 세션을 올리기 전에 넣는다)
          if (resuming) registry.beginResume('s1', true);
          if (live) registry.register('s1', live === 'stopped' ? await stopped() : lifeIn(live), false, '/x');
          let fresh: { status?: number; message: string } | undefined;
          try {
            registry.beginResume('s1', archived);
          } catch (error) {
            fresh = error as StudioError;
          }
          const old = OLD.get(`resume ${live} ${archived} ${resuming}`);
          counts.gates += 1;
          expect(fresh ? { status: fresh.status, message: fresh.message } : undefined, JSON.stringify({ live, archived, resuming })).toEqual(old);
        }
      }
    }
  });

  it('이어받는 중에 넣고 빼기는 레지스트리가 하고, 실패해도 빠진다(옛 finally)', () => {
    const registry = new SessionRegistry();
    registry.beginResume('s1', true);
    expect(() => registry.beginResume('s1', true)).toThrow('이미 이어서 작업할 준비를 하는 중입니다');
    try {
      registry.beginResume('s1', true);
    } catch {
      // 거절된 호출이 남의 이어받기를 풀지 않는다
    }
    expect(() => registry.beginResume('s1', true)).toThrow('이미 이어서');
    registry.endResume('s1');
    registry.beginResume('s1', true);
    registry.endResume('s1');
    registry.endResume('s1');
    registry.beginResume('s1', true);
  });
});

describe('폴더 점유 벡터', () => {
  it('별칭이 아닌 서로 다른 폴더에서는 옛 검사와 같은 결과·같은 오류 글이다(무작위)', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'status-folders-'));
    const dirs: string[] = [];
    for (let at = 0; at < 4; at += 1) {
      const dir = path.join(tmp, `folder-${at}`);
      await mkdir(dir);
      dirs.push(dir);
    }
    const missing = path.join(tmp, 'gone');
    const roots = [...dirs, missing];
    const next = prng(20_261_119);
    for (let round = 0; round < 1_500; round += 1) {
      const registry = new SessionRegistry();
      const released: Array<() => void> = [];
      const folders = ledger();
      const used = new Set<string>();
      // 같은 폴더에서 일하는 세션은 하나다(점유가 막아 주는 정상 상태)
      for (let at = 0; at < 3; at += 1) {
        const dir = roots[next() % roots.length]!;
        const workspace = next() % 3 === 0 ? 'copy' : 'local';
        const status = (['idle', 'ready', 'stopped'] as const)[next() % 3]!;
        if (workspace === 'local' && status !== 'stopped' && used.has(dir)) continue;
        if (workspace === 'local' && status !== 'stopped') used.add(dir);
        const id = `s${at}`;
        registry.register(id, status === 'stopped' ? await stopped() : lifeIn(status), workspace === 'local', dir);
      }
      for (let step = 0; step < 4; step += 1) {
        const root = roots[next() % roots.length]!;
        const self = next() % 3 === 0 ? `s${next() % 3}` : undefined;
        let fresh: { status?: number; message: string } | undefined;
        try {
          released.push(registry.claimFolder(root, self));
        } catch (error) {
          fresh = error as StudioError;
        }
        counts.folders += 1;
        // 옛 검사가 돌려준 값(거절의 상태와 글, 통과는 undefined)과 장부로 견준다. 폴더 경로는 글에 들어 있지 않다
        folders.add(fresh ? { status: fresh.status, message: fresh.message } : undefined);
        if (next() % 3 === 0 && released.length > 0) {
          released.shift()!();
        }
      }
      folders.add(registry.claimedCount());
      expect(folders.digest(), `folders ${round}`).toBe(OLD.get(`folders ${round}`));
    }
  });

  it('의도한 차이: 같은 폴더를 가리키는 별칭(링크·끝의 `/`·`.`)은 옛 검사를 지났고 새 검사는 막는다', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'status-alias-'));
    const user = path.join(tmp, 'user');
    await mkdir(user);
    const link = path.join(tmp, 'alias');
    await symlink(user, link);
    for (const alias of [link, `${user}/`, `${user}/.`, `${user}//`]) {
      const registry = new SessionRegistry();
      registry.register('s0', lifeIn('ready'), true, user);
      // 옛 검사는 글자만 비교해 이 별칭을 통과시켰다(옛 값: 통과)
      expect(() => registry.claimFolder(alias), alias).toThrow('이 폴더는 세션 s0에서 작업하고 있습니다');
    }
  });
});
