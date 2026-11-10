import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnv, resolveCliCommand } from './claude-cli-process';
import * as legacy from './claude-cli-process-legacy';
import { makeFixture, type Fixture } from './claude-cli-command-fixture';

/**
 * CLI 실행 파일 고르기 벡터(ADR-191 3ac). 막는 쪽이다. 기대값은 옛 TS(`claude-cli-process-legacy.ts`)가 낸 값이고, 옛 TS에서 실패하는 것은 `intended`로 표시한 의도한 차이뿐이다.
 * 의도한 차이는 모두 옛 TS가 열린 쪽으로 틀린 곳을 닫는 것이다(트러블슈팅 179).
 * 허용·인식 패턴마다 거의 같은 거부 입력을 둔다: 루트 이름의 접두인 형제 폴더, `..`로 시작하는 폴더 이름, 겹친 구분자, `..` 세그먼트, 링크, 대소문자.
 */
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

interface Vector {
  label: string;
  command?: string;
  /** PATH 항목 */
  entries: (f: Fixture) => string[];
  root?: (f: Fixture) => string | undefined;
  /** 기대: 고른 파일(fixture 기준 경로) 또는 ENOENT */
  expected: (f: Fixture) => string | 'ENOENT';
  /** 옛 TS가 다르게 읽는 의도한 차이(옛 TS가 열린 쪽으로 틀린 곳). 값은 옛 TS가 고르는 파일 */
  intended?: (f: Fixture) => string;
  /** 대소문자를 구분하지 않는 볼륨에서만 의미가 있는 차이 */
  caseInsensitiveOnly?: boolean;
}

const join = (...parts: string[]): string => parts.join(path.delimiter);
const root = (f: Fixture): string => f.project;

const VECTORS: Vector[] = [
  // 고르기
  { label: '프로젝트 밖 항목을 고른다', entries: (f) => [path.join(f.base, 'outside', 'bin')], root, expected: (f) => path.join(f.base, 'outside', 'bin', 'claude') },
  { label: '루트가 없으면 안쪽 항목도 고른다', entries: (f) => [path.join(f.project, 'bin')], root: () => undefined, expected: (f) => path.join(f.project, 'bin', 'claude') },
  { label: '안 항목을 건너뛰고 밖 항목을 고른다', entries: (f) => [path.join(f.project, 'bin'), path.join(f.base, 'outside', 'bin')], root, expected: (f) => path.join(f.base, 'outside', 'bin', 'claude') },
  // 거의 같은 거부 입력: 루트 이름의 접두인 형제는 밖이다
  { label: '이름이 루트의 접두인 형제 폴더는 밖이다', entries: (f) => [path.join(f.base, 'project-extra', 'bin')], root, expected: (f) => path.join(f.base, 'project-extra', 'bin', 'claude') },
  // 프로젝트 안
  { label: '프로젝트 안의 절대 항목', entries: (f) => [path.join(f.project, 'bin')], root, expected: () => 'ENOENT' },
  { label: '프로젝트 루트 자체', entries: (f) => [f.project], root, expected: () => 'ENOENT' },
  { label: 'node_modules/.bin', entries: (f) => [path.join(f.project, 'node_modules', '.bin')], root, expected: () => 'ENOENT' },
  { label: '루트에 끝 슬래시', entries: (f) => [path.join(f.project, 'bin')], root: (f) => `${f.project}/`, expected: () => 'ENOENT' },
  { label: '겹친 구분자', entries: (f) => [`${f.project}//bin`], root, expected: () => 'ENOENT' },
  { label: '.. 세그먼트로 돌아 들어간 항목', entries: (f) => [`${f.base}/outside/../project/bin`], root, expected: () => 'ENOENT' },
  { label: '밖으로 나갔다 다시 들어온 .. 세그먼트(밖으로 끝남)', entries: (f) => [`${f.project}/../outside/bin`], root, expected: (f) => path.join(f.base, 'outside', 'bin', 'claude') },
  { label: '프로젝트 안을 가리키는 링크 파일', entries: (f) => [path.join(f.base, 'linkin')], root, expected: () => 'ENOENT' },
  { label: '바깥을 가리키는 링크 파일', entries: (f) => [path.join(f.base, 'outlink')], root, expected: (f) => path.join(f.base, 'outlink', 'claude') },
  { label: '루트가 링크일 때 실제 폴더로 견준다', entries: (f) => [path.join(f.project, 'bin')], root: (f) => path.join(f.base, 'alias'), expected: () => 'ENOENT' },
  { label: '링크로 부른 항목도 루트의 실제 폴더 안이면 안이다', entries: (f) => [path.join(f.base, 'alias', 'bin')], root, expected: () => 'ENOENT' },
  // 의도한 차이(옛 TS가 열린 쪽으로 틀렸다)
  { label: '이름이 ..로 시작하는 폴더(..bin)는 안이다', entries: (f) => [path.join(f.project, '..bin')], root, expected: () => 'ENOENT', intended: (f) => path.join(f.project, '..bin', 'claude') },
  { label: '프로젝트 안의 링크가 바깥을 가리키면 안으로 본다', entries: (f) => [path.join(f.project, 'tools')], root, expected: () => 'ENOENT', intended: (f) => path.join(f.project, 'tools', 'claude') },
  { label: '대소문자만 다른 막을 폴더(대소문자를 구분하지 않는 볼륨)', entries: (f) => [path.join(f.base, 'project2', 'bin')], root: (f) => f.project2, expected: () => 'ENOENT', intended: (f) => path.join(f.base, 'project2', 'bin', 'claude'), caseInsensitiveOnly: true },
  { label: '빈 문자열 루트는 읽지 못한 것으로 본다(옛 TS는 프로세스의 현재 폴더로 읽었다)', entries: (f) => [path.join(f.base, 'outside', 'bin')], root: () => '', expected: () => 'ENOENT', intended: (f) => path.join(f.base, 'outside', 'bin', 'claude') },
  // 후보가 아닌 것
  { label: '빈 항목·점·상대 항목', entries: () => ['', '.', 'bin', './bin', '..'], root, expected: () => 'ENOENT' },
  { label: '따옴표로 감싼 항목', entries: (f) => [`"${path.join(f.base, 'outside', 'bin')}"`], root, expected: () => 'ENOENT' },
  { label: '끝에 공백이 붙은 항목', entries: (f) => [`${path.join(f.base, 'outside', 'bin')} `], root, expected: () => 'ENOENT' },
  { label: '실행 권한이 없는 파일', entries: (f) => [path.join(f.base, 'outside', 'noexec')], root, expected: () => 'ENOENT' },
  { label: '이름이 같은 폴더', entries: (f) => [path.join(f.base, 'outside', 'dir')], root, expected: () => 'ENOENT' },
  { label: '없는 항목', entries: (f) => [path.join(f.base, 'nope')], root, expected: () => 'ENOENT' },
  { label: '없는 항목 다음 밖 항목', entries: (f) => [path.join(f.base, 'nope'), path.join(f.base, 'outside', 'bin')], root, expected: (f) => path.join(f.base, 'outside', 'bin', 'claude') },
  { label: '읽지 못하는(없는) 루트는 안으로 본다', entries: (f) => [path.join(f.base, 'outside', 'bin')], root: (f) => path.join(f.base, 'missing'), expected: () => 'ENOENT' },
  { label: '상대 경로 루트도 읽지 못하면 안으로 본다', entries: (f) => [path.join(f.base, 'outside', 'bin')], root: () => 'no-such-root-3ac', expected: () => 'ENOENT' },
  { label: '빈 명령', command: '', entries: (f) => [path.join(f.base, 'outside', 'bin')], root, expected: () => 'ENOENT' },
  { label: '점 명령', command: '..', entries: (f) => [path.join(f.base, 'outside', 'bin')], root, expected: () => 'ENOENT' },
  // 경로가 든 명령
  { label: '상대 경로 명령', command: './claude', entries: () => [], root, expected: () => 'ENOENT' },
  { label: '하위 상대 경로 명령', command: 'bin/claude', entries: () => [], root, expected: () => 'ENOENT' },
  { label: '밖의 절대 경로 명령은 그대로', command: '@outside', entries: () => [], root, expected: (f) => path.join(f.base, 'outside', 'bin', 'claude') },
  { label: '안의 절대 경로 명령', command: '@inside', entries: () => [], root, expected: () => 'ENOENT' },
  { label: '링크로 안을 가리키는 절대 경로 명령', command: '@linkin', entries: () => [], root, expected: () => 'ENOENT' },
  { label: '..로 들어간 절대 경로 명령', command: '@dotdot', entries: () => [], root, expected: () => 'ENOENT' },
  { label: '루트가 없으면 안의 절대 경로 명령도 그대로', command: '@inside', entries: () => [], root: () => undefined, expected: (f) => path.join(f.project, 'claude') },
];

function commandOf(vector: Vector, f: Fixture): string {
  switch (vector.command) {
    case '@outside': return path.join(f.base, 'outside', 'bin', 'claude');
    case '@inside': return path.join(f.project, 'claude');
    case '@linkin': return path.join(f.base, 'linkin', 'claude');
    case '@dotdot': return `${f.base}/outside/../project/claude`;
    default: return vector.command ?? 'claude';
  }
}

let f: Fixture;
let caseInsensitive = false;
beforeAll(() => {
  f = makeFixture();
  // 대소문자를 구분하지 않는 볼륨인가(다른 대소문자의 이름이 같은 폴더를 가리키는가)
  try {
    chmodSync(path.join(f.base, 'project2'), 0o755);
    caseInsensitive = true;
  } catch {
    caseInsensitive = false;
  }
});
afterAll(() => rmSync(f.base, { recursive: true, force: true }));

function outcomeOf(resolve: typeof resolveCliCommand, vector: Vector): string {
  const entries = vector.entries(f).join(path.delimiter);
  try {
    return resolve(commandOf(vector, f), { PATH: entries }, vector.root ? vector.root(f) : root(f));
  } catch (error) {
    expect((error as { code?: string }).code).toBe('ENOENT');
    return 'ENOENT';
  }
}

posixOnly('CLI 실행 파일 고르기 벡터', () => {
  for (const vector of VECTORS) {
    it(`새 구현: ${vector.label}`, () => {
      if (vector.caseInsensitiveOnly && !caseInsensitive) {
        // 구분하는 볼륨에서는 없는 경로라 읽지 못해 어느 쪽이든 닫힌다
        expect(outcomeOf(resolveCliCommand, vector)).toBe('ENOENT');
        return;
      }
      expect(outcomeOf(resolveCliCommand, vector)).toBe(vector.expected(f));
    });
    it(`옛 구현에서도 같거나 의도한 차이만 다르다: ${vector.label}`, () => {
      const old = outcomeOf(legacy.resolveCliCommand, vector);
      if (vector.intended && !(vector.caseInsensitiveOnly && !caseInsensitive)) {
        expect(old, '옛 TS는 열린 쪽으로 틀렸다').toBe(vector.intended(f));
        expect(old).not.toBe(vector.expected(f));
      } else if (vector.caseInsensitiveOnly) {
        expect(old).toBe('ENOENT');
      } else {
        expect(old).toBe(vector.expected(f));
      }
    });
  }

  it('벡터 수와 의도한 차이 수', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(37);
    expect(VECTORS.filter((vector) => vector.intended).length).toBe(4);
  });
});

posixOnly('자식 PATH 벡터', () => {
  const cases: Array<[string, (f: Fixture) => string, (f: Fixture) => string, boolean]> = [
    ['밖 항목은 남기고 빈·상대 항목은 뺀다', (x) => join('', '.', 'rel', path.join(x.base, 'outside', 'bin')), (x) => path.join(x.base, 'outside', 'bin'), false],
    ['안 항목을 뺀다', (x) => join(path.join(x.project, 'bin'), path.join(x.base, 'outside', 'bin')), (x) => path.join(x.base, 'outside', 'bin'), false],
    ['형제 폴더는 남긴다', (x) => path.join(x.base, 'project-extra', 'bin'), (x) => path.join(x.base, 'project-extra', 'bin'), false],
    ['없는 항목(읽지 못함)은 뺀다', (x) => join(path.join(x.base, 'nope'), path.join(x.base, 'outside', 'bin')), (x) => path.join(x.base, 'outside', 'bin'), false],
    ['루트의 링크로 부른 항목을 뺀다', (x) => path.join(x.base, 'alias', 'bin'), () => '', false],
    ['..bin을 뺀다(옛 TS는 남겼다)', (x) => path.join(x.project, '..bin'), () => '', true],
    ['안의 링크가 바깥을 가리켜도 뺀다(옛 TS는 남겼다)', (x) => path.join(x.project, 'tools'), () => '', true],
  ];
  for (const [label, entries, expected, intended] of cases) {
    it(label, () => {
      expect(childEnv({ PATH: entries(f), HOME: '/h' }, f.project)).toEqual({ PATH: expected(f), HOME: '/h' });
      const old = legacy.childEnv({ PATH: entries(f), HOME: '/h' }, f.project);
      if (intended) expect(old.PATH).toBe(entries(f));
      else expect(old.PATH).toBe(expected(f));
    });
  }
  it('PATH가 없으면 그대로, 루트가 없으면 절대 항목만 거른다', () => {
    expect(childEnv({ HOME: '/h' }, f.project)).toEqual({ HOME: '/h' });
    expect(childEnv({ PATH: ':.:/usr/bin:rel' })).toEqual({ PATH: '/usr/bin' });
  });
});

posixOnly('짝 없는 서로게이트가 든 경로', () => {
  it('확인한 경로와 띄울 경로의 UTF-8 바이트가 같다(둘 다 U+FFFD가 된다)', () => {
    const dir = path.join(f.base, 'sur�rogate', 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n');
    chmodSync(path.join(dir, 'claude'), 0o755);
    for (const lone of ['\ud800', '\udbff', '\udc00', '\udfff']) {
      const entry = path.join(f.base, `sur${lone}rogate`, 'bin');
      const resolved = resolveCliCommand('claude', { PATH: entry }, f.project);
      const old = legacy.resolveCliCommand('claude', { PATH: entry }, f.project);
      expect(Buffer.from(resolved, 'utf8').equals(Buffer.from(old, 'utf8'))).toBe(true);
      expect(Buffer.from(resolved, 'utf8').toString('utf8')).toBe(path.join(dir, 'claude'));
    }
  });
  it('프로젝트 안에서 그 이름을 부르는 항목은 서로게이트가 있어도 안이다', () => {
    const dir = path.join(f.project, 'in�side');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n');
    chmodSync(path.join(dir, 'claude'), 0o755);
    for (const lone of ['\ud800', '\udc00']) {
      expect(() => resolveCliCommand('claude', { PATH: path.join(f.project, `in${lone}side`) }, f.project)).toThrow(/ENOENT/);
      expect(childEnv({ PATH: path.join(f.project, `in${lone}side`) }, f.project).PATH).toBe('');
    }
  });
});
