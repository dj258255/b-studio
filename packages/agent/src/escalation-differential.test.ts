import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canRead, type Reader, type Topology } from './coordination/topology';
import { noteBytes, type Note } from './coordination/notes';
import {
  failureNotesFromEvents,
  failureNotesFromReport,
  normalizeMessage,
  signatureFromCheck,
  signatureKey,
  signaturesFromReport,
  type FailureEvent,
  type FailureNoteInput,
  type FailureSignature,
} from './coordination/signature';
import {
  DEFAULT_ESCALATION_RETRY_BUDGET,
  DEFAULT_SAME_SIGNATURE_TIMES,
  escalationPrompt,
  retryBudgetFor,
  shouldEscalate,
  shouldPromote,
  signatureSetKey,
  type EscalationPolicy,
} from './escalation';
import type { VerificationReport } from './verify';
import type { WorkflowCheck } from './workflow';

/**
 * coordination(signature·notes·topology)과 escalation을 Rust로 옮기면서(ADR-191 3i) 옛 TS 구현을 아래 `legacy`에 그대로 두고,
 * 같은 무작위 입력을 옛 구현과 새 껍데기에 넣어 결과를 JSON.stringify 글자(키 순서 포함)로 견준다. `legacy`는 옮기기 전
 * `coordination/signature.ts`·`notes.ts`·`topology.ts`·`escalation.ts`의 본문이다(`export`만 뗐다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 크기는 환경 변수로 바꾼다: ESCALATION_DIFF_SEEDS(쉼표 목록), ESCALATION_DIFF_ITERATIONS, ESCALATION_DIFF_REPORT=<파일 경로>(시드마다 비교 수·분포를 그 파일에 덧붙인다.
 * 통과한 시험의 console 출력은 vitest가 보여 주지 않아 파일로 남긴다)
 */
const legacy = (() => {
  function signatureKey(signature: FailureSignature): string {
    return [signature.stage, signature.service ?? '', signature.message, (signature.files ?? []).join(',')].join('|');
  }

  function normalizeMessage(text: string): string {
    return text
      .split('\n', 1)[0]!
      .trim()
      .replace(/\b[0-9a-f]{7,}\b/gi, 'H')
      .replace(/\d+/g, 'N')
      .slice(0, 200);
  }

  function signaturesFromReport(report: VerificationReport): FailureSignature[] {
    const signatures: FailureSignature[] = [];
    for (const check of report.restarted) {
      if (check.ready) continue;
      signatures.push({
        stage: 'run',
        service: check.service,
        message: normalizeMessage(check.error ?? check.logTail?.[0] ?? '서비스를 준비하지 못했습니다'),
      });
    }
    for (const check of report.contracts) {
      const breaking = check.changes.filter((change) => change.breaking);
      if (!check.error && breaking.length === 0) continue;
      const message = check.error ?? breaking.map((change) => `${change.kind} ${change.target}${change.detail ? `: ${change.detail}` : ''}`).join('; ');
      signatures.push({ stage: 'contract_check', service: check.service, message: normalizeMessage(message) });
    }
    if ('error' in report.sync) signatures.push({ stage: 'sync', message: normalizeMessage(report.sync.error) });
    for (const leak of report.secretLeaks) {
      signatures.push({ stage: 'secret_leak', message: normalizeMessage(`${leak.file}: ${leak.secrets.join(', ')}`), files: [leak.file] });
    }
    return signatures;
  }

  function signatureFromCheck(check: WorkflowCheck): FailureSignature {
    return { stage: check.stage, message: normalizeMessage(check.detail ?? check.name) };
  }

  function failureNotesFromReport(report: VerificationReport, checks: readonly WorkflowCheck[] = []): FailureNoteInput[] {
    const signatures = [...signaturesFromReport(report), ...checks.filter((check) => !check.ok).map(signatureFromCheck)];
    return signatures.map(toNoteInput);
  }

  function failureNotesFromEvents(events: readonly FailureEvent[]): FailureNoteInput[] {
    const signatures: FailureSignature[] = [];
    for (const event of events) {
      const agent = event.event;
      if (!agent) continue;
      if (agent.type === 'verify_result' && agent.report) signatures.push(...signaturesFromReport(agent.report));
      else if (agent.type === 'workflow_check' && agent.check && !agent.check.ok) signatures.push(signatureFromCheck(agent.check));
    }
    return signatures.map(toNoteInput);
  }

  function toNoteInput(signature: FailureSignature): FailureNoteInput {
    return { kind: 'failure', body: formatSignature(signature), refs: signature.files ? [...signature.files] : [] };
  }

  function formatSignature(signature: FailureSignature): string {
    const where = signature.service ? `${signature.stage} ${signature.service}` : signature.stage;
    return `[${where}] ${signature.message}`;
  }

  function noteBytes(body: string): number {
    return Buffer.byteLength(body, 'utf8');
  }

  function canRead(topology: Topology, reader: Reader, note: Note, hub: string): boolean {
    if (reader.lane === hub) return true;
    if (note.author.by === 'platform') return true;
    if (note.author.lane === reader.lane) return true;
    if (topology === 'mesh') return true;
    if (note.author.lane === hub) return true;
    if (topology === 'hierarchical') return reader.group !== undefined && note.group === reader.group;
    return false;
  }

  function signatureSetKey(report: VerificationReport | undefined, checks: readonly WorkflowCheck[] = []): string {
    const keys = new Set<string>();
    if (report) for (const signature of signaturesFromReport(report)) keys.add(signatureKey(signature));
    for (const check of checks) if (!check.ok) keys.add(signatureKey(signatureFromCheck(check)));
    return [...keys].sort().join('\n');
  }

  function shouldEscalate(history: readonly string[], times: number): boolean {
    if (times < 1 || history.length < times) return false;
    const last = history[history.length - 1];
    for (let index = history.length - times; index < history.length; index += 1) {
      if (history[index] !== last) return false;
    }
    return true;
  }

  function shouldPromote(policy: EscalationPolicy, history: readonly string[]): boolean {
    const times = policy.sameSignatureTimes ?? DEFAULT_SAME_SIGNATURE_TIMES;
    if (shouldEscalate(history, times)) return true;
    return policy.afterFailures !== undefined && history.length >= policy.afterFailures;
  }

  function retryBudgetFor(policy: EscalationPolicy): number {
    const budget = policy.retryBudget ?? DEFAULT_ESCALATION_RETRY_BUDGET;
    return Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  }

  function escalationPrompt(summary: string, lastFeedback: string | undefined): string {
    return lastFeedback ? `${summary}\n\n직전 검증 결과를 다시 보냅니다.\n\n${lastFeedback}` : summary;
  }

  return { signatureKey, normalizeMessage, signaturesFromReport, signatureFromCheck, failureNotesFromReport, failureNotesFromEvents, noteBytes, canRead, signatureSetKey, shouldEscalate, shouldPromote, retryBudgetFor, escalationPrompt };
})();

// ---------------------------------------------------------------------------
// 무작위 입력
// ---------------------------------------------------------------------------

/** 선형 합동은 입력이 쏠려(ADR-191 2b-1) mulberry32를 쓴다 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const chance = (rng: Rng, p: number): boolean => rng() < p;
const between = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

/** JS와 Rust가 다르게 읽기 쉬운 글자. 서로게이트는 쌍으로만 넣는다(짝 없는 절반은 napi 경계에서 U+FFFD로 바뀐다 — 의도한 차이) */
const SPECIAL = ['\u{1F600}', '𝒳', '\uFEFF', '\u00A0', '\u0085', '\u2028', '\u2029', '\u3000', '\u200B', '한글', 'é', 'İ', 'Σ', 'ΑΣ', 'ẞ', 'ß', '\u212A', '\u017F', 'ǅ', '\r', '\t', '\v', '\f', '\0', '\\', '|', ',', '"', ':', '٣', 'Ａ', 'ａｂｃｄｅｆ０'];

function hex(rng: Rng, n: number): string {
  const alphabet = pick(rng, ['0123456789abcdef', '0123456789ABCDEF', '0123456789abcdefABCDEF', '0123456789']);
  return Array.from({ length: n }, () => alphabet[Math.floor(rng() * alphabet.length)]!).join('');
}

const WORDS = ['error', 'Cannot', 'find', 'symbol', 'at', 'line', 'feedback', 'deadbeef', 'cafebabe', 'ready', 'timeout', 'ECONNREFUSED', 'abcdef', 'face', 'beef', 'a1b2c3d', 'null', 'TypeError:', 'npm', 'ERR!', '서비스', '실패', '준비하지', '못했습니다', 'GET', '/api/orders', 'HTTP', 'detached', 'DeadBeef', 'decade', 'defaced'];

function piece(rng: Rng): string {
  switch (between(rng, 0, 14)) {
    case 0: return String(between(rng, 0, 99999));
    case 1: return hex(rng, between(rng, 5, 9)); // 6·7 경계를 자주 밟는다
    case 2: return hex(rng, 7);
    case 3: return hex(rng, 6);
    case 4: return hex(rng, 40);
    case 5: return `${hex(rng, 7)}${pick(rng, ['g', '_', 'x', 'z', 'é', '한'])}`; // 끝이 단어 글자라 경계가 아닌 것
    case 6: return `${pick(rng, ['g', '_', 'x', 'é', '-'])}${hex(rng, between(rng, 6, 9))}`;
    case 7: return `src/app/${pick(rng, ['page', 'route', 'a_b'])}.tsx:${between(rng, 1, 999)}:${between(rng, 1, 99)}`;
    case 8: return `2026-11-${between(rng, 10, 28)}T0${between(rng, 0, 9)}:${between(rng, 10, 59)}:${between(rng, 10, 59)}.${between(rng, 100, 999)}Z`;
    case 9: return `sha256:${hex(rng, 64)}`;
    case 10: return `${between(rng, 1, 9)}${pick(rng, ['ms', 's', 'x', 'th', 'ms)', 'a'])}`;
    case 11: return pick(rng, SPECIAL);
    default: return pick(rng, WORDS);
  }
}

/** 메시지 한 줄 이상. 앞뒤 공백·여러 줄·200자 넘는 긴 줄·서로게이트 쌍이 200 경계에 걸리는 줄을 섞는다 */
function message(rng: Rng): string {
  let text = Array.from({ length: between(rng, 0, 8) }, () => piece(rng)).join(pick(rng, [' ', ' ', ' ', '', '_', ': ', '-', '\t']));
  if (chance(rng, 0.12)) {
    // 서로게이트 쌍을 가르지 않게 쌍 단위로 채운다(입력에 짝 없는 서로게이트가 없어야 한다)
    const unit = pick(rng, ['x', 'ab ', '가', '😀', '12']);
    const target = between(rng, 190, 215);
    while (text.length < target) text += unit;
  }
  if (chance(rng, 0.06)) {
    // 200 경계 앞뒤에 서로게이트 쌍을 둔다(경계가 쌍을 가를 수 있다)
    const at = between(rng, 197, 201);
    text = 'x'.repeat(at) + '😀' + pick(rng, ['', 'tail 42', '😀']);
  }
  if (chance(rng, 0.2)) text = pick(rng, ['  ', '\u00A0', '\uFEFF', '\u2028', '\u0085', ' \t\r']) + text;
  if (chance(rng, 0.2)) text += pick(rng, ['  ', '\u00A0', '\uFEFF', '\u2028', '\u0085', ' \t\r', '\r']);
  if (chance(rng, 0.3)) text += pick(rng, ['\n', '\r\n', '\n\n', '\n' + piece(rng), '\r' + piece(rng), '\u2028' + piece(rng)]);
  if (chance(rng, 0.05)) text = '\n' + text;
  return text;
}

const SERVICES = ['api', 'web', 'worker', 'db', '서비스', 'a|b', 'x,y', ''];
const STAGES: WorkflowCheck['stage'][] = ['browser_check', 'test', 'concurrency_check', 'load_check', 'review'];

function maybe<T>(rng: Rng, p: number, make: () => T): T | undefined {
  return chance(rng, p) ? make() : undefined;
}

function workflowCheck(rng: Rng): WorkflowCheck {
  const detail = chance(rng, 0.15) ? undefined : chance(rng, 0.08) ? '' : message(rng);
  return { stage: pick(rng, STAGES), name: pick(rng, ['web-lint', 'api /orders', 'review', 'protected-paths', '한글 이름', 'n42', 'abc1234def']), ok: chance(rng, 0.45), attempts: between(rng, 1, 3), ...(detail !== undefined ? { detail } : {}) };
}

function report(rng: Rng): VerificationReport {
  const restarted = Array.from({ length: between(rng, 0, 3) }, () => {
    const check: VerificationReport['restarted'][number] = { service: pick(rng, SERVICES), ready: chance(rng, 0.4) };
    if (chance(rng, 0.45)) check.error = chance(rng, 0.1) ? '' : message(rng);
    if (chance(rng, 0.5)) check.logTail = Array.from({ length: between(rng, 0, 3) }, () => message(rng));
    if (chance(rng, 0.1)) check.oomKilled = true;
    return check;
  });
  const contracts = Array.from({ length: between(rng, 0, 3) }, () => {
    const check: VerificationReport['contracts'][number] = {
      service: pick(rng, SERVICES),
      changes: Array.from({ length: between(rng, 0, 3) }, () => {
        const change: VerificationReport['contracts'][number]['changes'][number] = { kind: pick(rng, ['property-removed', 'endpoint-removed', 'type-changed', 'x y']) as never, target: pick(rng, ['Order.memo', 'GET /api/orders', `T${between(rng, 1, 99)}`, '한글.필드', hex(rng, 8)]), breaking: chance(rng, 0.55) };
        if (chance(rng, 0.4)) change.detail = chance(rng, 0.1) ? '' : message(rng);
        return change;
      }),
    };
    if (chance(rng, 0.25)) check.error = chance(rng, 0.2) ? '' : message(rng);
    return check;
  });
  const sync: VerificationReport['sync'] = chance(rng, 0.2) ? { error: message(rng), ...(chance(rng, 0.3) ? { platform: true as const } : {}) } : { elapsedMs: between(rng, 1, 999) };
  const secretLeaks = Array.from({ length: between(rng, 0, 2) }, () => ({
    file: pick(rng, ['api/app.yaml', 'a/b c.env', '한글/파일.ts', `src/${hex(rng, 8)}.ts`, 'x,y.ts', 'p|q', `n${between(rng, 1, 99)}.ts`]),
    secrets: Array.from({ length: between(rng, 0, 3) }, () => pick(rng, ['DATABASE_PASSWORD', 'TOKEN_42', 'a,b', 'ß', hex(rng, 7)])),
  }));
  return { ok: false, sync, restarted, contracts, unverifiedFiles: [], secretLeaks, skippedOff: [] };
}

function checks(rng: Rng): WorkflowCheck[] {
  return Array.from({ length: between(rng, 0, 3) }, () => workflowCheck(rng));
}

function events(rng: Rng): FailureEvent[] {
  return Array.from({ length: between(rng, 0, 5) }, () => {
    switch (between(rng, 0, 6)) {
      case 0: return { type: 'log' };
      case 1: return { type: 'snapshot' };
      case 2: return { type: 'agent', event: { type: 'text' } };
      case 3: return { type: 'agent', event: { type: 'verify_result', report: report(rng) } };
      case 4: return { type: 'agent', event: { type: 'verify_result' } };
      case 5: return { type: 'agent', event: { type: 'workflow_check', check: workflowCheck(rng) } };
      default: return { type: 'agent', event: { type: 'workflow_check' } };
    }
  });
}

/** 서명 하나: signatureKey 입력. 키 구분자(`|`·`,`)가 값에 들어 있는 경우를 섞는다 */
function signature(rng: Rng): FailureSignature {
  const sig: FailureSignature = { stage: pick(rng, ['run', 'contract_check', 'sync', 'secret_leak', 'test', 'a|b', '']), message: message(rng) };
  if (chance(rng, 0.5)) sig.service = pick(rng, SERVICES);
  if (chance(rng, 0.4)) sig.files = Array.from({ length: between(rng, 0, 3) }, () => pick(rng, ['a.ts', 'b,c.ts', 'x|y', '', '한글']));
  return sig;
}

const LANES = ['hub', 'a', 'b', 'lane-1', '레인', ''];
const GROUPS = ['g1', 'g2', '', '그룹'];

function stringifyResult(fn: () => unknown): string {
  try {
    const value = fn();
    return value === undefined ? 'undefined' : JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? `#${String(v)}` : v));
  } catch {
    return 'throws';
  }
}

/** 짝 없는 서로게이트가 든 결과: 글자를 napi 경계에서 U+FFFD로 바꾸는 것이 의도한 차이라 견주지 않고 따로 센다 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F])|\\u[dD][c-fC-F][0-9a-fA-F]{2}/;

interface Tally {
  runs: number;
  differ: number;
  /** 승격(참) 판정이 한쪽만 참인 횟수. 승격 뒤집힘 수 */
  flips: number;
  /** 결과 분포 */
  dist: Record<string, number>;
  /** 의도한 차이(200자 경계가 서로게이트 쌍을 갈라 짝 없는 서로게이트가 생긴 결과)라 견주지 않은 횟수 */
  skippedLoneSurrogate: number;
  first: string[];
}

function newTally(): Tally {
  return { runs: 0, differ: 0, flips: 0, dist: {}, skippedLoneSurrogate: 0, first: [] };
}

function count(tally: Tally, key: string): void {
  tally.dist[key] = (tally.dist[key] ?? 0) + 1;
}

function compare(tally: Tally, label: string, input: unknown, expected: string, actual: string): void {
  tally.runs++;
  if (LONE_SURROGATE.test(expected)) {
    tally.skippedLoneSurrogate++;
    return;
  }
  if (expected !== actual) {
    tally.differ++;
    if (expected === 'true' || actual === 'true') tally.flips++;
    if (tally.first.length < 3) tally.first.push(`${label}\n입력 ${JSON.stringify(input)}\n옛   ${expected}\n새   ${actual}`);
  }
}

const SEEDS = (process.env['ESCALATION_DIFF_SEEDS'] ?? '1,7,42,2026').split(',').map(Number);
const ITERATIONS = Number(process.env['ESCALATION_DIFF_ITERATIONS'] ?? 3000);
const REPORT = process.env['ESCALATION_DIFF_REPORT'];
/** 크게 키워 돌릴 때를 위해 시험 제한 시간도 키운다(기본 크기에서는 저장소 기본값 그대로) */
const TIMEOUT = Math.max(15_000, SEEDS.length * ITERATIONS * 2);

interface Case {
  name: string;
  run: (rng: Rng, tally: Tally) => void;
  /** 분포가 쏠리지 않았는지 */
  check?: (total: Tally) => void;
}

const ratio = (total: Tally, key: string): number => (total.dist[key] ?? 0) / total.runs;

const TIMES = [-1, 0, 0.5, 1, 1, 2, 2, 2, 3, 3, 4, 5, 1.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9];

function history(rng: Rng): string[] {
  // 서명 집합 키를 닮은 문자열 몇 개를 되풀이해 "같은 실패가 이어지는" 기록과 "매번 다른" 기록이 섞이게 한다
  const pool = [signatureSetKey(report(rng), checks(rng)), signatureSetKey(report(rng), checks(rng)), 'a', 'b', ''];
  const length = between(rng, 0, 7);
  const out: string[] = [];
  let current = pick(rng, pool);
  for (let n = 0; n < length; n++) {
    if (chance(rng, 0.35)) current = pick(rng, pool);
    out.push(current);
  }
  return out;
}

function policy(rng: Rng): EscalationPolicy {
  const p: EscalationPolicy = { to: 'sonnet' };
  if (chance(rng, 0.6)) p.sameSignatureTimes = pick(rng, TIMES);
  if (chance(rng, 0.5)) p.afterFailures = pick(rng, [0, 1, 2, 3, 4, 5, 7, 0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, -1]);
  if (chance(rng, 0.6)) p.retryBudget = pick(rng, [0, 1, 2, 2.9, 0.5, -1, 3, 1e9, 1e21, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 5e-324]);
  return p;
}

const cases: Case[] = [
  {
    name: 'normalizeMessage',
    run: (rng, tally) => {
      const input = message(rng);
      const expected = stringifyResult(() => legacy.normalizeMessage(input));
      if (/H/.test(expected)) count(tally, 'H');
      if (/N/.test(expected)) count(tally, 'N');
      if (expected.length > 202) count(tally, 'long');
      if (input.includes('\n') || input.trim() !== input) count(tally, 'trimmed');
      compare(tally, 'normalizeMessage', input, expected, stringifyResult(() => normalizeMessage(input)));
    },
    check: (t) => {
      expect(ratio(t, 'H')).toBeGreaterThan(0.1);
      expect(ratio(t, 'N')).toBeGreaterThan(0.3);
      expect(ratio(t, 'long')).toBeGreaterThan(0.01);
      expect(ratio(t, 'trimmed')).toBeGreaterThan(0.2);
    },
  },
  {
    name: 'signatureKey',
    run: (rng, tally) => {
      const input = signature(rng);
      compare(tally, 'signatureKey', input, stringifyResult(() => legacy.signatureKey(input)), stringifyResult(() => signatureKey(input)));
    },
  },
  {
    name: 'signaturesFromReport',
    run: (rng, tally) => {
      const input = report(rng);
      const expected = stringifyResult(() => legacy.signaturesFromReport(input));
      count(tally, expected === '[]' ? 'empty' : 'valued');
      compare(tally, 'signaturesFromReport', input, expected, stringifyResult(() => signaturesFromReport(input)));
    },
    check: (t) => {
      expect(ratio(t, 'empty')).toBeGreaterThan(0.01);
      expect(ratio(t, 'valued')).toBeGreaterThan(0.5);
    },
  },
  {
    name: 'signatureFromCheck',
    run: (rng, tally) => {
      const input = workflowCheck(rng);
      compare(tally, 'signatureFromCheck', input, stringifyResult(() => legacy.signatureFromCheck(input)), stringifyResult(() => signatureFromCheck(input)));
    },
  },
  {
    name: 'failureNotesFromReport',
    run: (rng, tally) => {
      const input = { report: report(rng), checks: chance(rng, 0.15) ? undefined : checks(rng) };
      const expected = stringifyResult(() => legacy.failureNotesFromReport(input.report, input.checks));
      count(tally, expected === '[]' ? 'empty' : 'valued');
      compare(tally, 'failureNotesFromReport', input, expected, stringifyResult(() => failureNotesFromReport(input.report, input.checks)));
    },
    check: (t) => {
      expect(ratio(t, 'empty')).toBeGreaterThan(0.005);
      expect(ratio(t, 'valued')).toBeGreaterThan(0.5);
    },
  },
  {
    name: 'failureNotesFromEvents',
    run: (rng, tally) => {
      const input = events(rng);
      const expected = stringifyResult(() => legacy.failureNotesFromEvents(input));
      count(tally, expected === '[]' ? 'empty' : 'valued');
      compare(tally, 'failureNotesFromEvents', input, expected, stringifyResult(() => failureNotesFromEvents(input)));
    },
    check: (t) => {
      expect(ratio(t, 'empty')).toBeGreaterThan(0.01);
      expect(ratio(t, 'valued')).toBeGreaterThan(0.4);
    },
  },
  {
    name: 'signatureSetKey',
    run: (rng, tally) => {
      const input = { report: chance(rng, 0.2) ? undefined : report(rng), checks: chance(rng, 0.15) ? undefined : checks(rng) };
      const expected = stringifyResult(() => legacy.signatureSetKey(input.report, input.checks));
      count(tally, expected === '""' ? 'empty' : 'valued');
      compare(tally, 'signatureSetKey', input, expected, stringifyResult(() => signatureSetKey(input.report, input.checks)));
    },
    check: (t) => {
      expect(ratio(t, 'empty')).toBeGreaterThan(0.005);
      expect(ratio(t, 'valued')).toBeGreaterThan(0.5);
    },
  },
  {
    name: 'shouldEscalate',
    run: (rng, tally) => {
      const input = { history: history(rng), times: pick(rng, TIMES) };
      const expected = stringifyResult(() => legacy.shouldEscalate(input.history, input.times));
      count(tally, expected);
      compare(tally, 'shouldEscalate', input, expected, stringifyResult(() => shouldEscalate(input.history, input.times)));
    },
    check: (t) => {
      expect(ratio(t, 'true')).toBeGreaterThan(0.1);
      expect(ratio(t, 'false')).toBeGreaterThan(0.3);
    },
  },
  {
    name: 'shouldPromote',
    run: (rng, tally) => {
      const input = { policy: policy(rng), history: history(rng) };
      const expected = stringifyResult(() => legacy.shouldPromote(input.policy, input.history));
      count(tally, expected);
      compare(tally, 'shouldPromote', input, expected, stringifyResult(() => shouldPromote(input.policy, input.history)));
    },
    check: (t) => {
      expect(ratio(t, 'true')).toBeGreaterThan(0.2);
      expect(ratio(t, 'false')).toBeGreaterThan(0.2);
    },
  },
  {
    name: 'retryBudgetFor',
    run: (rng, tally) => {
      const input = policy(rng);
      const expected = stringifyResult(() => legacy.retryBudgetFor(input));
      count(tally, expected === '0' ? 'zero' : 'positive');
      compare(tally, 'retryBudgetFor', input, expected, stringifyResult(() => retryBudgetFor(input)));
    },
    check: (t) => {
      expect(ratio(t, 'zero')).toBeGreaterThan(0.1);
      expect(ratio(t, 'positive')).toBeGreaterThan(0.3);
    },
  },
  {
    name: 'escalationPrompt',
    run: (rng, tally) => {
      const input = { summary: message(rng), feedback: chance(rng, 0.3) ? undefined : chance(rng, 0.1) ? '' : message(rng) };
      const expected = stringifyResult(() => legacy.escalationPrompt(input.summary, input.feedback));
      count(tally, input.feedback ? 'with' : 'without');
      compare(tally, 'escalationPrompt', input, expected, stringifyResult(() => escalationPrompt(input.summary, input.feedback)));
    },
    check: (t) => {
      expect(ratio(t, 'with')).toBeGreaterThan(0.4);
      expect(ratio(t, 'without')).toBeGreaterThan(0.2);
    },
  },
  {
    name: 'noteBytes',
    run: (rng, tally) => {
      const input = message(rng) + pick(rng, ['', '\u{1F600}', '한', 'é', '\0']);
      compare(tally, 'noteBytes', input, stringifyResult(() => legacy.noteBytes(input)), stringifyResult(() => noteBytes(input)));
    },
  },
  {
    name: 'canRead',
    run: (rng, tally) => {
      const topology = pick(rng, ['star', 'hierarchical', 'mesh', 'ring', ''] as unknown as Topology[]);
      const reader: Reader = { lane: pick(rng, LANES), ...(chance(rng, 0.6) ? { group: pick(rng, GROUPS) } : {}) };
      const note = {
        id: 'n1',
        kind: 'fact',
        body: 'x',
        refs: [],
        author: { lane: pick(rng, LANES), by: pick(rng, ['model', 'platform'] as const) },
        ...(chance(rng, 0.6) ? { group: pick(rng, GROUPS) } : {}),
        priority: 1,
        at: 't',
      } as Note;
      const hub = pick(rng, LANES);
      const expected = stringifyResult(() => legacy.canRead(topology, reader, note, hub));
      count(tally, expected);
      compare(tally, 'canRead', { topology, reader, note, hub }, expected, stringifyResult(() => canRead(topology, reader, note, hub)));
    },
    check: (t) => {
      expect(ratio(t, 'true')).toBeGreaterThan(0.3);
      expect(ratio(t, 'false')).toBeGreaterThan(0.1);
    },
  },
  {
    // 게이트가 실패를 되풀이하는 실행을 흉내 낸다: 시도마다 서명 집합 키를 기록에 쌓고, 승격 판정(루프와 같은 호출)을 시도마다 견준다.
    // 한 실행에서 한 번 승격하면 멈추는 것은 호출자의 규칙이라 여기서도 그렇게 멈춘다
    name: '승격 시퀀스(signatureSetKey → shouldPromote)',
    run: (rng, tally) => {
      const base = Array.from({ length: between(rng, 1, 3) }, () => ({ report: report(rng), checks: checks(rng) }));
      const p = policy(rng);
      const legacyHistory: string[] = [];
      const newHistory: string[] = [];
      const attempts = between(rng, 1, 7);
      let current = pick(rng, base);
      let legacyDecision = '';
      let newDecision = '';
      for (let attempt = 0; attempt < attempts; attempt++) {
        // 같은 입력이 이어지거나(같은 서명), 입력이 바뀌거나, 같은 입력에 숫자·해시만 바뀐 메시지(정규화가 같게 만들어야 한다)
        const roll = rng();
        if (roll < 0.25) current = pick(rng, base);
        else if (roll < 0.55) {
          const reworked = JSON.parse(JSON.stringify(current.report)) as VerificationReport;
          for (const check of reworked.restarted) if (check.error) check.error = check.error.replace(/\d+/g, () => String(between(rng, 0, 9999))).replace(/\b[0-9a-f]{7,}\b/gi, () => hex(rng, between(rng, 7, 12)));
          current = { report: reworked, checks: current.checks };
        }
        legacyHistory.push(legacy.signatureSetKey(current.report, current.checks));
        newHistory.push(signatureSetKey(current.report, current.checks));
        legacyDecision += legacy.shouldPromote(p, legacyHistory) ? 'P' : '.';
        newDecision += shouldPromote(p, newHistory) ? 'P' : '.';
        if (legacyDecision.endsWith('P')) break;
      }
      const sameKeys = legacyHistory.length >= 2 && legacyHistory[legacyHistory.length - 1] === legacyHistory[legacyHistory.length - 2];
      count(tally, legacyDecision.includes('P') ? 'promoted' : 'kept');
      count(tally, sameKeys ? 'sameKeyPair' : 'differentKeyPair');
      tally.runs++;
      if (LONE_SURROGATE.test(legacyHistory.join(''))) {
        tally.skippedLoneSurrogate++;
        return;
      }
      if (legacyDecision !== newDecision || legacyHistory.join('\u0001') !== newHistory.join('\u0001')) {
        tally.differ++;
        if (legacyDecision.includes('P') !== newDecision.includes('P') || legacyDecision !== newDecision) tally.flips++;
        if (tally.first.length < 3) tally.first.push(`승격 시퀀스\n정책 ${JSON.stringify(p)}\n옛 ${legacyDecision} ${JSON.stringify(legacyHistory)}\n새 ${newDecision} ${JSON.stringify(newHistory)}`);
      }
    },
    check: (t) => {
      expect(ratio(t, 'promoted')).toBeGreaterThan(0.2);
      expect(ratio(t, 'kept')).toBeGreaterThan(0.1);
      expect(ratio(t, 'sameKeyPair')).toBeGreaterThan(0.1);
      expect(ratio(t, 'differentKeyPair')).toBeGreaterThan(0.1);
    },
  },
];

describe('차등 시험: 옛 TS 구현과 Rust 껍데기는 같은 입력에 같은 글자를 낸다', () => {
  for (const { name, run, check } of cases) {
    it(name, () => {
      const total = newTally();
      for (const seed of SEEDS) {
        const rng = mulberry32(seed * 1000 + name.length);
        const tally = newTally();
        for (let n = 0; n < ITERATIONS; n++) run(rng, tally);
        total.runs += tally.runs;
        total.differ += tally.differ;
        total.flips += tally.flips;
        total.skippedLoneSurrogate += tally.skippedLoneSurrogate;
        for (const [key, value] of Object.entries(tally.dist)) total.dist[key] = (total.dist[key] ?? 0) + value;
        total.first.push(...tally.first);
        if (REPORT) appendFileSync(REPORT, `[차등] ${name} 시드 ${seed}: 비교 ${tally.runs}, 다름 ${tally.differ}, 승격 뒤집힘 ${tally.flips}, 짝 없는 서로게이트로 건너뜀 ${tally.skippedLoneSurrogate}, 분포 ${JSON.stringify(tally.dist)}\n`);
      }
      expect(total.first.join('\n---\n')).toBe('');
      expect(total.differ).toBe(0);
      expect(total.flips).toBe(0);
      // 200자 경계 서로게이트로 건너뛴 것이 대부분이면 시험이 아무것도 보지 않은 것이다
      expect(total.skippedLoneSurrogate).toBeLessThan(total.runs * 0.1);
      check?.(total);
    }, TIMEOUT);
  }

  it('대조 장치: 구현을 한 곳만 바꾼 가짜를 같은 입력에 돌리면 다른 결과를 잡는다', () => {
    const fakes: Array<[string, (text: string) => string]> = [
      // 해시 길이 임계값 7 → 6
      ['hex6', (text) => text.split('\n', 1)[0]!.trim().replace(/\b[0-9a-f]{6,}\b/gi, 'H').replace(/\d+/g, 'N').slice(0, 200)],
      // 숫자 → N을 빼먹음
      ['nodigit', (text) => text.split('\n', 1)[0]!.trim().replace(/\b[0-9a-f]{7,}\b/gi, 'H').slice(0, 200)],
      // \d를 유니코드 숫자까지(Rust 기본 규칙)
      ['unicodeDigit', (text) => text.split('\n', 1)[0]!.trim().replace(/\b[0-9a-f]{7,}\b/gi, 'H').replace(/\p{Nd}+/gu, 'N').slice(0, 200)],
      // trim이 BOM을 못 지움(Rust 표준 trim)
      ['rustTrim', (text) => text.split('\n', 1)[0]!.replace(/^[\s\u0085]+|[\s\u0085]+$/g, (m) => m.replace(/\uFEFF/g, '\uFEFF')).replace(/^\uFEFF|\uFEFF$/g, '\uFEFF').replace(/\b[0-9a-f]{7,}\b/gi, 'H').replace(/\d+/g, 'N').slice(0, 200)],
    ];
    const rng = mulberry32(9);
    const inputs = Array.from({ length: 3000 }, () => message(rng));
    for (const [label, fake] of fakes) {
      const tally = newTally();
      for (const input of inputs) compare(tally, label, input, stringifyResult(() => legacy.normalizeMessage(input)), stringifyResult(() => fake(input)));
      expect(tally.differ, label).toBeGreaterThan(5);
    }
    // 서명 집합 키: 정렬을 빼면, 판정을 한 칸 어긋나게(>=를 >로) 하면 잡는다
    const unsorted = (r: VerificationReport, c: WorkflowCheck[]): string => {
      const keys = new Set<string>();
      for (const sig of legacy.signaturesFromReport(r)) keys.add(legacy.signatureKey(sig));
      for (const check of c) if (!check.ok) keys.add(legacy.signatureKey(legacy.signatureFromCheck(check)));
      return [...keys].join('\n');
    };
    const tally = newTally();
    for (let n = 0; n < 2000; n++) {
      const r = report(rng);
      const c = checks(rng);
      compare(tally, 'unsorted', { r, c }, stringifyResult(() => legacy.signatureSetKey(r, c)), stringifyResult(() => unsorted(r, c)));
    }
    expect(tally.differ).toBeGreaterThan(5);
    const off = newTally();
    for (let n = 0; n < 2000; n++) {
      const h = history(rng);
      const times = pick(rng, TIMES);
      const strictGreater = (hh: string[], t: number): boolean => !(t < 1 || hh.length <= t) && legacy.shouldEscalate(hh, t);
      compare(off, 'gt', { h, times }, stringifyResult(() => legacy.shouldEscalate(h, times)), stringifyResult(() => strictGreater(h, times)));
    }
    expect(off.differ).toBeGreaterThan(5);
    expect(off.flips).toBeGreaterThan(5);
  });

  it('대조 장치: 새 결과 한 글자만 달라도 잡는다', () => {
    const rng = mulberry32(11);
    const tally = newTally();
    for (let n = 0; n < 300; n++) {
      const r = report(rng);
      const expected = stringifyResult(() => legacy.signaturesFromReport(r));
      compare(tally, 'tamper', r, expected, expected.replace('"message":"', '"message":"x'));
      compare(tally, 'reorder', r, expected, expected.replace('"stage":"run","service"', '"service"').replace(/\{"stage":("[a-z_]+"),"message":("[^"]*")\}/, '{"message":$2,"stage":$1}'));
    }
    expect(tally.differ).toBeGreaterThan(50);
  });
});

describe('차등 시험: 선언한 모양이 어긋난 입력도 옛 구현이 던지는 자리에서 던진다', () => {
  // JSON.parse한 값이 모양이 어긋난 채 들어오는 경우(null, 숫자, 문자열, 배열, 객체로 바꾼 필드). 옛 구현이 던지면 새 구현도 던지고,
  // 옛 구현이 값을 내면 같은 글자여야 한다. 짝 없는 서로게이트·undefined 값 키는 만들지 않는다
  function mutate(rng: Rng, value: unknown, depth: number): unknown {
    if (Array.isArray(value)) {
      const copy = value.map((item) => mutate(rng, item, depth + 1));
      if (chance(rng, 0.05)) copy.splice(between(rng, 0, copy.length), 0, pick(rng, [null, 5, 'x', {}, []]));
      return copy;
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = chance(rng, 0.04) ? pick(rng, [null, 0, 7, 'str', [], {}, true, false, [null], ['x'], { error: 'e' }]) : mutate(rng, item, depth + 1);
      }
      if (chance(rng, 0.03)) delete out[pick(rng, Object.keys(out).concat('x'))];
      return out;
    }
    return value;
  }

  it('signaturesFromReport·signatureFromCheck·failureNotes*·signatureSetKey', () => {
    let threw = 0;
    let valued = 0;
    const diffs: string[] = [];
    for (const seed of SEEDS) {
      const rng = mulberry32(seed + 77);
      for (let n = 0; n < ITERATIONS; n++) {
        const r = mutate(rng, report(rng), 0) as VerificationReport;
        const c = mutate(rng, checks(rng), 0) as WorkflowCheck[];
        const ev = mutate(rng, events(rng), 0) as FailureEvent[];
        const pairs: Array<[string, () => unknown, () => unknown]> = [
          ['signaturesFromReport', () => legacy.signaturesFromReport(r), () => signaturesFromReport(r)],
          ['signatureFromCheck', () => legacy.signatureFromCheck(c[0]!), () => signatureFromCheck(c[0]!)],
          ['failureNotesFromReport', () => legacy.failureNotesFromReport(r, c), () => failureNotesFromReport(r, c)],
          ['failureNotesFromEvents', () => legacy.failureNotesFromEvents(ev), () => failureNotesFromEvents(ev)],
          ['signatureSetKey', () => legacy.signatureSetKey(r, c), () => signatureSetKey(r, c)],
        ];
        for (const [label, a, b] of pairs) {
          const expected = stringifyResult(a);
          const actual = stringifyResult(b);
          if (expected === 'throws') threw++;
          else valued++;
          if (expected !== actual && !LONE_SURROGATE.test(expected)) diffs.push(`${label}\n입력 ${JSON.stringify({ r, c, ev })}\n옛 ${expected}\n새 ${actual}`);
        }
      }
    }
    expect(diffs.slice(0, 3).join('\n---\n')).toBe('');
    // 던지는 입력과 값을 내는 입력이 모두 충분히 섞였는지
    expect(threw).toBeGreaterThan(valued * 0.05);
    expect(valued).toBeGreaterThan(threw * 0.05);
  }, TIMEOUT);
});
