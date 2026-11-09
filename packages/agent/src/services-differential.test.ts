import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stripAnsi } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { cliPreflightFailure, describeCliError } from './cli-failure';
import { Gen, perturb, readEnvList, readEnvNumber, wellFormed } from './differential-kit';
import { isComposeFile, ownsFile, servicesForFiles } from './services';

/**
 * 서비스 소유 판정과 CLI 실패 설명을 Rust로 옮기면서(ADR-191 3l) 옛 TS 구현을 아래 `legacy*`에 그대로 두고, 같은 무작위 입력을 옛 구현과
 * 새 껍데기에 넣어 결과를 JSON 글자(키 순서 포함)로 견준다. 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 입력은 충돌을 일부러 만든다: 서비스 경로·includes·파일을 같은 조각 풀에서 뽑아(`a`·`ab`·`A`·`.hidden`·`..`·NFC/NFD·빈 조각·`.`,
 * 앞 `./`, 끝 `/` 여러 개, `//`) 접두·대소문자·정규화 경계가 자주 부딪친다. root·composePath도 풀에서 뽑고(루트 밖, 끝 `/`, 같은 경로, 빈 값) 상대 경로도 섞는다.
 * 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(의도한 차이): 파일 이름 비교에는 넣지 않고 CLI 오류 글에만 넣는다.
 *
 * 열린 쪽 뒤집힘: 옛 구현이 서비스를 골랐거나 소유한다고 했는데 새 구현이 안 고른 수(`open`). 반대쪽은 `closed`. 둘 다 0이어야 한다.
 * 크기는 환경 변수로 바꾼다: SERVICES_DIFF_SEEDS(쉼표 목록), SERVICES_DIFF_ITERATIONS, SERVICES_DIFF_REPORT=1(분포 출력)
 */

// ===== 옛 services.ts (변이 장치를 위해 mut 인자를 더했다. mut가 없으면 옛 본문과 같다) =====
type Mut = 'prefixNoSlash' | 'noEmptyRoot' | 'noExactMatch' | 'firstOwner' | 'noProjectWide' | 'noUnmatchedWhenEmpty' | 'normalizeFile' | 'noNormalizeRoot' | 'noComposeNormalize';

const LEGACY_SPEC_FILE = 'studio.yaml';

function legacyNormalize(servicePath: string): string {
  return servicePath.replace(/^\.\/?/, '').replace(/\/+$/, '');
}

function legacyIsUnderRoot(file: string, root: string, mut?: Mut): boolean {
  const normalized = mut === 'noNormalizeRoot' ? root : legacyNormalize(root);
  const f = mut === 'normalizeFile' ? legacyNormalize(file) : file;
  return (mut === 'noEmptyRoot' ? false : normalized === '') || (mut === 'noExactMatch' ? false : f === normalized) || f.startsWith(mut === 'prefixNoSlash' ? normalized : `${normalized}/`);
}

function legacyOwnsFile(service: { path: string; includes?: string[] }, file: string, mut?: Mut): boolean {
  return [service.path, ...(service.includes ?? [])].some((root) => legacyIsUnderRoot(file, root, mut));
}

function legacyProjectWide(project: LoadedProject, mut?: Mut): Set<string> {
  const files = new Set([LEGACY_SPEC_FILE]);
  if (mut !== 'noProjectWide' && project.root && project.composePath) files.add(mut === 'noComposeNormalize' ? path.relative(project.root, project.composePath) : legacyNormalize(path.relative(project.root, project.composePath)));
  return files;
}

function legacyServicesForFiles(project: LoadedProject, files: readonly string[], mut?: Mut): { services: string[]; unmatched: string[] } {
  const hit = new Set<string>();
  const unmatched: string[] = [];
  const projectWide = legacyProjectWide(project, mut);
  for (const file of files) {
    if (projectWide.has(legacyNormalize(file))) {
      for (const [name] of project.managed) hit.add(name);
      if (mut !== 'noUnmatchedWhenEmpty' && project.managed.length === 0) unmatched.push(file);
      continue;
    }
    const owners = project.managed.filter(([, service]) => legacyOwnsFile(service, file, mut));
    if (owners.length > 0) (mut === 'firstOwner' ? owners.slice(0, 1) : owners).forEach(([name]) => hit.add(name));
    else unmatched.push(file);
  }
  return { services: project.managed.map(([name]) => name).filter((name) => hit.has(name)), unmatched };
}

function legacyIsComposeFile(project: Pick<LoadedProject, 'root' | 'composePath'>, file: string): boolean {
  if (!project.root || !project.composePath) return false;
  return legacyNormalize(file) === legacyNormalize(path.relative(project.root, project.composePath));
}

// ===== 옛 cli-failure.ts =====
function legacyDescribeCliError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return stripAnsi(raw).trim();
}

function legacyCliPreflightFailure(summary: string, error: unknown) {
  const detail = legacyDescribeCliError(error);
  return { ok: false, reason: detail ? `${summary} (${detail})` : summary, summary, detail };
}

// ===== 입력 생성 =====
const SEGMENTS = ['a', 'ab', 'A', 'a b', '.hidden', '..', '.', '', 'x', 'api', 'web', 'shared', 'é', 'é', 'Ａ', 'compose.yaml', 'studio.yaml', 'docker', 'a.', 'a\\b', 'a​'];
const ROOTS = ['/p', '/p/', '/p//', '/', '', '/p/app', '/p/app/', 'p', './p', '/p/.', '/p/..', '/p/é', '/p/é'];
const COMPOSE_NAMES = ['compose.yaml', 'docker-compose.yml', 'a/compose.yaml', '../compose.yaml', 'x/../compose.yaml', 'compose.yaml/', './compose.yaml', '', '.hidden/c.yml', 'é.yml', 'é.yml'];

function genPath(gen: Gen): string {
  const parts = gen.list(0, 3, () => gen.pick(SEGMENTS));
  let text = parts.join(gen.weighted([[8, '/'], [1, '//'], [1, '\\']] as const));
  if (gen.chance(0.2)) text = `./${text}`;
  if (gen.chance(0.1)) text = `/${text}`;
  if (gen.chance(0.25)) text += gen.weighted([[5, '/'], [2, '//'], [1, '///']] as const);
  return text;
}

function genRoot(gen: Gen): string {
  return gen.chance(0.35) ? genPath(gen) : gen.pick(['a', 'ab', 'web', 'api', '.', './', '/', '', './a/', 'a//', '.hidden', 'shared']);
}

function genFile(gen: Gen, roots: string[]): string {
  if (gen.chance(0.45) && roots.length > 0) {
    // 서비스 루트에서 파생: 그대로, 아래, 접두만 같음, 대소문자, 정규화 다름
    const base = gen.pick(roots);
    const norm = legacyNormalize(base);
    return gen.weighted<string>([
      [3, norm],
      [4, `${norm}/${genPath(gen)}`],
      [2, `${norm}${gen.pick(['b', 'x', '/', '//', '.', ' '])}`],
      [2, `./${norm}/${gen.pick(SEGMENTS)}`],
      [1, norm.toUpperCase()],
      [1, norm.normalize('NFD')],
      [1, norm.normalize('NFC') + '/f'],
      [1, base],
    ]);
  }
  return genPath(gen);
}

interface Case {
  project: LoadedProject;
  files: string[];
}

function genCase(gen: Gen): Case {
  const count = gen.weighted([[1, 0], [3, 1], [4, 2], [2, 3], [1, 4]] as const);
  const managed = Array.from({ length: count }, (_, i): [string, { path: string; includes?: string[] }] => {
    const includes = gen.chance(0.4) ? gen.list(0, 3, () => genRoot(gen)) : undefined;
    // 같은 이름이 둘 나올 때도 있다(옛 코드는 이름 집합으로 거른다)
    return [gen.chance(0.08) ? 's0' : `s${i}`, { path: genRoot(gen), ...(includes ? { includes } : {}) }];
  });
  const roots = managed.flatMap(([, s]) => [s.path, ...(s.includes ?? [])]);
  const root = gen.weighted<string | undefined>([[12, gen.pick(ROOTS)], [1, ''], [1, undefined]]);
  const composeName = gen.pick(COMPOSE_NAMES);
  const composePath = gen.weighted<string | undefined>([
    [8, root && root.endsWith('/') ? `${root}${composeName}` : `${root ?? ''}/${composeName}`],
    [2, composeName],
    [1, ''],
    [1, undefined],
    [1, gen.pick(ROOTS)],
  ]);
  const files = gen.list(0, 6, () =>
    gen.chance(0.2) ? gen.pick(['studio.yaml', './studio.yaml', 'studio.yaml/', 'compose.yaml', './compose.yaml', 'docker-compose.yml', 'a/compose.yaml', 'Studio.yaml', 'studio.yaml.bak']) : genFile(gen, roots),
  );
  const project = { managed, ...(root === undefined ? {} : { root }), ...(composePath === undefined ? {} : { composePath }) } as unknown as LoadedProject;
  return { project, files };
}

const ERRORS: Array<() => unknown> = [
  () => new Error('\u001b[31m✖\u001b[39m Not authenticated\n'),
  () => new Error('  \u001b[2K\u001b[1Gdone  '),
  () => new Error(''),
  () => new Error('\u0085x\u0085'),
  () => new Error('﻿ x  '),
  () => new Error('\u001b]8;;http://x\u0007link\u001b]8;;\u0007'),
  () => new Error('\u001b['),
  () => new Error('\u009b31mred'),
  () => new Error('lone \ud800 surrogate'),
  () => 'Command failed: codex login status\n\u001b[1mx\u001b[0m',
  () => '   ',
  () => '',
  () => null,
  () => undefined,
  () => 42,
  () => ({}),
  () => ({ message: 'm' }),
  () => ({ toString: () => '  \u001b[31mobj\u001b[0m ' }),
  () => Object.assign(new Error('outer'), { cause: 'inner' }),
  () => [1, 2],
];

const SEEDS = readEnvList('SERVICES_DIFF_SEEDS', [1, 7, 42, 2026]);
const ITERATIONS = readEnvNumber('SERVICES_DIFF_ITERATIONS', 3000);
const REPORT = process.env['SERVICES_DIFF_REPORT'] === '1';

type Outcome = { threw: true } | { threw: false; value: unknown };
function run(fn: () => unknown): Outcome {
  try {
    return { threw: false, value: fn() };
  } catch {
    return { threw: true };
  }
}
function same(a: Outcome, b: Outcome): boolean {
  if (a.threw || b.threw) return a.threw === b.threw;
  return JSON.stringify(a.value) === JSON.stringify(b.value) && isDeepStrictEqual(a.value, b.value);
}

interface Tally {
  runs: number;
  differ: number;
  /** 옛 구현은 서비스를 골랐는데 새 구현은 안 골랐거나(재시작·확인에서 빠짐), 옛 구현은 소유·compose라 했는데 새 구현은 아니라고 한 수 */
  open: number;
  closed: number;
  buckets: Record<string, number>;
}

function newTally(): Tally {
  return { runs: 0, differ: 0, open: 0, closed: 0, buckets: {} };
}
function bump(tally: Tally, key: string): void {
  tally.buckets[key] = (tally.buckets[key] ?? 0) + 1;
}

function compareMapping(tally: Tally, legacy: Outcome, current: Outcome): void {
  tally.runs++;
  if (same(legacy, current)) return;
  tally.differ++;
  if (legacy.threw || current.threw) return;
  const a = legacy.value as { services: string[]; unmatched: string[] };
  const b = current.value as { services: string[]; unmatched: string[] };
  if (a.services.some((s) => !b.services.includes(s)) || b.unmatched.length > a.unmatched.length) tally.open++;
  if (b.services.some((s) => !a.services.includes(s)) || b.unmatched.length < a.unmatched.length) tally.closed++;
}

function mappingBucket(value: { services: string[]; unmatched: string[] }, project: LoadedProject, files: string[]): string {
  if (files.length === 0) return '파일 없음';
  if (project.managed.length === 0) return value.unmatched.length > 0 ? '서비스 없음·모두 못 찾음' : '서비스 없음·찾음';
  if (value.unmatched.length === files.length && value.services.length === 0) return '모두 못 찾음';
  if (value.unmatched.length === 0 && value.services.length === project.managed.length && project.managed.length > 1) return '전체 선택';
  if (value.services.length > 0 && value.unmatched.length > 0) return '일부만 찾음';
  return value.services.length > 1 ? '여럿 선택' : '하나 선택';
}

function sweep(seed: number, tally: Tally, mut?: Mut): void {
  const gen = new Gen(seed);
  // 대조 장치는 크기를 키우지 않는다(변이는 몇천 번 안에 잡혀야 한다)
  const count = mut ? Math.min(ITERATIONS, 3000) : ITERATIONS;
  for (let i = 0; i < count; i++) {
    const { project, files } = genCase(gen);
    const legacy = run(() => legacyServicesForFiles(project, files));
    const current = mut ? run(() => legacyServicesForFiles(project, files, mut)) : run(() => servicesForFiles(project, files));
    if (!mut && !legacy.threw) bump(tally, mappingBucket(legacy.value as { services: string[]; unmatched: string[] }, project, files));
    else if (!mut) bump(tally, '던짐');
    compareMapping(tally, legacy, current);
  }
}

describe('서비스 소유 판정: 옛 TS 구현과 Rust 껍데기의 차등 시험', () => {
  for (const seed of SEEDS) {
    it(`servicesForFiles 시드 ${seed}: 같은 입력에 같은 결과(JSON 글자, 키 순서 포함), 열린 쪽 뒤집힘 0`, () => {
      const tally = newTally();
      sweep(seed, tally);
      if (REPORT) console.log(`[차등] servicesForFiles 시드 ${seed}: 비교 ${tally.runs}, 다름 ${tally.differ}, 열린 쪽 ${tally.open}, 닫힌 쪽 ${tally.closed}, 분포 ${JSON.stringify(tally.buckets)}`);
      expect(tally.runs).toBe(ITERATIONS);
      // 입력이 비지 않았고 분포가 여러 갈래다(한쪽으로 몰린 입력으로 통과하지 않게)
      expect(Object.keys(tally.buckets).length).toBeGreaterThanOrEqual(5);
      expect(tally.buckets['모두 못 찾음'] ?? 0).toBeGreaterThan(ITERATIONS * 0.01);
      expect((tally.buckets['하나 선택'] ?? 0) + (tally.buckets['여럿 선택'] ?? 0) + (tally.buckets['전체 선택'] ?? 0)).toBeGreaterThan(ITERATIONS * 0.1);
      expect(tally.open).toBe(0);
      expect(tally.closed).toBe(0);
      expect(tally.differ).toBe(0);
    });

    it(`ownsFile·isComposeFile 시드 ${seed}: 같은 입력에 같은 판정`, () => {
      const gen = new Gen(seed + 1000);
      let runs = 0;
      let owned = 0;
      let notOwned = 0;
      let compose = 0;
      let notCompose = 0;
      let open = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const { project, files } = genCase(gen);
        for (const [, service] of project.managed) {
          for (const file of files) {
            const legacy = legacyOwnsFile(service, file);
            const current = ownsFile(service, file);
            runs++;
            if (legacy) owned++;
            else notOwned++;
            if (legacy && !current) open++;
            expect(current).toBe(legacy);
          }
        }
        for (const file of files) {
          const legacy = legacyIsComposeFile(project, file);
          const current = isComposeFile(project, file);
          if (legacy) compose++;
          else notCompose++;
          if (legacy && !current) open++;
          expect(current).toBe(legacy);
        }
      }
      if (REPORT) console.log(`[차등] ownsFile·isComposeFile 시드 ${seed}: 비교 ${runs}, 소유 ${owned}/아님 ${notOwned}, compose ${compose}/아님 ${notCompose}, 열린 쪽 ${open}`);
      expect(runs).toBeGreaterThan(0);
      expect(owned).toBeGreaterThan(0);
      expect(notOwned).toBeGreaterThan(0);
      expect(compose).toBeGreaterThan(0);
      expect(notCompose).toBeGreaterThan(0);
      expect(open).toBe(0);
    });
  }

  it('대조 장치: 옛 구현의 비교 한 줄을 바꾼 변이는 모두 차이로 잡힌다', () => {
    const muts: Mut[] = ['prefixNoSlash', 'noEmptyRoot', 'noExactMatch', 'firstOwner', 'noProjectWide', 'noUnmatchedWhenEmpty', 'normalizeFile', 'noNormalizeRoot', 'noComposeNormalize'];
    for (const mut of muts) {
      const tally = newTally();
      for (const seed of SEEDS) sweep(seed, tally, mut);
      if (REPORT) console.log(`[대조] ${mut}: 비교 ${tally.runs}, 잡힌 차이 ${tally.differ}`);
      expect(tally.differ, mut).toBeGreaterThan(0);
    }
  });

  it('대조 장치: 결과 한 글자·경계 하나를 바꾼 "새 결과"도 차이로 잡는다', () => {
    const gen = new Gen(5);
    let caught = 0;
    let tried = 0;
    for (let i = 0; i < 200; i++) {
      const { project, files } = genCase(gen);
      const legacy = run(() => legacyServicesForFiles(project, files));
      if (legacy.threw) continue;
      tried++;
      if (!same(legacy, { threw: false, value: perturb(legacy.value) })) caught++;
    }
    expect(tried).toBeGreaterThan(100);
    expect(caught).toBe(tried);
  });

  it('참조 동일성: unmatched는 입력 파일의 같은 문자열이다(짝 없는 서로게이트 이름도 그대로)', () => {
    const lone = 'zz/\ud800';
    const project = { managed: [['s', { path: 'a' }]], root: '/p', composePath: '/p/compose.yaml' } as unknown as LoadedProject;
    expect(servicesForFiles(project, [lone, 'a/x'])).toEqual({ services: ['s'], unmatched: [lone] });
  });
});

describe('CLI 실패 설명: 옛 TS 구현과 Rust 껍데기의 차등 시험', () => {
  it('describeCliError·cliPreflightFailure: 같은 입력에 같은 결과(짝 없는 서로게이트는 U+FFFD로 맞춰 견줌)', () => {
    const gen = new Gen(11);
    const summaries = ['', '요약', 'Codex CLI에 로그인돼 있지 않습니다. "codex"를 실행하세요.', ' 앞뒤 공백 ', 'x\ud800'];
    let runs = 0;
    let empty = 0;
    let nonEmpty = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const make = gen.pick(ERRORS);
      const summary = gen.pick(summaries);
      const errorA = make();
      const errorB = make();
      const a = run(() => legacyDescribeCliError(errorA));
      const b = run(() => describeCliError(errorB));
      expect(same({ threw: false, value: wellFormed(a.threw ? null : a.value) }, { threw: false, value: wellFormed(b.threw ? null : b.value) })).toBe(true);
      expect(a.threw).toBe(b.threw);
      const c = run(() => legacyCliPreflightFailure(summary, errorA));
      const d = run(() => cliPreflightFailure(summary, errorB));
      expect(a.threw || b.threw || c.threw || d.threw).toBe(false);
      expect(JSON.stringify(wellFormed(d.threw ? null : d.value))).toBe(JSON.stringify(wellFormed(c.threw ? null : c.value)));
      runs++;
      if (a.threw === false && a.value === '') empty++;
      else nonEmpty++;
    }
    expect(runs).toBe(ITERATIONS);
    expect(empty).toBeGreaterThan(0);
    expect(nonEmpty).toBeGreaterThan(0);
  });

  it('대조 장치: 설명 글 한 글자를 바꾼 "새 결과"도 차이로 잡는다', () => {
    const legacy = run(() => legacyCliPreflightFailure('요약', new Error('\u001b[31mx\u001b[0m')));
    expect(same(legacy, { threw: false, value: perturb(legacy.threw ? null : legacy.value) })).toBe(false);
    // 제어 코드를 안 지우는 변이도 잡힌다
    expect(legacyDescribeCliError(new Error('\u001b[31mx'))).not.toBe('\u001b[31mx');
  });
});
