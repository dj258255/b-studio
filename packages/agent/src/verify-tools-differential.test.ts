import { describe, expect, it, vi } from 'vitest';
import type { ContractChange } from './contract-diff';
import { Gen, outcome, readEnvNumber, wellFormed, type Outcome } from './differential-kit';
import {
  asRecord,
  boolean,
  clamp,
  composeServiceNames,
  createMismatchLog,
  httpOriginError,
  httpPathError,
  integer,
  optionalStringArray,
  serviceName,
  serviceOrAddonName,
  string,
  stringArray,
  summarizeApproval,
} from './tools';
import { formatVerificationReport, mentionsDeletedFile, platformFailureOf } from './verify';
import {
  legacyAsRecord,
  legacyBoolean,
  legacyClamp,
  legacyComposeServiceNames,
  legacyCreateMismatchLog,
  legacyFormatVerificationReport,
  legacyHttpOriginError,
  legacyHttpPathError,
  legacyInteger,
  legacyMentionsDeletedFile,
  legacyOptionalStringArray,
  legacyPlatformFailureOf,
  legacyServiceName,
  legacyServiceOrAddonName,
  legacyString,
  legacyStringArray,
  legacySummarizeApproval,
  legacyVerifyOk,
  type LegacyContractCheck,
  type LegacyMismatch,
  type LegacyReport,
  type LegacyServiceCheck,
} from './verify-tools-legacy';
import { native } from '@b-studio/sandbox';

/**
 * 검증 통과 판정과 도구 입력 검사(ADR-191 3단계 3u)를 옛 TS 복사본(verify-tools-legacy.ts)과 같은 무작위 입력으로 견준다.
 * 열린 쪽(옛 실패·거부 → 새 통과·허용) 뒤집힘은 0이어야 한다. 닫는 쪽으로 다른 곳은 모두 의도한 차이이고 시험이 이유를 단언한다.
 * 크기는 VERIFY_TOOLS_CASES 환경 변수로 바꾼다.
 */
const CASES = readEnvNumber('VERIFY_TOOLS_CASES', 20_000);
vi.setConfig({ testTimeout: 600_000 });

const wf = (text: string) => wellFormed(text);
const LONE = ['\ud800', '\udbff', '\udc00', '\udfff', '😀', '\ud83d', '\ude00', '�'];
const NAME_ALPHABET = ['a', 'b', 'c', 'A', '-', '_', '', ' ', ...LONE];

function pickName(g: Gen): string {
  return g.text(NAME_ALPHABET, 1 + g.int(4));
}

/** 시험 대상의 결과를 한 글자열로: 던지면 던짐, 값이면 JSON(-0·NaN 구별) */
function show(o: Outcome | { threw: true; message: string } | { threw: false; value: unknown }): string {
  if (o.threw) return `threw:${'message' in o ? o.message : ''}`;
  const v = o.value;
  if (typeof v === 'number') return `num:${Object.is(v, -0) ? '-0' : String(v)}`;
  return `val:${JSON.stringify(v)}`;
}

function run(fn: () => unknown): { threw: true; message: string } | { threw: false; value: unknown } {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    return { threw: true, message: (error as Error).message };
  }
}

function randomValue(g: Gen, depth = 0): unknown {
  return g.weighted<() => unknown>([
    [6, () => g.text(['a', 'b', '/', '.', ' ', '', ...LONE], g.int(5))],
    [
      6,
      () =>
        g.pick<number>([0, -0, 1, -1, 3, 1.5, -2.5, NaN, Infinity, -Infinity, 2 ** 53, 2 ** 53 + 2, -(2 ** 53), 1e300, 5e-324, 1e21, 0.1, 7, 200, 400]),
    ],
    [2, () => g.chance(0.5)],
    [1, () => null],
    [2, () => undefined],
    [1, () => 5n],
    [1, () => () => 1],
    [1, () => '5'],
    [3, () => (depth > 1 ? [] : g.list(0, 3, () => randomValue(g, depth + 1)))],
    [3, () => (depth > 1 ? ['a'] : g.list(0, 3, () => g.text(['a', 'b', ...LONE], g.int(3))))],
    [1, () => [, 'a']],
    [1, () => new Array(2)],
    [2, () => (depth > 1 ? {} : { a: randomValue(g, depth + 1) })],
    [1, () => ({ toJSON: () => 'x' })],
  ])();
}

const label = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : typeof v === 'function' ? 'fn' : v === undefined ? 'undef' : v)) ?? 'undefined';

const hasHole = (value: unknown): boolean => Array.isArray(value) && (value.length > Object.keys(value).length || value.some((item) => hasHole(item)));

describe('입력 검사(asRecord·string·integer·boolean·stringArray·optionalStringArray)', () => {
  const kinds: Array<[string, (a: Record<string, unknown>, k: string) => unknown, (a: Record<string, unknown>, k: string) => unknown]> = [
    ['string', string, legacyString],
    ['integer', integer, legacyInteger],
    ['boolean', boolean, legacyBoolean],
    ['stringArray', stringArray, legacyStringArray],
    ['optionalStringArray', optionalStringArray, legacyOptionalStringArray],
  ];

  it('옛 구현과 같은 값·같은 오류 글이다. 열린 쪽 뒤집힘 0, 닫는 쪽은 구멍 난 배열·JSON이 아닌 값뿐이다', () => {
    const g = new Gen(11);
    let opened = 0;
    let closed = 0;
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < CASES; i++) {
      const value = randomValue(g);
      const args: Record<string, unknown> = { k: value };
      for (const [kind, now, old] of kinds) {
        const oldOutcome = run(() => old(args, 'k'));
        const newOutcome = run(() => now(args, 'k'));
        if (!oldOutcome.threw && newOutcome.threw) {
          closed += 1;
          // 닫는 쪽 차이의 이유: 구멍 난 배열(옛 every가 건너뜀), toJSON이 값을 바꾸는 객체는 검사 종류에서 이미 거부되는 값이라 여기에 올 수 없다
          expect(hasHole(value), `${kind} ${String(value)}`).toBe(true);
          continue;
        }
        if (oldOutcome.threw && !newOutcome.threw) opened += 1;
        expect(show(newOutcome), `${kind} ${typeof value} ${label(value)}`).toBe(show(oldOutcome));
        if (newOutcome.threw) rejected += 1;
        else accepted += 1;
      }
    }
    console.info(`입력 검사: 받음 ${accepted}, 거부 ${rejected}, 열린 쪽 뒤집힘 ${opened}, 닫는 쪽(구멍) ${closed}`);
    expect(opened).toBe(0);
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(0);
  });

  it('asRecord: 객체만 받고 복사본은 값(-0·NaN·짝 없는 서로게이트)을 그대로 지닌다', () => {
    const g = new Gen(12);
    let accepted = 0;
    for (let i = 0; i < CASES; i++) {
      const value = g.chance(0.5) ? { k: randomValue(g), n: g.pick([-0, NaN, Infinity, 1]), s: g.text(LONE, 3) } : randomValue(g);
      const oldOutcome = run(() => legacyAsRecord(value));
      const newOutcome = run(() => asRecord(value));
      if (oldOutcome.threw) {
        expect(newOutcome.threw, String(value)).toBe(true);
        expect(newOutcome.threw && newOutcome.message).toBe(oldOutcome.message);
        continue;
      }
      if (newOutcome.threw) {
        // 닫는 쪽: JSON으로 복사하면 객체가 아니게 되는 값(toJSON이 글자를 돌려줌)이나 복사할 수 없는 값(BigInt)
        expect(label(value).includes('toJSON') || label(value).includes('n"') || JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? 'big' : v)).includes('big') || typeof (value as { toJSON?: unknown }).toJSON === 'function', label(value)).toBe(true);
        continue;
      }
      accepted += 1;
      const copy = (newOutcome as { value: Record<string, unknown> }).value;
      const original = oldOutcome.value as Record<string, unknown>;
      expect(Object.is(copy.n, original.n), label([copy, original])).toBe(true);
      expect(copy.s).toBe(original.s);
    }
    expect(accepted).toBeGreaterThan(0);
  });
});

describe('clamp', () => {
  it('Math.min/max와 같다(NaN·±Infinity·-0·경계)', () => {
    const g = new Gen(13);
    const numbers = [0, -0, 1, -1, 6, 200, 400, NaN, Infinity, -Infinity, 2 ** 53, 1e300, 0.5, -0.5];
    let nan = 0;
    for (let i = 0; i < CASES; i++) {
      const [value, min, max] = [g.pick(numbers), g.pick(numbers), g.pick(numbers)];
      const old = legacyClamp(value, min, max);
      const now = clamp(value, min, max);
      expect(Object.is(now, old), `${value} ${min} ${max}`).toBe(true);
      if (Number.isNaN(old)) nan += 1;
    }
    expect(nan).toBeGreaterThan(0);
  });
});

describe('서비스 허용 목록(여는 쪽)', () => {
  it('옛 구현과 같고, 허용된 이름 쌍(열린 쪽 뒤집힘)이 0이다. 짝 없는 서로게이트·U+FFFD도 합쳐지지 않는다', () => {
    const g = new Gen(14);
    let opened = 0;
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < CASES; i++) {
      const managed = g.list(0, 3, () => pickName(g));
      const hasCompose = g.chance(0.6);
      const compose = hasCompose ? [...managed.filter(() => g.chance(0.7)), ...g.list(0, 2, () => pickName(g))] : undefined;
      const project = { managed: managed.map((name) => [name, {}] as const), ...(compose ? { composeServices: compose } : {}) };
      const asked = g.chance(0.6) ? g.pick([...managed, ...(compose ?? []), 'x']) : pickName(g);
      const args = { service: asked };
      const ctx = { project } as never;
      for (const [now, old] of [
        [serviceName, legacyServiceName],
        [serviceOrAddonName, legacyServiceOrAddonName],
      ] as const) {
        const oldOutcome = run(() => old({ project }, args));
        const newOutcome = run(() => now(ctx, args));
        if (oldOutcome.threw && !newOutcome.threw) opened += 1;
        expect(show(newOutcome), JSON.stringify([project, asked])).toBe(show(oldOutcome));
        if (newOutcome.threw) denied += 1;
        else allowed += 1;
      }
      expect(composeServiceNames(project as never).map(wf)).toEqual(legacyComposeServiceNames(project).map(wf));
    }
    console.info(`서비스 허용 목록: 허용 ${allowed}, 거부 ${denied}, 열린 쪽 뒤집힘 ${opened}`);
    expect(opened).toBe(0);
    expect(allowed).toBeGreaterThan(0);
    expect(denied).toBeGreaterThan(0);
  });
});

describe('summarizeApproval', () => {
  it('옛 구현과 같다(짝 없는 서로게이트만 U+FFFD)', () => {
    const g = new Gen(15);
    const names = ['run_in_service', 'write_file', 'edit_file', 'delete_file', 'read_file', 'x'];
    let withInput = 0;
    for (let i = 0; i < CASES; i++) {
      const input = g.weighted<() => unknown>([
        [4, () => ({ service: randomValue(g), command: randomValue(g), path: randomValue(g) })],
        [2, () => ({ service: g.text(['a', ' ', ...LONE], 2), command: g.list(0, 3, () => g.text(['ls', '-l', ...LONE], 1)), path: g.text(['a', '/', ...LONE], 3) })],
        [1, () => randomValue(g)],
        [1, () => []],
      ])();
      const name = g.pick(names);
      const old = run(() => legacySummarizeApproval(name, input));
      const now = run(() => summarizeApproval(name, input));
      // 옛 구현이 던지지 않는 입력에서 같아야 한다(옛 구현은 던지는 입력이 없다)
      expect(old.threw).toBe(false);
      expect(now.threw).toBe(false);
      if (!old.threw && !now.threw) {
        const text = old.value as string;
        // BigInt·함수가 든 입력은 JSON으로 복사할 수 없어 도구 이름만 보여 준다(표시용이다)
        if (now.value === name && text !== name) continue;
        expect(now.value, label([name, input])).toBe(wf(text));
        if (text !== name) withInput += 1;
      }
    }
    expect(withInput).toBeGreaterThan(0);
  });
});

describe('createMismatchLog', () => {
  it('옛 구현과 같은 기록과 같은 응답이다(상한·같은 기록 버리기)', () => {
    const g = new Gen(16);
    let added = 0;
    let dropped = 0;
    for (let round = 0; round < Math.max(50, CASES / 20); round++) {
      const oldLog = legacyCreateMismatchLog();
      const newLog = createMismatchLog();
      for (let step = 0; step < 12; step++) {
        const mismatch: LegacyMismatch = {
          requestValue: g.text(['a', 'b', ...LONE], g.int(2)),
          checkValue: g.text(['a', 'b', ...LONE], g.int(2)),
          followed: g.pick(['request', 'check', 'neither'] as const),
          note: 'n',
        };
        const a = oldLog.add(mismatch);
        const b = newLog.add(mismatch);
        expect(b, JSON.stringify(mismatch)).toBe(a);
        if (a) added += 1;
        else dropped += 1;
      }
      expect(newLog.list).toEqual(oldLog.list);
    }
    expect(added).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
  });
});

describe('httpRequest의 경로·origin 확인(여는 쪽)', () => {
  it('열린 쪽 뒤집힘 0, 닫는 쪽은 origin이 "null"인 끝점뿐이다', () => {
    const g = new Gen(17);
    const pieces = ['/', 'a', '//', 'evil.com', '\\', '@', ':', '.', '..', '%2e', '?', '#', ' ', 'http:', 'x/'];
    const endpoints = ['http://127.0.0.1:1', 'http://127.0.0.1:1/web/', 'https://a.example', 'http://[::1]:8080', 'http://localhost', 'foo://bar', 'http://a:1'];
    let same = 0;
    let other = 0;
    let closedNull = 0;
    for (let i = 0; i < CASES; i++) {
      const requestPath = g.chance(0.8) ? `/${g.text(pieces, g.int(6))}` : g.text(pieces, g.int(5));
      const endpoint = g.pick(endpoints);
      expect(httpPathError(requestPath)).toBe(legacyHttpPathError(requestPath));
      if (legacyHttpPathError(requestPath)) continue;
      const old = run(() => legacyHttpOriginError(requestPath, endpoint));
      const now = run(() => httpOriginError(new URL(requestPath, endpoint), endpoint));
      if (old.threw || now.threw) {
        expect(now.threw).toBe(old.threw);
        continue;
      }
      if (old.value !== undefined && now.value === undefined) throw new Error(`열린 쪽: ${requestPath} ${endpoint}`);
      if (old.value === undefined && now.value !== undefined) {
        closedNull += 1;
        expect(new URL(endpoint).origin).toBe('null');
        continue;
      }
      if (now.value === undefined) same += 1;
      else other += 1;
    }
    console.info(`origin: 같음 ${same}, 다름 ${other}, 닫는 쪽(null origin) ${closedNull}`);
    expect(same).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(0);
    expect(closedNull).toBeGreaterThan(0);
  });
});

function pickCheck(g: Gen, service: string): LegacyServiceCheck {
  const ready = g.chance(0.5);
  return {
    service,
    ready,
    ...(g.chance(0.5) ? { error: g.pick(['x', 'a\nb', '', 'ENOENT: nope', 'c\ud800d']) } : {}),
    ...(g.chance(0.3) ? { platform: true as const } : {}),
    ...(g.chance(0.3) ? { retried: true } : {}),
    ...(g.chance(0.4) ? { logTail: g.list(0, 3, () => g.pick(['line', '', 'No such file x', 'z\udc00'])) } : {}),
    ...(g.chance(0.3) ? { blockedEgress: g.list(0, 2, () => g.pick(['GET a.com:443 (deny)', 'h:1'])) } : {}),
  };
}

function pickChanges(g: Gen): ContractChange[] {
  return g.list(0, 3, () => ({
    kind: g.pick(['operation-added', 'operation-removed', 'property-removed'] as const),
    target: g.pick(['GET /a', 'Order.memo', 'T\ud800']),
    breaking: g.chance(0.5),
    ...(g.chance(0.4) ? { detail: g.pick(['d', 'string → integer']) } : {}),
  }));
}

describe('검증 통과(ok) 계산', () => {
  it('열린 쪽(옛 실패 → 새 통과) 뒤집힘 0, 닫는 쪽은 빈 이유의 계약 추출 실패뿐이다', () => {
    const g = new Gen(18);
    let opened = 0;
    let closed = 0;
    let passed = 0;
    let failed = 0;
    for (let i = 0; i < CASES; i++) {
      const restarted = g.list(0, 3, () => pickCheck(g, 's'));
      const contracts: LegacyContractCheck[] = g.list(0, 3, () => ({
        service: 'c',
        changes: pickChanges(g),
        ...(g.chance(0.3) ? { error: g.pick(['', 'HTTP 500', 'x']) } : {}),
      }));
      const allowBreaking = g.chance(0.4);
      const leaks = g.list(0, g.chance(0.2) ? 2 : 0, () => 'leak');
      const specError = g.chance(0.15) ? g.pick(['', 'bad']) : undefined;
      const old = legacyVerifyOk(restarted, contracts, allowBreaking, leaks, specError);
      const now = native.verifyOk(
        restarted.map((check) => check.ready === true),
        contracts.map((check) => check.error !== undefined),
        contracts.flatMap((check) => check.changes.map((change) => Boolean(change.breaking))),
        allowBreaking,
        leaks.length,
        specError !== undefined,
      );
      if (!old && now) opened += 1;
      if (old && !now) {
        closed += 1;
        expect(contracts.some((check) => check.error === ''), JSON.stringify([restarted, contracts, specError])).toBe(true);
      } else {
        expect(now).toBe(old);
      }
      if (now) passed += 1;
      else failed += 1;
    }
    console.info(`ok: 통과 ${passed}, 실패 ${failed}, 열린 쪽 뒤집힘 ${opened}, 닫는 쪽(빈 이유) ${closed}`);
    expect(opened).toBe(0);
    expect(passed).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(0);
  });
});

describe('platformFailureOf·mentionsDeletedFile', () => {
  it('platformFailureOf는 옛 구현과 같다', () => {
    const g = new Gen(19);
    let found = 0;
    for (let i = 0; i < CASES; i++) {
      const sync: LegacyReport['sync'] = g.chance(0.4) ? { error: g.pick(['e1\ne2', 'boom', '', 'p\ud800']), ...(g.chance(0.6) ? { platform: true as const } : {}) } : { elapsedMs: 5 };
      const restarted = g.list(0, 3, () => pickCheck(g, g.pick(['api', 'web', 's\udc00'])));
      const old = legacyPlatformFailureOf(sync, restarted);
      const now = platformFailureOf(sync, restarted);
      expect(now, JSON.stringify([sync, restarted])).toBe(old === undefined ? undefined : wf(old));
      if (old !== undefined) found += 1;
    }
    expect(found).toBeGreaterThan(0);
  });

  it('mentionsDeletedFile: 열린 쪽(옛 false → 새 true) 뒤집힘 0, 닫는 쪽은 짝의 일부인 서로게이트뿐이다', () => {
    const g = new Gen(20);
    const words = ['a.sql', 'V2', '/', 'No such file', 'NoSuchFile', 'NO SUCH FILE', 'no such\tfile', 'nosuchfile', 'ſ', 'K', ' ', '', ...LONE];
    let opened = 0;
    let closed = 0;
    let truthy = 0;
    for (let i = 0; i < CASES; i++) {
      const deleted = g.list(0, 2, () => g.text(['a', '.', 'sql', '/', 'V2', ...LONE], g.int(5)));
      const lines = g.list(0, 3, () => g.text(words, g.int(6)));
      if (g.chance(0.4) && deleted.length > 0) lines.push(`${path(deleted[0]!)} ${g.pick(['No such file', 'NoSuchFileException', 'no such file or directory', 'nope'])}`);
      const old = legacyMentionsDeletedFile(lines, deleted);
      const now = mentionsDeletedFile(lines, deleted);
      if (!old && now) opened += 1;
      if (old && !now) {
        closed += 1;
        expect([...lines, ...deleted].some((text) => /[\ud800-\udfff]/.test(text)), JSON.stringify([lines, deleted])).toBe(true);
      }
      if (now) truthy += 1;
    }
    console.info(`mentionsDeletedFile: 참 ${truthy}, 열린 쪽 뒤집힘 ${opened}, 닫는 쪽(서로게이트 짝) ${closed}`);
    expect(opened).toBe(0);
    expect(truthy).toBeGreaterThan(0);
  });
});

function path(file: string): string {
  return file.split('/').pop() ?? file;
}

describe('formatVerificationReport', () => {
  function randomReport(g: Gen): LegacyReport {
    const sync: LegacyReport['sync'] = g.chance(0.25) ? { error: g.pick(['e1\ne2', 'boom', 'p\ud800']) } : { elapsedMs: g.pick([0, 1200, 55, 1_234_567, 0.5, NaN, Infinity, 2500]) };
    return {
      ok: g.chance(0.5),
      sync,
      restarted: g.list(0, 3, () => pickCheck(g, g.pick(['api', 'web', 's\udc00']))),
      ...(g.chance(0.3) ? { platformFailure: g.pick(['db 문제', 'p\ud800']) } : {}),
      contracts: g.list(0, 3, () => ({ service: 'api', changes: pickChanges(g), ...(g.chance(0.2) ? { error: g.pick(['HTTP 500', 'x\ny']) } : {}) })),
      unverifiedFiles: g.list(0, 2, () => g.pick(['a.txt', 'b'])),
      secretLeaks: g.list(0, 2, () => ({ file: 'f.env', secrets: g.list(0, 2, () => g.pick(['TOKEN', 'KEY'])) })),
      skippedOff: g.list(0, 2, () => g.pick(['db', 'cache'])),
      ...(g.chance(0.3) ? { specError: g.pick(['bad\nworse', 'x']) } : {}),
      ...(g.chance(0.3) ? { addedAddons: g.list(0, 2, () => g.pick(['mediamtx', 'redis'])) } : {}),
      ...(g.chance(0.2) ? { addonError: 'nope' } : {}),
    };
  }

  it('옛 구현과 같은 글이다(짝 없는 서로게이트만 U+FFFD)', () => {
    const g = new Gen(21);
    let passText = 0;
    let failText = 0;
    for (let i = 0; i < CASES; i++) {
      const report = randomReport(g);
      const allowBreaking = g.chance(0.5);
      const old = legacyFormatVerificationReport(report, { allowBreaking });
      const now = formatVerificationReport(report as never, { allowBreaking });
      expect(now, JSON.stringify(report)).toBe(wf(old));
      if (now.startsWith('검증 통과')) passText += 1;
      else failText += 1;
    }
    console.info(`보고서 글: 통과 ${passText}, 실패 ${failText}`);
    expect(passText).toBeGreaterThan(0);
    expect(failText).toBeGreaterThan(0);
  });

  it('대조 장치: 결과 한 글자를 바꾼 옛 구현은 차이로 잡힌다', () => {
    const g = new Gen(22);
    let caught = 0;
    for (let i = 0; i < 200; i++) {
      const report = randomReport(g);
      const old = legacyFormatVerificationReport(report, { allowBreaking: false });
      if (wf(`${old}.`) !== formatVerificationReport(report as never, { allowBreaking: false })) caught += 1;
    }
    expect(caught).toBe(200);
  });
});
