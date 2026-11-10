import { appendFileSync } from 'node:fs';
import { native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, type Outcome } from './differential-kit';
import { canonicalProjectPath, foldName, normalizeProjectPath } from './path-names';
import * as legacy from './path-policy-legacy';
import { checkToolPolicy, DEFAULT_DENIED_COMMANDS, hasApprovalToken, isProtectedPath, isToolAllowed, isWithinScope } from './policy';

/**
 * path-names·policy의 판정을 Rust로 옮기면서(ADR-191 3q) 옛 TS 구현(`path-policy-legacy.ts`)과 새 껍데기에 같은 무작위 입력을 넣어 JSON 글자로 견준다.
 * `path.sep`은 플랫폼 값이라 이 기계(POSIX)에서는 껍데기가 늘 같은 값을 넘긴다. 그래서 Windows 판(`sep = '\\'`)은 Rust 함수를 직접 불러 옛 구현의 `sep` 인자와 견준다.
 *
 * **막는 검사라 다른 결과를 방향으로 센다.** 열린 쪽 뒤집힘(보호 경로가 보호 안 됨, 범위 밖이 범위 안, 금지가 허용, 허용 안 된 도구가 허용)은 0이어야 하고,
 * 닫힌 쪽 차이(옛 구현은 통과, 새 구현은 거절)는 정책에 빈 규칙(`''`)이 들었거나 옛 구현이 던진 경우뿐이어야 한다(의도한 차이, 모듈 문서 참고).
 *
 * 크기는 환경 변수로 바꾼다: PATH_POLICY_DIFF_SEEDS(쉼표 목록), PATH_POLICY_DIFF_ITERATIONS, PATH_POLICY_DIFF_REPORT=<파일 경로>
 */
const SEEDS = readEnvList('PATH_POLICY_DIFF_SEEDS', [1, 7, 42, 2026]);
const ITERATIONS = readEnvNumber('PATH_POLICY_DIFF_ITERATIONS', 3000);
const REPORT = process.env.PATH_POLICY_DIFF_REPORT;

interface Tally {
  compared: number;
  different: number;
  openFlips: number;
  closedIntended: number;
  distribution: Map<string, number>;
  examples: string[];
}
const tallies = new Map<string, Tally>();
function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) tallies.set(name, (t = { compared: 0, different: 0, openFlips: 0, closedIntended: 0, distribution: new Map(), examples: [] }));
  return t;
}

/**
 * `opens(a, b)`: 옛 결과 a가 막았는데 새 결과 b가 열었는가. `intended(…)`: 닫힌 쪽 차이 중 의도한 것인가
 */
function compare(
  name: string,
  input: unknown,
  old: () => unknown,
  next: () => unknown,
  bucket: (o: Outcome) => string,
  direction?: { opens: (a: unknown, b: unknown) => boolean; intended: (a: Outcome, b: Outcome) => boolean },
): void {
  const a = outcome(old);
  const b = outcome(next);
  const t = tally(name);
  t.compared += 1;
  const key = bucket(a);
  t.distribution.set(key, (t.distribution.get(key) ?? 0) + 1);
  if (sameOutcome(a, b)) return;
  t.different += 1;
  // 옛 구현이 던지고 새 구현은 값을 낸 경우(`constructor` 같은 이름의 도구)는 거절로 끝나는 닫힌 쪽이어야 한다
  const oldValue = a.threw ? undefined : a.value;
  const newValue = b.threw ? undefined : b.value;
  const opened = direction !== undefined && !b.threw && !a.threw && direction.opens(oldValue, newValue);
  const intended = !opened && direction !== undefined && direction.intended(a, b);
  if (opened) t.openFlips += 1;
  else if (intended) t.closedIntended += 1;
  // 예시는 설명되지 않은 차이만 남긴다
  if (!intended && t.examples.length < 3) t.examples.push(`입력 ${JSON.stringify(input)}\n옛 ${JSON.stringify(a)}\n새 ${JSON.stringify(b)}`);
}

const NAMES = [
  '.git', '.GIT', '.Git', '.git.', '.git ', '.git. .', '.gi\u200Bt', '.g\u200Dit', '\uFF0E\uFF47\uFF49\uFF54', '.g\u0131t', '.gi\u1E6F', '.\u0067\u0069\u0074\u0301', 'ſ', 'workflow\u017F', '\u212Aafka', 'e\u0301', 'é', 'E\u0301',
  '.env', '.ENV', '.env.local', '.Env.production', '.env ', 'infra', 'Infra', 'INFRA', 'infra.', '.github', '.GITHUB', 'workflows', 'migrations', 'src', 'SRC', 'Src', 'srcx', 'src.bak', 'srcx.ts',
  'web', 'app', 'plan-a', 'plan-ab', 'Plan-A', 'a:b.txt', 'C:', 'c:', 'x', 'a', 'b', 'node_modules', '문서', '문서'.normalize('NFD'), 'ß', 'ẞ', 'İ', 'ı', 'ŉ', 'ǰ', 'ΑΣ', 'ΑΣ.', 'ας', 'Σ',
  '...', '. .', ' ', '  ', '.', '..', '', '\u00A0', '\u3000', 'a\u0000b', 'a\\b', '\\', 'a\\..\\..\\x', '😀', 'x😀', '\u2215', '\uFF0F', 'a\uFF0Fb', '\uFB01le', '\u1E9E', 'ǅ', 'ﬃ', '\u0345', 'a\u0345', '\u200B', '\uFEFF', '\u2060', '\u00AD',
];
const SEPS = ['/', '/', '/', '/', '//', '\\', '/./', '/../', '\\\\', '/ /'];

function nameOf(g: Gen): string {
  if (g.chance(0.12)) return g.text([...'.ab/\\ :CSsEeΣσς\u0301\u200B\uFF0Eß'], g.int(5));
  return g.pick(NAMES);
}

function pathOf(g: Gen): string {
  const count = g.int(5);
  let out = '';
  for (let i = 0; i < count; i++) out += (i > 0 ? g.pick(SEPS) : '') + nameOf(g);
  return g.pick(['', '', '', '', './', '/', '../', 'C:/', '\\', './/']) + out + g.pick(['', '', '', '', '/', '//', '/.', '\\']);
}

function ruleOf(g: Gen): string {
  return g.chance(0.6) ? g.pick(['.', '', './', 'src', 'src/', './SRC', '.git', '.GIT', '.env', '.github/workflows', '.github\\workflows', 'infra', 'infra/prod', 'web\\app', 'migrations', '../x', '/abs', 'C:/x']) : pathOf(g);
}

const PROTO_TOOLS = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
const TOOLS = ['write_file', 'edit_file', 'delete_file', 'read_file', 'read_lines', 'search_files', 'list_files', 'run_in_service', 'restart_service', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '', 'Write_File'];
const COMMAND_PARTS = ['git', 'push', 'origin', 'main', '/usr/bin/git', './gradlew', 'gradlew', 'gradle', '--stop', '-p', 'commerce', 'test', 'sh', 'bash', '-c', '-lc', 'env', 'make', 'release', 'npm', 'publish', 'docker', 'kubectl', 'terraform', 'apply', 'git push', 'git  push origin', 'echo --stop', 'x; gradle --stop', 'x && ./gradlew   --stop', 'gradle\n--stop', 'gradle\u00A0--stop', 'gradle\u0085--stop', 'gradle\uFEFF--stop', '(./gradlew --stop)', 'gradlew;--stop', 'gradlew|x --stop', 'a.b', 'a-b', '', ' ', '/', 'sh/', '/bin/', 'bash/'];
const DENIED_RULES = ['make release', 'npm publish', 'git push', '  git   push ', 'docker', 'gradlew --stop', 'sh', 'rm', 'a.b', 'a-b', 'git', 'release', 'push origin', 'x', '', ' ', '\u00A0', '\ufeff', 'echo --stop', '(./gradlew'];

function commandOf(g: Gen): string[] {
  return g.list(0, 5, () => g.pick(COMMAND_PARTS));
}

function listOf(g: Gen, make: () => string, max = 4): string[] {
  return g.list(0, max, make);
}

function policyOf(g: Gen): legacy.LegacyPolicy | undefined {
  if (g.chance(0.08)) return undefined;
  const policy: legacy.LegacyPolicy = {};
  if (g.chance(0.3)) policy.allowedTools = listOf(g, () => g.pick(TOOLS));
  if (g.chance(0.3)) policy.deniedCommands = listOf(g, () => g.pick(DENIED_RULES));
  if (g.chance(0.3)) policy.requireApprovalFor = listOf(g, () => g.pick(TOOLS));
  if (g.chance(0.5)) policy.protectedPaths = listOf(g, () => ruleOf(g));
  if (g.chance(0.4)) policy.writablePaths = listOf(g, () => ruleOf(g));
  return policy;
}

function inputOf(g: Gen, file: string, command: string[]): unknown {
  return g.weighted<unknown>([
    [8, { path: file, command }],
    [3, { path: file }],
    [3, { command }],
    [1, { path: 5, command: 'git push' }],
    [1, { command: [1, 'push'] }],
    [1, { command: ['git', undefined, 'push'] }],
    [1, null],
    [1, undefined],
    [1, 'text'],
    [1, []],
    [1, { path: null }],
  ]);
}

const APPROVALS = [undefined, undefined, '', ' ', '\n\t', '\u00A0', '\uFEFF', '\u0085', 'tok', ' tok ', '\u200B'];

/** 옛 구현이 모르는 쪽 입력(`''` 규칙)을 가졌는가: 의도한 닫힌 쪽 차이의 조건 */
function hasEmptyRule(policy: legacy.LegacyPolicy | undefined): boolean {
  return Boolean(policy?.protectedPaths?.includes('') || policy?.deniedCommands?.includes(''));
}

function runSeed(seed: number): void {
  const g = new Gen(seed);
  for (let i = 0; i < ITERATIONS; i++) {
    const file = pathOf(g);
    const rule = ruleOf(g);
    const lenient = g.chance(0.5);
    const name = nameOf(g);
    const sepBackslash = g.chance(0.5);
    const sep = sepBackslash ? '\\' : '/';
    const bucketPath = (o: Outcome): string => (o.threw ? '던짐' : (o as { value: unknown }).value === undefined ? '꼴 없음' : (o as { value: unknown }).value === '' ? '루트' : '경로');
    const bucketBool = (o: Outcome): string => (o.threw ? '던짐' : String((o as { value: unknown }).value));

    compare('normalizeProjectPath', { file, lenient }, () => legacy.normalizeProjectPath(file, { lenientSeparators: lenient }), () => normalizeProjectPath(file, { lenientSeparators: lenient }), bucketPath);
    compare('normalizeProjectPath(Windows)', { file, lenient }, () => legacy.normalizeProjectPath(file, { lenientSeparators: lenient }, '\\'), () => native.normalizeProjectPath(file, lenient, true) ?? undefined, bucketPath);
    compare('foldName', name, () => legacy.foldName(name), () => foldName(name), (o) => (o.threw ? '던짐' : (o as { value: unknown }).value === name ? '그대로' : '바뀜'));
    compare('canonicalProjectPath', { file, lenient }, () => legacy.canonicalProjectPath(file, { lenientSeparators: lenient }), () => canonicalProjectPath(file, { lenientSeparators: lenient }), bucketPath);
    compare('canonicalProjectPath(Windows)', { file, lenient }, () => legacy.canonicalProjectPath(file, { lenientSeparators: lenient }, '\\'), () => native.canonicalProjectPath(file, lenient, true) ?? undefined, bucketPath);

    // 거부 목록: 옛 true → 새 false가 열린 쪽
    const protectedOpens = { opens: (a: unknown, b: unknown) => a === true && b === false, intended: () => false };
    compare('isProtectedPath', { file, rule }, () => legacy.isProtectedPath(file, rule), () => isProtectedPath(file, rule), bucketBool, protectedOpens);
    compare('isProtectedPath(Windows)', { file, rule, sep }, () => legacy.isProtectedPath(file, rule, sep), () => native.isProtectedPath(file, rule, sepBackslash), bucketBool, protectedOpens);
    // 허용 목록: 옛 false → 새 true가 열린 쪽
    const scopeOpens = { opens: (a: unknown, b: unknown) => a === false && b === true, intended: () => false };
    compare('isWithinScope', { file, rule }, () => legacy.isWithinScope(file, rule), () => isWithinScope(file, rule), bucketBool, scopeOpens);
    compare('isWithinScope(Windows)', { file, rule, sep }, () => legacy.isWithinScope(file, rule, sep), () => native.isWithinScope(file, rule, sepBackslash), bucketBool, scopeOpens);

    const tool = g.pick(TOOLS);
    const allowed = listOf(g, () => g.pick(TOOLS), 4);
    compare('isToolAllowed', { tool, allowed }, () => legacy.isToolAllowed(tool, allowed), () => isToolAllowed(tool, allowed), bucketBool, {
      opens: (a, b) => a === false && b === true,
      // 옛 구현이 던진 자리에서 새 구현이 거절(false)한다
      intended: (a, b) => a.threw && PROTO_TOOLS.includes(tool) && !b.threw && b.value === false,
    });
    const token = g.pick(APPROVALS);
    compare('hasApprovalToken', token, () => legacy.hasApprovalToken(token), () => hasApprovalToken(token), bucketBool, { opens: (a, b) => a === false && b === true, intended: () => false });

    const policy = policyOf(g);
    const command = commandOf(g);
    const input = inputOf(g, file, command);
    const approval = g.pick(APPROVALS);
    const decisionBucket = (o: Outcome): string => {
      if (o.threw) return '던짐';
      const v = o.value as { decision: string; reason?: string };
      if (v.decision === 'allow') return '허용';
      return `거절: ${v.reason!.split(':')[0]!.slice(0, 34)}`;
    };
    // 의도한 닫힌 쪽 차이 둘: (1) 옛 구현이 던진 도구 이름(constructor 등)을 새 구현이 거절한다 (2) 빈 규칙이 든 정책에서 옛 구현은 통과(또는 다른 이유로 거절), 새 구현은 빈 규칙으로 거절한다
    const closedOk = (a: Outcome, b: Outcome): boolean => {
      if (a.threw) return PROTO_TOOLS.includes(tool) && policy?.allowedTools !== undefined && !b.threw && (b.value as legacy.LegacyDecision).decision === 'deny';
      // 옛 구현이 허용했거나, 뒤의 다른 이유로 거절하던 자리다(빈 규칙을 찾으면 거절 이유가 그 규칙으로 바뀐다)
      return !b.threw && (b.value as legacy.LegacyDecision).decision === 'deny' && hasEmptyRule(policy);
    };
    const decisionDirection = {
      // 옛 거절 → 새 허용이 열린 쪽
      opens: (a: unknown, b: unknown) => (a as legacy.LegacyDecision).decision === 'deny' && (b as legacy.LegacyDecision).decision === 'allow',
      intended: closedOk,
    };
    compare('checkToolPolicy', { tool, input, policy, approval }, () => legacy.checkToolPolicy(tool, input, policy, approval), () => checkToolPolicy(tool, input, policy, approval), decisionBucket, decisionDirection);
    // Windows 판은 Rust를 직접 부른다(껍데기는 플랫폼 값을 넘긴다)
    const rec = (input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}) as Record<string, unknown>;
    const fileArg = typeof rec.path === 'string' ? rec.path : '';
    const cmdArg = Array.isArray(rec.command) && rec.command.every((v) => typeof v === 'string') ? (rec.command as string[]) : [];
    compare(
      'checkToolPolicy(Windows)',
      { tool, file: fileArg, policy },
      () => legacy.checkToolPolicy(tool, input, policy, approval, '\\'),
      () => {
        const out = JSON.parse(native.checkToolPolicy(tool, fileArg, cmdArg, policy ? JSON.stringify(policy) : 'null', typeof approval === 'string' ? approval : undefined, [...DEFAULT_DENIED_COMMANDS], true)) as {
          decision: 'allow' | 'deny';
          reason?: string;
        };
        return out.reason === undefined ? { tool, decision: out.decision } : { tool, decision: out.decision, reason: out.reason };
      },
      decisionBucket,
      decisionDirection,
    );
  }
}

describe('path-names·policy 차등 시험(옛 TS와 Rust 껍데기)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: ${ITERATIONS}회 × 함수 13개(Windows 판 포함)가 옛 TS와 같다`, () => {
      runSeed(seed);
    }, 600_000);
  }

  it('열린 쪽 뒤집힘이 0이고, 다른 결과는 의도한 닫힌 쪽(빈 규칙, 옛 던짐)뿐이다', () => {
    if (REPORT) {
      for (const [name, t] of tallies) {
        appendFileSync(REPORT, `${name}: 비교 ${t.compared}, 다름 ${t.different}, 열린 쪽 ${t.openFlips}, 의도한 닫힌 쪽 ${t.closedIntended}, 분포 ${JSON.stringify(Object.fromEntries(t.distribution))}\n`);
      }
    }
    const bad = [...tallies].filter(([, t]) => t.openFlips > 0 || t.different !== t.closedIntended).map(([name, t]) => `${name}: 다름 ${t.different}, 열린 쪽 ${t.openFlips}, 의도 ${t.closedIntended}\n${t.examples.join('\n')}`);
    // 의도한 차이가 없는 함수는 다른 결과가 정확히 0이어야 한다(위 조건이 그것을 포함한다)
    expect(bad).toEqual([]);
    expect(tallies.size).toBe(13);
  });

  it('결과 분포가 한쪽으로 쏠리지 않았고 입력이 비지 않았다', () => {
    for (const name of ['isProtectedPath', 'isWithinScope', 'hasApprovalToken', 'isProtectedPath(Windows)', 'isWithinScope(Windows)']) {
      expect([...tally(name).distribution.keys()].sort(), name).toEqual(['false', 'true']);
    }
    // 옛 구현은 `constructor` 같은 이름의 도구에서 던진다(의도한 차이)
    expect([...tally('isToolAllowed').distribution.keys()].sort()).toEqual(['false', 'true', '던짐']);
    for (const name of ['normalizeProjectPath', 'canonicalProjectPath', 'normalizeProjectPath(Windows)', 'canonicalProjectPath(Windows)']) {
      expect([...tally(name).distribution.keys()].sort(), name).toEqual(['경로', '꼴 없음', '루트']);
    }
    expect([...tally('foldName').distribution.keys()].sort()).toEqual(['그대로', '바뀜']);
    for (const name of ['checkToolPolicy', 'checkToolPolicy(Windows)']) {
      const keys = [...tally(name).distribution.keys()];
      expect(keys, name).toContain('허용');
      expect(keys, name).toContain('거절: path leaves the project');
      expect(keys.some((k) => k.startsWith('거절: path is outside')), name).toBe(true);
      expect(keys.some((k) => k.startsWith('거절: path is protected')), name).toBe(true);
      expect(keys.some((k) => k.startsWith('거절: command is blocked')), name).toBe(true);
      expect(keys.some((k) => k.startsWith('거절: gradle --stop')), name).toBe(true);
      expect(keys.some((k) => k.startsWith('거절: tool ')), name).toBe(true);
      expect(keys.some((k) => k.startsWith('거절: this tool requires')), name).toBe(true);
    }
    for (const [name, t] of tallies) {
      if (name === '대조') continue;
      expect(t.compared, name).toBeGreaterThan(0);
    }
  });

  it('의도한 차이: 빈 규칙은 옛 구현이 통과시켰고 새 구현은 거절한다 (`if (found)`의 거짓)', () => {
    const protectedEmpty = { protectedPaths: [''] };
    expect(legacy.checkToolPolicy('write_file', { path: 'web/x.ts' }, protectedEmpty, undefined).decision).toBe('allow');
    expect(checkToolPolicy('write_file', { path: 'web/x.ts' }, protectedEmpty, undefined)).toMatchObject({ decision: 'deny', reason: 'path is protected by execution policy: ' });
    const deniedEmpty = { deniedCommands: ['', 'git status'] };
    const command = ['sh', '-c', 'git status'];
    // 옛 구현은 `find`가 빈 글자를 찾으면 거짓으로 보아 뒤의 규칙까지 건너뛰었다
    expect(legacy.checkToolPolicy('run_in_service', { command: ['sh', '-c', ' git status'] }, deniedEmpty, undefined).decision).toBe('allow');
    expect(checkToolPolicy('run_in_service', { command: ['sh', '-c', ' git status'] }, deniedEmpty, undefined).decision).toBe('deny');
    expect(checkToolPolicy('run_in_service', { command }, deniedEmpty, undefined).decision).toBe('deny');
  });

  it('의도한 차이: 옛 구현이 던지던 이름의 도구(constructor 등)는 새 구현이 거절한다', () => {
    for (const tool of ['constructor', 'toString', '__proto__']) {
      expect(() => legacy.checkToolPolicy(tool, {}, { allowedTools: ['read_file'] }, undefined), tool).toThrow();
      expect(checkToolPolicy(tool, {}, { allowedTools: ['read_file'] }, undefined).decision, tool).toBe('deny');
      expect(isToolAllowed(tool, ['read_file']), tool).toBe(false);
    }
  });

  it('대조 장치: 경계를 바꾼 옛 구현과 결과 한 글자를 바꾼 값이 차이로 잡힌다', () => {
    const t = tally('대조');
    const before = t.different;
    // 접두 규칙의 `/`를 빼 `srcx/a`까지 범위 안으로 보는 옛 구현
    const widened = (file: string, scope: string) => file === scope || file.startsWith(scope);
    compare('대조', 'srcx/a', () => widened('srcx/a', 'src'), () => isWithinScope('srcx/a', 'src'), () => '값');
    // 대소문자를 접는 옛 구현(허용 목록에 거부 목록 함수를 쓴 옛 사고)
    compare('대조', 'SRC/a', () => legacy.canonicalProjectPath('SRC/a')!.startsWith(`${legacy.canonicalProjectPath('src')}/`), () => isWithinScope('SRC/a', 'src'), () => '값');
    // 결과 한 글자
    compare('대조', '.GIT', () => perturb(legacy.foldName('.GIT')), () => foldName('.GIT'), () => '값');
    compare('대조', 'a', () => legacy.foldName('a') + '.', () => foldName('a'), () => '값');
    // 같은 결과는 차이가 아니다
    compare('대조', '.GIT', () => legacy.foldName('.GIT'), () => foldName('.GIT'), () => '값');
    expect(t.different - before).toBe(4);
    tallies.delete('대조');
  });
});
