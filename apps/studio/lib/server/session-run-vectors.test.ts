import { native } from '@b-studio/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionStatus } from '../studio-events';
import { decideException, decideNormal, needsProbeException, needsProbeNormal, runRequest, runSteps, type RunActions, type RunStep } from './session-run';
import { frozenModule, loadTable } from './frozen-vectors';

const FROZEN = loadTable(new URL('./session-run-vectors.json', import.meta.url));
const { legacyException, legacyFlow, legacyNormal } = frozenModule(FROZEN, 'session-run-outcome-legacy:');
type LegacyKind = 'prepare_fails' | 'plan_fails' | 'run_throws' | 'preflight' | 'done' | 'failed' | 'awaiting_input';
interface LegacyNormalFacts {
  ask: boolean;
  result: LegacyResult;
  questionGatePassed: boolean;
  platformFailure: boolean;
  booted: boolean;
  status: SessionStatus;
  local: boolean;
}
type LegacyResult = 'done' | 'failed' | 'awaiting_input';
type LegacySave = 'ok' | 'mismatch' | 'throws';
interface LegacyScenario {
  ask: boolean;
  kind: LegacyKind;
  questionGatePassed: boolean;
  platformFailure: boolean;
  booted: boolean;
  status: SessionStatus;
  local: boolean;
  stopped: boolean;
  cancelAborted: boolean;
  save: LegacySave;
  /** 결과 뒤의 되돌리기가 던진다(옛 코드는 예외 경로에서 한 번 더 되돌렸다) */
  revertThrows: boolean;
}

/**
 * 요청 실행의 끝 결정과 단계 순서(ADR-208, 4f B3b): Rust `outcome`을 옛 `execute`가 같은 사실에 낸 값(`session-run-vectors.json`에 입력별로 고정)과 견준다. `legacy*` 함수는 고정한 값을 꺼내는 껍데기다.
 * 같은 할 일·끝 상태·글의 종류·콜백 순서를 낸다. 다른 것은 아래 "의도한 차이" 칸들뿐이고 목록으로 고정한다.
 */
const counts = { decideNormal: 0, decideException: 0, flows: 0, random: 0, d1Decide: 0, d2Decide: 0, d3Decide: 0, d4Decide: 0, d1Flow: 0, d4Flow: 0 };
afterAll(() => console.log(`[session-run 벡터] ${JSON.stringify(counts)}`));

const STATUSES: SessionStatus[] = ['idle', 'starting', 'ready', 'failed', 'stopped'];
const RESULTS: LegacyResult[] = ['done', 'failed', 'awaiting_input'];
const bools = [false, true];

function prng(seedStart: number): () => number {
  let seed = seedStart;
  return () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff);
}

describe('단계 이름과 순서', () => {
  it('코어가 정한 목록이다', () => {
    expect(runSteps()).toEqual([
      'prepare_edits',
      'announce_edits',
      'plan_brief',
      'run_plan',
      'detach_run',
      'tally_run',
      'note_question',
      'probe_pending',
      'save_checkpoint',
      'after_save',
      'revert_after_mismatch',
      'revert_run',
      'revert_host_only',
      'notice_platform',
      'notice_kept',
      'build_finished',
      'settle',
      'announce_finished',
    ]);
  });
});

describe('결과 뒤의 판정: 사실 조합 전체', () => {
  it('옛 판정과 같다. 다른 칸은 멈춘 세션의 저장과 검증하지 않은 변경을 보는 칸뿐이다', () => {
    for (const ask of bools) for (const result of RESULTS) for (const questionGatePassed of bools) for (const platformFailure of bools) for (const booted of bools) for (const status of STATUSES) for (const local of bools) for (const stopped of bools) {
      const legacyFacts: LegacyNormalFacts = { ask, result, questionGatePassed, platformFailure, booted, status, local };
      const facts = { ...legacyFacts, status, stopped };
      const old = legacyNormal(legacyFacts);
      const got = decideNormal(facts, false);
      counts.decideNormal += 1;
      const same = got.action === old.action && got.status === old.status && got.summary === old.summary;
      if (same) continue;
      // 의도한 차이 D1(결함 3): 멈추는 중이면 새 체크포인트를 남기지 않는다
      expect(old.action, JSON.stringify(facts)).toBe('save');
      expect(stopped, JSON.stringify(facts)).toBe(true);
      expect(got, JSON.stringify(facts)).toEqual({ action: 'none', status: old.status, summary: 'result' });
      counts.d1Decide += 1;
    }
    // 의도한 차이 칸의 수를 고정한다(칸을 지우는 변경도 잡는다): 켠 세션의 done·통과한 질문 × 멈춤 × 그 밖의 값
    expect(counts.decideNormal).toBe(960);
    expect(counts.d1Decide).toBe(60);
  });

  it('검증하지 않은 변경을 보는 칸: 옛 코드가 아무것도 하지 않던 칸에서만 되돌리거나 알린다(결함 1·2)', () => {
    for (const ask of bools) for (const result of RESULTS) for (const questionGatePassed of bools) for (const platformFailure of bools) for (const booted of bools) for (const status of STATUSES) for (const local of bools) for (const stopped of bools) {
      const legacyFacts: LegacyNormalFacts = { ask, result, questionGatePassed, platformFailure, booted, status, local };
      const facts = { ...legacyFacts, stopped };
      const old = legacyNormal(legacyFacts);
      const got = decideNormal(facts, true);
      const probe = needsProbeNormal(facts);
      if (got.action === 'revert_host_only' || got.action === 'notice_kept') {
        // 결함 1·2: 옛 코드는 아무것도 하지 않았다
        expect(probe, JSON.stringify(facts)).toBe(true);
        expect(old.action, JSON.stringify(facts)).toBe('none');
        expect(status === 'ready', JSON.stringify(facts)).toBe(false);
        expect(result === 'awaiting_input' || ask, JSON.stringify(facts)).toBe(false);
        expect(got.action === 'revert_host_only', JSON.stringify(facts)).toBe(!booted);
        expect(got.summary === 'unverified', JSON.stringify(facts)).toBe(!booted && result === 'done');
        counts.d2Decide += 1;
        continue;
      }
      // 그 밖의 칸은 변경이 있든 없든 같다(멈춘 세션의 저장만 다르다)
      if (!probe) expect(decideNormal(facts, false)).toEqual(got);
      if (got.action !== old.action) expect(stopped && old.action === 'save').toBe(true);
    }
    expect(counts.d2Decide).toBe(192);
  });

  it('읽을 필요가 없는 칸은 읽지 않는다: 켠 세션의 done·질문·ready 세션의 되돌리기', () => {
    expect(needsProbeNormal({ ask: false, result: 'done', questionGatePassed: false, platformFailure: false, booted: true, status: 'ready', local: false, stopped: false })).toBe(false);
    expect(needsProbeNormal({ ask: false, result: 'failed', questionGatePassed: false, platformFailure: false, booted: true, status: 'ready', local: false, stopped: false })).toBe(false);
    expect(needsProbeNormal({ ask: true, result: 'failed', questionGatePassed: false, platformFailure: false, booted: false, status: 'idle', local: false, stopped: false })).toBe(false);
    expect(needsProbeNormal({ ask: false, result: 'failed', questionGatePassed: false, platformFailure: false, booted: false, status: 'idle', local: false, stopped: false })).toBe(true);
  });
});

describe('예외 뒤의 판정: 사실 조합 전체', () => {
  it('옛 판정과 같다. 다른 칸은 되돌리기를 시도하지 않은 취소 글과 검증하지 않은 변경을 보는 칸뿐이다', () => {
    for (const ask of bools) for (const cancelAborted of bools) for (const stopped of bools) for (const booted of bools) for (const status of STATUSES) {
      const old = legacyException({ ask, cancelAborted, stopped, status });
      const facts = { ask, cancelled: cancelAborted && !stopped, stopped, booted, status };
      const got = decideException(facts, false);
      counts.decideException += 1;
      if (got.action === old.action && got.status === old.status && got.summary === old.summary) continue;
      // 의도한 차이 D4: 되돌리기를 시도하지 않았는데 "되돌리지 못했습니다: undefined"라고 쓰던 칸
      expect(old.summary, JSON.stringify(facts)).toBe('cancelled_unreverted');
      expect(got, JSON.stringify(facts)).toEqual({ action: 'none', status: 'cancelled', summary: 'cancelled' });
      counts.d4Decide += 1;
      // pending이 참이면 읽는 칸이다
      expect(needsProbeException(facts)).toBe(true);
    }
    expect(counts.decideException).toBe(80);
    expect(counts.d4Decide).toBe(8);
  });

  it('검증하지 않은 변경이 있으면 켜지 않은 세션은 되돌리고, 켠 세션은 되돌리지 않고 알린다', () => {
    for (const ask of bools) for (const cancelAborted of bools) for (const stopped of bools) for (const booted of bools) for (const status of STATUSES) {
      const facts = { ask, cancelled: cancelAborted && !stopped, stopped, booted, status };
      const got = decideException(facts, true);
      const old = legacyException({ ask, cancelAborted, stopped, status });
      if (got.action === 'revert_host_only' || got.action === 'notice_kept') {
        expect(old.action).toBe('none');
        expect(needsProbeException(facts)).toBe(true);
        expect(got.action === 'revert_host_only').toBe(!booted);
        counts.d3Decide += 1;
      } else {
        expect(got.action).toBe(old.action);
      }
    }
    expect(counts.d3Decide).toBe(16);
  });
});

describe('단계 순서: 콜백 순서가 옛 execute와 같다', () => {
  /** 상태를 시나리오 값으로 맞춘 코어. 점유는 요청 하나를 연 뒤다 */
  function open(status: SessionStatus): { life: { native: InstanceType<typeof native.SessionState> }; ticket: number } {
    const state = new native.SessionState('idle');
    const ticket = state.beginRun('r1').token;
    if (status === 'ready' || status === 'failed' || status === 'starting') {
      const request = state.requestBoot();
      if (status !== 'starting') state.bootFinished(request.generation, status === 'ready', status === 'failed' ? '실패' : null);
    }
    return { life: { native: state }, ticket };
  }

  async function runNew(scenario: LegacyScenario): Promise<{ steps: string[]; phases: string[]; status: string; summary: string; busy: boolean }> {
    const { life, ticket } = open(scenario.status);
    const steps: string[] = [];
    const phases: string[] = [];
    let finishedKind = '';
    let finishedStatus = '';
    let inException = false;
    const fail = (message: string) => {
      throw new Error(message);
    };
    const actions = new Proxy({} as RunActions, {
      get: (_, name: string) => (arg: string) => {
        steps.push(name);
        phases.push(life.native.claimView().phase ?? '-');
        switch (name as RunStep) {
          case 'prepare_edits':
            if (scenario.kind === 'prepare_fails') fail('local edits');
            return;
          case 'plan_brief':
            if (scenario.kind === 'plan_fails') fail('plan');
            return;
          case 'run_plan':
            if (scenario.kind === 'run_throws') fail('run');
            if (scenario.cancelAborted) return { cancelRequested: true };
            if (scenario.kind === 'preflight') return { preflight: true };
            return {
              result: scenario.kind as LegacyResult,
              questionGatePassed: scenario.kind === 'awaiting_input' && scenario.questionGatePassed,
              platformFailure: scenario.kind === 'failed' && scenario.platformFailure,
            };
          case 'save_checkpoint':
            if (scenario.save === 'throws') fail('save');
            return { mismatch: scenario.save === 'mismatch' };
          case 'revert_run':
            // 결과 뒤의 되돌리기만 던진다. 예외 경로의 되돌리기는 던지지 않고 이유를 쥔다
            if (scenario.revertThrows && !inException) fail('revert');
            return;
          case 'build_finished':
            finishedKind = arg;
            return;
          case 'settle':
            finishedStatus = arg;
            return;
          default:
            return;
        }
      },
    });
    await runRequest(life, scenario.ask, ticket, actions, {
      signals: () => ({ cancelAborted: scenario.cancelAborted, stopAborted: scenario.stopped, booted: scenario.booted, local: scenario.local }),
      isLocalEdits: () => scenario.kind === 'prepare_fails',
      onError: () => {
        inException = true;
      },
    });
    const keep = steps.map((step) => step !== 'probe_pending');
    return { steps: steps.filter((_, at) => keep[at]), phases: phases.filter((_, at) => keep[at]), status: finishedStatus, summary: finishedKind, busy: life.native.busy };
  }

  function scenarios(): LegacyScenario[] {
    const out = new Map<string, LegacyScenario>();
    const kinds: LegacyKind[] = ['prepare_fails', 'plan_fails', 'run_throws', 'preflight', 'done', 'failed', 'awaiting_input'];
    const saves: LegacySave[] = ['ok', 'mismatch', 'throws'];
    for (const ask of bools) for (const kind of kinds) for (const booted of bools) for (const status of ['idle', 'starting', 'ready', 'failed'] as SessionStatus[]) for (const local of bools) for (const stopped of bools) for (const cancelAborted of bools) for (const questionGatePassed of bools) for (const platformFailure of bools) for (const save of saves) {
      const scenario: LegacyScenario = { ask, kind, questionGatePassed, platformFailure, booted, status, local, stopped, cancelAborted, save, revertThrows: false };
      // 읽지 않는 값은 한 가지로 줄인다(같은 칸을 여러 번 세지 않는다)
      const isResult = kind === 'done' || kind === 'failed' || kind === 'awaiting_input';
      if (!isResult && (questionGatePassed || platformFailure || save !== 'ok')) continue;
      if (kind !== 'awaiting_input' && questionGatePassed) continue;
      if (kind !== 'failed' && platformFailure) continue;
      if (save !== 'ok' && !(booted && !ask && (kind === 'done' || kind === 'awaiting_input'))) continue;
      out.set(JSON.stringify(scenario), scenario);
      // 결과 뒤의 되돌리기가 던지는 칸(옛 코드는 예외 경로에서 한 번 더 되돌렸다)
      if (legacyNormal({ ask, result: kind as LegacyResult, questionGatePassed, platformFailure, booted, status, local }).action === 'revert' && isResult && !cancelAborted) {
        const throwing = { ...scenario, revertThrows: true };
        out.set(JSON.stringify(throwing), throwing);
      }
    }
    return [...out.values()];
  }

  it('성공·취소·예외·LocalEditsError·지문 불일치·질문·샌드박스 쪽 실패·멈춤 칸 전부에서 같은 순서와 끝 상태·글의 종류를 낸다', async () => {
    for (const scenario of scenarios()) {
      const old = legacyFlow(scenario);
      const got = await runNew(scenario);
      counts.flows += 1;
      const label = JSON.stringify(scenario);
      expect(got.busy, label).toBe(false);
      const same = JSON.stringify(got.steps) === JSON.stringify(old.steps) && got.status === old.status && got.summary === old.summary;
      if (same) {
        // 점유의 단계는 `detach_run`부터 저장 중이고(취소를 받았으면 그대로 진행 중), 그 전 단계는 진행 중이다. 끝 알림은 점유를 푼 뒤라 `-`다
        expect(got.phases, label).toEqual([...old.phases.slice(0, -1), '-']);
        continue;
      }
      // 의도한 차이 D1: 멈추는 중이면 새 체크포인트를 남기지 않는다(저장 단계도, 저장 뒤 단계도 하지 않는다)
      const saveCell = scenario.booted && !scenario.ask && (scenario.kind === 'done' || (scenario.kind === 'awaiting_input' && scenario.questionGatePassed)) && !scenario.cancelAborted;
      if (saveCell && scenario.stopped) {
        // 저장하지 않으니 저장이 던져 예외 경로로 가던 칸(둘째 detach_run)도 없다
        const dropped = old.steps.filter((step: string) => step !== 'save_checkpoint' && step !== 'after_save' && step !== 'revert_after_mismatch');
        const expected = scenario.save === 'throws' ? dropped.slice(0, dropped.lastIndexOf('detach_run')).concat(dropped.slice(dropped.lastIndexOf('detach_run') + 1)) : dropped;
        expect(got.steps, label).toEqual(expected);
        expect(got.summary, label).toBe('result');
        expect(got.status, label).toBe(scenario.kind === 'done' ? 'done' : 'awaiting_input');
        counts.d1Flow += 1;
        continue;
      }
      // 의도한 차이 D4: 되돌리기를 시도하지 않은 취소 글
      expect(old.summary, label).toBe('cancelled_unreverted');
      expect(got.summary, label).toBe('cancelled');
      expect(got.steps, label).toEqual(old.steps);
      counts.d4Flow += 1;
    }
    expect(counts.flows).toBe(1360);
    expect(counts.d1Flow).toBe(48);
    expect(counts.d4Flow).toBe(132);
  });

  it('무작위 열: 요청을 잇달아 열고 끝내도 점유는 늘 풀리고, 낡은 표는 새 점유를 풀지 못한다', async () => {
    const next = prng(20_261_116);
    const statuses: SessionStatus[] = ['idle', 'ready'];
    const all = scenarios();
    for (let sequence = 0; sequence < 150; sequence += 1) {
      const staleTickets: number[] = [];
      for (let run = 0; run < 6; run += 1) {
        const scenario = all[next() % all.length]!;
        const { life, ticket } = open(statuses[next() % 2]!);
        if (staleTickets.length > 0) expect(life.native.release(staleTickets[0]! + 1000)).toBe(false);
        const actions = new Proxy({} as RunActions, { get: () => () => undefined });
        await runRequest(life, scenario.ask, ticket, actions, { signals: () => ({ cancelAborted: false, stopAborted: false, booted: true, local: false }), isLocalEdits: () => false, onError: () => {} });
        // 단계가 하나도 사실을 주지 않으면 예외로 끝나지만 점유는 풀린다
        expect(life.native.busy).toBe(false);
        expect(life.native.release(ticket)).toBe(false);
        staleTickets.push(ticket);
        counts.random += 1;
      }
    }
  });
});
