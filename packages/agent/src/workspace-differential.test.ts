import { appendFileSync } from 'node:fs';
import nodePath from 'node:path';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { Gen, outcome, readEnvList, readEnvNumber } from './differential-kit';
import { foldName as legacyFold } from './path-policy-legacy';
import * as legacy from './workspace-legacy';

/**
 * workspace.ts의 막는 검사를 Rust로 옮기면서(ADR-191 3단계 3w) 옛 TS 구현(`workspace-legacy.ts`)과 새 판정에 같은 무작위 입력을 넣어 견준다.
 * Windows 판(`path.win32`, 역슬래시 구분자)은 Rust 함수를 직접 불러 옛 구현의 win32 판과 견준다(이 기계는 POSIX라 껍데기는 늘 POSIX 값을 넘긴다).
 *
 * **막는 검사라 다른 결과를 방향으로 센다.** 열린 쪽 뒤집힘(옛 막음 → 새 통과, 옛 밖 → 새 안, 옛 거절 → 새 통과)은 0이어야 한다.
 * 닫힌 쪽 차이는 `.env.` 뒤에 줄 끝 글자가 오는 이름뿐이어야 한다(의도한 차이, 모듈 문서 참고).
 * 크기는 환경 변수로 바꾼다: WORKSPACE_DIFF_SEEDS(쉼표 목록), WORKSPACE_DIFF_ITERATIONS, WORKSPACE_DIFF_REPORT=<파일 경로>
 */
const SEEDS = readEnvList('WORKSPACE_DIFF_SEEDS', [1, 7, 42, 2026]);
const ITERATIONS = readEnvNumber('WORKSPACE_DIFF_ITERATIONS', 3000);
const REPORT = process.env.WORKSPACE_DIFF_REPORT;

const NAMES = [
  '.git', '.GIT', '.Git', '.git.', '.git ', '.git. .', '.gi\u200Bt', '.g\u200Dit', '\uFF0E\uFF47\uFF49\uFF54', '.g\u0131t', '.\u0067\u0069\u0074\u0301', 'ſ', '\u212Aafka',
  'node_modules', 'Node_Modules', 'NODE_MODULES', 'node_modules.', '.next', '.NEXT', 'build', 'BUILD', 'Build ', 'builds', '.gradle', '.venv', '__pycache__', '__PYCACHE__', 'ｂｕｉｌｄ', 'bu\u200Bild',
  '.env', '.ENV', '.Env', '.env.', '.env ', '.env..', '.env.local', '.env.production', '.ENV.LOCAL', '.env.local.', '.env.local ', '.env.x\u200By', '\uFF0Eenv', '.env\u200B', '\u200B.env', '.env\u0301', '.envx', '.env_local', 'env', '.ènv',
  '.env.example', '.ENV.EXAMPLE', '.Env.Example', '.env.sample', '.env.template', '.env.dist', '.env.local.example', '.env.production.dist', '.env.a-b_c.template', '.env.example.', '.env.example ', '.env.exam\u200Bple', '.env.examples',
  '.env.example.x', '.env..example', '.env.\uFF45xample', '.env.exa mple', '.env.\u00E9.example', '.env.example\u0301', '.env.\u212Aexample', '.env.EXAMPLE\u200B', '.env.\u0131dist', '.env.d\u0130st', '.env.exampl\u212A',
  '.env.\n', '.env.\r', '.env.\u2028', '.env.\u2029', '.env.local\n', '.env.local\u2028x', '.env.a\nb', '.env.example\n', '.env.example\r', '.env\n', '.env.\nexample', '.env.\n.example',
  '.env.\ud800', '.env\ud800', '.env.\udc00x', '\ud800.env', '.git\ud800', '.env.exa\ud800mple', '.env.example\udfff', 'a\ud83d', '\ud83d',
  'src', 'Src', 'app', 'web', 'a', 'x', '', '.', '..', '...', ' ', '문서', '문서'.normalize('NFD'), 'a\0b', 'a\\b', '\\', '😀', '\u2215', 'a\uFF0Fb',
];
const SEPS = ['/', '/', '/', '/', '//', '\\', '/./', '/../', '\\\\', '/ /'];
const LINE_END = /[\n\r\u2028\u2029]/;

function nameOf(g: Gen): string {
  if (g.chance(0.15)) return g.text([...'.envEXAMPLEsampltdist-_ \u200B\u0301\uFF45ſK\n\r\u2028\ud800\udc00'], g.int(9));
  return g.pick(NAMES);
}

function pathOf(g: Gen): string {
  const count = 1 + g.int(4);
  let out = '';
  for (let i = 0; i < count; i++) out += (i > 0 ? g.pick(SEPS) : '') + nameOf(g);
  return g.pick(['', '', '', '', './', '/', '../', 'C:/', 'C:\\', 'C:', '\\', './/', '\\\\srv\\x']) + out + g.pick(['', '', '', '/', '//', '/.', '\\']);
}

const ROOTS = ['/work/proj', '/work/proj/', '/', '/work/..proj', '/work/pro\u200Bj', '/w\ud800'];
const WIN_ROOTS = ['C:\\work\\proj', 'c:\\Work\\Proj', 'C:\\', '\\\\srv\\share\\proj', 'D:\\proj'];

function targetOf(g: Gen, root: string, win: boolean): string {
  const join = win ? nodePath.win32.join : nodePath.posix.join;
  const base = g.pick([root, root, join(root, '..'), join(root, '..', 'proj2'), join(root, '..proj'), '/etc', 'C:\\Windows', 'c:\\WORK\\proj\\x', 'D:\\proj\\x', '\\\\srv\\share\\proj\\x', '\\\\srv\\share2\\x']);
  const parts = g.list(0, 3, () => g.pick(['..', '.', '...', '..x', 'a', 'a b', nameOf(g), '..\\x', '../..']));
  return win ? nodePath.win32.resolve(base, ...parts) : nodePath.posix.resolve(base, ...parts);
}

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

/** 참=막음/안쪽/문제 있음. `blockedWhenTrue`: 참이 막는 쪽이면 true(거부 목록·입력 검사), 참이 여는 쪽이면 false(isInside) */
function compare(name: string, input: unknown, old: () => boolean | number, next: () => boolean | number, blockedWhenTrue: boolean, intended: (input: unknown) => boolean): void {
  const a = outcome(old);
  const b = outcome(next);
  const t = tally(name);
  t.compared += 1;
  const key = a.threw ? 'threw' : String(a.value);
  t.distribution.set(key, (t.distribution.get(key) ?? 0) + 1);
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  t.different += 1;
  const av = a.threw ? undefined : (a.value as boolean | number);
  const bv = b.threw ? undefined : (b.value as boolean | number);
  // 열린 쪽: 옛 판정이 막았는데(또는 안이 아니라 했는데) 새 판정이 통과(안쪽)시킨다. 던진 쪽이 있으면 따로 센다(열린 쪽으로 친다)
  const blocked = (v: boolean | number | undefined): boolean => (blockedWhenTrue ? Boolean(v) : !v);
  const opened = a.threw || b.threw || (blocked(av) && !blocked(bv));
  const isIntended = !opened && intended(input);
  if (opened) t.openFlips += 1;
  else if (isIntended) t.closedIntended += 1;
  if (!isIntended && t.examples.length < 3) t.examples.push(`입력 ${JSON.stringify(input)}\n옛 ${JSON.stringify(a)}\n새 ${JSON.stringify(b)}`);
}

/** 의도한 닫힌 쪽 차이의 조건: 접은 꼴이 `.env.`로 시작하고 그 뒤에 줄 끝 글자가 든 이름(옛 `.`이 못 맞춘 것)이 한 조각이라도 있다 */
const intendedEnvNewline = (input: unknown): boolean =>
  typeof input === 'string' &&
  input
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => {
      const folded = legacyFold(segment);
      return folded.startsWith('.env.') && LINE_END.test(folded.slice(5));
    });

function runSeed(seed: number): void {
  const g = new Gen(seed);
  for (let i = 0; i < ITERATIONS; i++) {
    const segment = nameOf(g);
    compare('isDenied(조각)', segment, () => legacy.isDenied(segment), () => native.workspaceIsDenied(segment), true, intendedEnvNewline);

    const file = pathOf(g);
    compare('isSecretFile(경로)', file, () => legacy.isSecretFile(file), () => native.workspaceIsSecretFile(file), true, intendedEnvNewline);

    const win = g.chance(0.4);
    const root = g.pick(win ? WIN_ROOTS : ROOTS);
    const target = targetOf(g, root, win);
    const p = win ? nodePath.win32 : nodePath.posix;
    compare(
      win ? 'isInside(win32)' : 'isInside(posix)',
      { root, target },
      () => legacy.isInside(root, target, p),
      () => native.workspaceIsInside(encodeLoneSurrogates(p.relative(root, target)), win),
      false,
      () => false,
    );

    const input = pathOf(g);
    for (const winInput of [false, true]) {
      const q = winInput ? nodePath.win32 : nodePath.posix;
      compare(
        `입력 글자 검사(${winInput ? 'win32' : 'posix'})`,
        input,
        () => legacy.resolveInputProblem(input, q),
        () => native.workspaceInputProblem(input, winInput, false),
        true,
        () => false,
      );
      compare(
        `바깥 변경 검사(${winInput ? 'win32' : 'posix'})`,
        input,
        () => legacy.externalInputProblem(input, q),
        () => native.workspaceInputProblem(input, winInput, true),
        true,
        () => false,
      );
    }
  }
}

describe('workspace 막는 검사 차등 시험(옛 TS 대 Rust)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: ${ITERATIONS}회씩`, () => {
      runSeed(seed);
    });
  }

  it('열린 쪽 뒤집힘 0, 설명되지 않은 차이 0, 분포가 비지 않음', () => {
    const lines: string[] = [];
    let open = 0;
    let unexplained = 0;
    for (const [name, t] of tallies) {
      open += t.openFlips;
      unexplained += t.different - t.closedIntended - t.openFlips;
      lines.push(`${name}: 비교 ${t.compared}, 차이 ${t.different}(의도한 닫힌 쪽 ${t.closedIntended}, 열린 쪽 ${t.openFlips}), 옛 분포 ${JSON.stringify(Object.fromEntries(t.distribution))}`);
      // 입력이 한쪽으로만 쏠리지 않았는지: 참·거짓 둘 다 나와야 시험이 뜻을 가진다
      expect(t.distribution.size, `${name} 분포`).toBeGreaterThanOrEqual(2);
      expect(t.examples, `${name} 설명되지 않은 차이`).toEqual([]);
    }
    console.log(`[workspace-differential] 시드 ${SEEDS.join(',')} × ${ITERATIONS}회\n${lines.join('\n')}\n열린 쪽 뒤집힘 합 ${open}`);
    if (REPORT) appendFileSync(REPORT, `${lines.join('\n')}\n열린 쪽 뒤집힘 합 ${open}\n`);
    expect(open).toBe(0);
    expect(unexplained).toBe(0);
    expect(tallies.size).toBe(8);
  });

  it('대조 장치: 한 곳을 어긋나게 한 옛 구현이 차이로 잡힌다', () => {
    const mutants: Array<[string, (segment: string) => boolean]> = [
      ['대소문자 접기를 뺌', (s) => legacy.isDenied(s === s.toLowerCase() ? s : `${s}\u0000`) && s === s.toLowerCase()],
      ['예시 파일 예외를 항상 적용', (s) => legacy.isDenied(s) && !/^\.env/i.test(s)],
      ['.env 접두 일치로 넓힘(.envx도 막음)', (s) => legacy.isDenied(s) || /^\.envx/.test(s)],
      ['예시 파일 예외를 안 둠', (s) => legacy.isDenied(s) || /^\.env\.[\w-]+\.example$/i.test(s)],
    ];
    const g = new Gen(99);
    for (const [name, mutant] of mutants) {
      let found = false;
      for (let i = 0; i < 4000 && !found; i++) {
        const segment = nameOf(g);
        if (mutant(segment) !== native.workspaceIsDenied(segment)) found = true;
      }
      expect(found, name).toBe(true);
    }
    // 안쪽 판정: 경계 ±1(`..`로 시작하는 이름을 바깥으로 읽음), 절대 경로 검사 빼기
    const rels = ['..', '../a', '..a', '..a/b', '', 'a', '/x'];
    const mutantInside: Array<[string, (rel: string) => boolean]> = [
      ['..로 시작하면 바깥', (r) => r === '' || !r.startsWith('..')],
      ['.. 자체를 안쪽으로', (r) => r === '' || r === '..' || (!r.startsWith('../') && !r.startsWith('/'))],
      ['절대 경로 검사 뺌', (r) => r === '' || (r !== '..' && !r.startsWith('../'))],
    ];
    for (const [name, mutant] of mutantInside) {
      expect(
        rels.some((r) => mutant(r) !== native.workspaceIsInside(r, false)),
        name,
      ).toBe(true);
    }
  });
});
