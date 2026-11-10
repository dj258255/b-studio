import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeUsageTracker, describeResultFailure, isTransientNetworkFailure, mcpSetupFailure, noResultMessage, resolveCompactWindow } from './claude-code-runner';
import * as legacy from './claude-code-runner-legacy';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, wellFormed, type Outcome } from './differential-kit';

/**
 * 러너 판정·사용량(ADR-191 3ac)을 Rust로 옮기면서 옛 TS(`claude-code-runner-legacy.ts`)와 새 껍데기에 같은 무작위 입력(모양이 어긋난 입력 포함)을 넣어 결과를 JSON 글자로 견준다. 지우지 않는다.
 *
 * 열린 쪽 뒤집힘(닫는 쪽 판정): describeResultFailure·mcpSetupFailure에서 옛 구현이 실패(문자열)로 읽거나 던졌는데 새 구현이 성공(undefined)으로 읽은 수. 0이어야 한다.
 * 닫는 쪽 차이(옛 구현은 성공으로 읽었는데 새 구현은 실패)는 이름이 없거나 문자열이 아닌 오류 항목이 든 입력에서만 나와야 한다. 그 밖의 차이는 0이어야 한다.
 * 던짐 → 실패 문자열은 의도한 차이다(옛 구현이 던진 모양이 어긋난 입력).
 *
 * 크기는 환경 변수: RUNNER_DIFF_SEEDS, RUNNER_DIFF_ITERATIONS, RUNNER_DIFF_REPORT=<파일>
 */
const SEEDS = readEnvList('RUNNER_DIFF_SEEDS', [1, 2, 3]);
const ITERATIONS = readEnvNumber('RUNNER_DIFF_ITERATIONS', 4000);
const REPORT = process.env['RUNNER_DIFF_REPORT'];

const LONE = ['\ud800', '\udbff', '\udc00', '\udfff'];
const TEXTS = ['', ' ', 'x', 'boom', '한글', '😀', 'a\nb', 'ENOTFOUND', 'overloaded', ...LONE.map((c) => `t${c}`)];

function scalar(g: Gen): unknown {
  return g.pick([undefined, null, true, false, 0, 1, -1, 1.5, '', 'x', 'false', 'success', [], [1], {}, { a: 1 }, Number.NaN, -0, 'success ']);
}

function resultMessage(g: Gen): unknown {
  const message: Record<string, unknown> = {};
  const subtype = g.weighted<unknown>([[10, 'success'], [3, 'error_max_turns'], [2, 'error_max_budget_usd'], [3, 'error_during_execution'], [2, 'Success'], [1, ' success'], [1, 'success\u0000'], [2, undefined], [1, null], [1, 5], [1, 'error_max_turns2']]);
  if (subtype !== undefined) message['subtype'] = subtype;
  if (g.chance(0.5)) message['is_error'] = g.chance(0.5) ? g.pick([true, false]) : scalar(g);
  if (g.chance(0.5)) message['result'] = g.chance(0.6) ? g.pick(TEXTS) : scalar(g);
  if (g.chance(0.4)) message['stop_reason'] = g.chance(0.5) ? g.pick(['refusal', 'end_turn', 'Refusal', 'refusal ', null, 'max_tokens']) : scalar(g);
  if (g.chance(0.5)) message['errors'] = g.chance(0.6) ? g.list(0, 3, () => (g.chance(0.8) ? g.pick(TEXTS) : scalar(g))) : scalar(g);
  return message;
}

function mcpName(g: Gen): unknown {
  return g.weighted<unknown>([[10, 'b-studio'], [3, 'other'], [1, 'B-Studio'], [1, 'b-studio '], [1, 'b-studio-x'], [1, ''], [1, null], [1, 5], [1, undefined], [1, true]]);
}

function mcpEntry(g: Gen, kind: 'server' | 'error'): unknown {
  if (g.chance(0.04)) return g.pick([null, 5, 'x', true, []]);
  const entry: Record<string, unknown> = {};
  const name = mcpName(g);
  if (name !== undefined) entry['name'] = name;
  if (kind === 'server') {
    if (g.chance(0.9)) entry['status'] = g.weighted<unknown>([[10, 'connected'], [3, 'failed'], [2, 'pending'], [1, 'needs-auth'], [1, 'disabled'], [1, 'Connected'], [1, 'connected '], [1, ''], [1, null], [1, 0], [1, 'x']]);
  } else {
    if (g.chance(0.6)) entry['message'] = g.chance(0.8) ? g.pick(TEXTS) : scalar(g);
    if (g.chance(0.4)) entry['type'] = g.chance(0.8) ? g.pick(['timeout', 'spawn', '']) : scalar(g);
  }
  return entry;
}

function mcpMessage(g: Gen): unknown {
  const message: Record<string, unknown> = {};
  if (g.chance(0.93)) message['mcp_servers'] = g.chance(0.95) ? g.list(0, 3, () => mcpEntry(g, 'server')) : scalar(g);
  if (g.chance(0.5)) message['mcp_server_errors'] = g.chance(0.93) ? g.list(0, 2, () => mcpEntry(g, 'error')) : scalar(g);
  if (g.chance(0.5) && Array.isArray(message['mcp_servers'])) message['mcp_servers'] = [{ name: 'b-studio', status: 'connected' }, ...(message['mcp_servers'] as unknown[])];
  return message;
}

const hasNonStringErrorName = (message: unknown): boolean => {
  const errors = (message as { mcp_server_errors?: unknown }).mcp_server_errors;
  return Array.isArray(errors) && errors.some((entry) => entry !== null && typeof entry === 'object' && 'name' in (entry as object) && typeof (entry as { name: unknown }).name !== 'string' && (entry as { name: unknown }).name !== undefined);
};

interface GateTally {
  runs: number;
  differ: number;
  openFlips: number;
  throwToFailure: number;
  closedFlips: number;
  unexplained: number;
  dist: Record<string, number>;
}

const gateTally = (): GateTally => ({ runs: 0, differ: 0, openFlips: 0, throwToFailure: 0, closedFlips: 0, unexplained: 0, dist: {} });

function gateStep(tally: GateTally, rawOld: Outcome, newOut: Outcome, explainsClosed: boolean): void {
  // 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(표시용 글이라 의도한 차이)
  const oldOut: Outcome = rawOld.threw ? rawOld : { threw: false, value: wellFormed(rawOld.value) };
  tally.runs += 1;
  const kind = oldOut.threw ? 'throw' : oldOut.value === undefined ? 'success' : 'failure';
  tally.dist[kind] = (tally.dist[kind] ?? 0) + 1;
  if (JSON.stringify(oldOut) === JSON.stringify(newOut)) return;
  tally.differ += 1;
  const newSuccess = !newOut.threw && newOut.value === undefined;
  if ((oldOut.threw || oldOut.value !== undefined) && newSuccess) tally.openFlips += 1;
  else if (oldOut.threw) tally.throwToFailure += 1;
  else if (!newOut.threw && typeof newOut.value === 'string' && (oldOut.value === undefined || typeof oldOut.value === 'string')) {
    // 성공 → 실패, 또는 실패 → 설명이 다른 실패(이름 없는 오류 항목이 이 서버의 오류로 세어져 설명의 첫 오류가 바뀐다)
    if (explainsClosed) tally.closedFlips += 1;
    else tally.unexplained += 1;
  } else tally.unexplained += 1;
}

function report(line: string): void {
  if (REPORT) appendFileSync(REPORT, `${line}\n`);
}

describe('러너 판정 차등 시험', () => {
  it('결과 메시지·도구 서버 판정: 열린 쪽 뒤집힘 0', () => {
    for (const seed of SEEDS) {
      const g = new Gen(seed);
      const desc = gateTally();
      const mcp = gateTally();
      for (let i = 0; i < ITERATIONS; i++) {
        const message = resultMessage(g);
        gateStep(desc, outcome(() => legacy.describeResultFailure(message as never)), outcome(() => describeResultFailure(message as never)), false);
        const init = mcpMessage(g);
        gateStep(mcp, outcome(() => legacy.mcpSetupFailure(init as never)), outcome(() => mcpSetupFailure(init as never)), hasNonStringErrorName(init));
      }
      report(`runner-judge seed=${seed} describe=${JSON.stringify(desc)} mcp=${JSON.stringify(mcp)}`);
      for (const [name, tally] of [['describeResultFailure', desc], ['mcpSetupFailure', mcp]] as const) {
        expect(tally.openFlips, `${name} 열린 쪽 뒤집힘 seed=${seed}`).toBe(0);
        expect(tally.unexplained, `${name} 이유 없는 차이 seed=${seed}`).toBe(0);
        expect(tally.dist['success'] ?? 0, `${name} 성공 입력`).toBeGreaterThan(0);
        expect(tally.dist['failure'] ?? 0, `${name} 실패 입력`).toBeGreaterThan(0);
      }
      expect(mcp.dist['throw'] ?? 0, '던지는 입력이 있어야 한다').toBeGreaterThan(0);
    }
  });

  it('값을 내는 판정(네트워크·압축 창·결과 없음)은 옛 구현과 같다', () => {
    for (const seed of SEEDS) {
      const g = new Gen(seed);
      const dist = { transientTrue: 0, transientFalse: 0, windowNull: 0, windowIgnored: 0, windowValue: 0, noResult: 0 };
      for (let i = 0; i < ITERATIONS; i++) {
        const text = g.text([...'abcEOVNTFZRDSL_ ', 'ō', 'ſ', 'K', '\u0085'], g.int(14));
        const message = g.pick(['', ' ', 'ENOTFOUND', 'econnreset x', 'overloaded', 'a overloaded b', 'overloaded_error', "Can't reach the API server", 'xoverloadedx', '_overloaded_', 'ETIMEDOUT.', 'EAI_AGAIN', text, `${text}overloaded${text}`, `${text}ENOTFOUND${text}`]);
        const transient = legacy.isTransientNetworkFailure(message);
        expect(isTransientNetworkFailure(message), JSON.stringify(message)).toBe(transient);
        dist[transient ? 'transientTrue' : 'transientFalse'] += 1;

        const raw = g.pick<string | undefined>([undefined, '', '0', 'off', 'OFF', '50000', '49999', '60000', '9007199254740991', '9007199254740992', '1e5', '0050000', ' 70000 ', 'abc', text, `${g.int(300000)}`, `${g.int(10)}`, `${g.int(1000000000)}0000000`, `\u0085${g.int(100000)}`, `${g.int(100000)}.${g.int(10)}`]);
        const oldWindow = legacy.resolveCompactWindow(raw);
        expect(JSON.stringify(resolveCompactWindow(raw)), JSON.stringify(raw)).toBe(JSON.stringify(oldWindow));
        if (oldWindow.window === null) dist.windowNull += 1;
        else if (oldWindow.ignored) dist.windowIgnored += 1;
        else dist.windowValue += 1;

        const exit = g.chance(0.1)
          ? undefined
          : {
              code: g.pick<number | null>([null, 0, 1, 2, -1, 130, 1.5]),
              signal: g.pick<NodeJS.Signals | null>([null, null, 'SIGTERM', 'SIGKILL']),
              ...(g.chance(0.2) ? { error: Object.assign(new Error(g.pick(['spawn x ENOENT', '', 'a\nb', ...TEXTS])), { code: 'ENOENT' }) } : {}),
              stderr: g.list(0, 6, () => g.pick(['', 'a', ' b ', 'line', '\r', ...TEXTS])).join(g.pick(['\n', '\n', '\r\n', ' ', ''])),
            };
        expect(noResultMessage(exit), `noResultMessage ${i}`).toBe(wellFormed(legacy.noResultMessage(exit)));
        dist.noResult += 1;
      }
      report(`runner-values seed=${seed} ${JSON.stringify(dist)}`);
      for (const [key, count] of Object.entries(dist)) expect(count, key).toBeGreaterThan(0);
    }
  });

  it('사용량: 합·모델별·합치기가 옛 구현과 같다', () => {
    const num = (g: Gen): unknown => g.weighted<unknown>([[10, g.int(100000)], [3, undefined], [2, null], [2, g.int(1000) / 8], [1, 0], [1, -0], [1, -5], [1, 1e300], [1, Number.NaN], [1, Number.POSITIVE_INFINITY]]);
    for (const seed of SEEDS) {
      const g = new Gen(seed);
      const MODELS = ['claude-a', 'claude-b', 'x', '1', '2', 'モデル', ''];
      let withModels = 0;
      let empty = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const modelUsage: Record<string, unknown> = {};
        for (const model of g.list(0, 3, () => g.pick(MODELS))) {
          const entry: Record<string, unknown> = {};
          for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) if (g.chance(0.8)) entry[key] = num(g);
          modelUsage[model] = entry;
        }
        const message = g.chance(0.1) ? {} : { modelUsage };
        const a = new legacy.ClaudeCodeUsageTracker();
        const b = new ClaudeCodeUsageTracker();
        a.observeResult(message as never);
        b.observeResult(message as never);
        expect(JSON.stringify(b.usage), `합 ${i}`).toBe(JSON.stringify(a.usage));
        expect(Object.is(b.usage.inputTokens, a.usage.inputTokens) && Object.is(b.usage.outputTokens, a.usage.outputTokens), `합(-0·NaN) ${i}`).toBe(true);
        expect(JSON.stringify(b.usageByModel), `모델별 ${i}`).toBe(JSON.stringify(a.usageByModel));
        if (Object.keys(a.usageByModel).length > 0) withModels += 1;
        else empty += 1;
      }
      report(`runner-usage seed=${seed} withModels=${withModels} empty=${empty}`);
      expect(withModels).toBeGreaterThan(0);
      expect(empty).toBeGreaterThan(0);
    }
  });

  it('대조 장치: 결과를 한 글자 바꾼 옛 구현은 차이로 잡힌다', () => {
    const g = new Gen(99);
    let caught = 0;
    let total = 0;
    for (let i = 0; i < 300; i++) {
      const message = resultMessage(g) as never;
      const old = outcome(() => legacy.describeResultFailure(message));
      const now = outcome(() => describeResultFailure(message));
      if (old.threw) continue;
      total += 1;
      const changed: Outcome = { threw: false, value: perturb(old.value === undefined ? 'x' : old.value) };
      if (!sameOutcome(changed, now)) caught += 1;
      expect(sameOutcome(old, now)).toBe(true);
    }
    expect(total).toBeGreaterThan(100);
    expect(caught).toBe(total);
    // 경계를 ±1 바꾼 압축 창도 차이로 잡힌다
    expect(resolveCompactWindow('49999').ignored).toBeDefined();
    expect(resolveCompactWindow('50000').ignored).toBeUndefined();
  });
});
