import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importSupportingServices } from './compose-import';
import { parseSpec, SpecError } from './load';
import { readYaml, YamlReadError } from './yaml-read';

// JS yaml은 이 시험에서 기대값을 만드는 기준으로만 쓴다(devDependency). 읽기 자체는 Rust가 한다(ADR-197)
const { parse } = createRequire(import.meta.url)('yaml') as { parse: (source: string, options?: { merge?: boolean }) => unknown };

const ROOT = path.resolve(import.meta.dirname, '../../..');

function readError(source: string, options?: { merge?: boolean }): YamlReadError {
  try {
    readYaml(source, options);
  } catch (error) {
    if (error instanceof YamlReadError) return error;
    throw error;
  }
  throw new Error('던지지 않았습니다');
}

describe('readYaml', () => {
  it('JS yaml과 같은 값을 만든다: core 스키마(YAML 1.1 불리언은 문자열), -0, NaN, Infinity, 큰 정수', () => {
    const source = 'a: [yes, no, on, off, True, 0x1F, 0o17, 1e3, .5, 1_000]\nb: -0\nc: .nan\nd: [.inf, -.inf]\ne: 12345678901234567890\nf: ~\n';
    const value = readYaml(source) as Record<string, unknown>;
    expect(value).toEqual(parse(source));
    expect(Object.is(value.b, -0)).toBe(true);
    expect(Number.isNaN(value.c)).toBe(true);
    expect(value.d).toEqual([Infinity, -Infinity]);
    expect(value.e).toBe(12345678901234567890);
    expect((value.a as unknown[]).slice(0, 5)).toEqual(['yes', 'no', 'on', 'off', true]);
  });

  it('객체 키 순서(정수 꼴이 앞)와 __proto__ 자기 속성도 같다', () => {
    const source = 'b: 1\n2: x\n1: y\n__proto__: z\n';
    const value = readYaml(source) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(Object.keys(parse(source) as object));
    expect(Object.keys(value)).toEqual(['1', '2', 'b', '__proto__']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it('merge는 merge 모드에서만 풀고, 기본 모드에서는 "<<" 키 그대로 둔다', () => {
    const source = 'a: &a {p: 1, q: 2}\nb:\n  q: 9\n  <<: *a\n';
    expect(readYaml(source)).toEqual(parse(source));
    expect(readYaml(source, { merge: true })).toEqual(parse(source, { merge: true }));
    expect(readYaml(source, { merge: true })).toEqual({ a: { p: 1, q: 2 }, b: { q: 9, p: 1 } });
    expect(Object.keys((readYaml(source) as { b: object }).b)).toEqual(['q', '<<']);
  });

  it('문법 오류와 JS yaml도 실패하는 입력은 syntax로 던진다(글자 없이 줄·칸만)', () => {
    for (const source of ['a: 1\na: 2\n', 'a: [1,\nb: {\n', 'a: 1\n---\nb: 2\n'.replace('---\n', '--- # x\n'), 'b: *x\n']) {
      expect(() => parse(source), source).toThrow();
      const error = readError(source);
      expect(error.kind === 'syntax' || error.kind === 'unsupported').toBe(true);
    }
    const error = readError('secret-token: [1,\nb: {\n');
    expect(error.kind).toBe('syntax');
    expect(error.line).toBeGreaterThan(0);
    expect(error.detail).not.toContain('secret-token');
  });

  it('JS와 다르게 읽을 수 있는 꼴은 지원하지 않는 꼴로 거절한다(되돌아가지 않는다)', () => {
    const cases: Array<[string, RegExp]> = [
      ['\ta: 1\n', /탭/],
      ['a: !!binary aGk=\n', /태그/],
      ['a: 1\rb: 2\r', /\\r/],
      ['\ufeffa: 1\n', /BOM/],
      ['%YAML 1.2\n---\na: 1\n', /지시문/],
      ['k:\n  x: [1,\n  {}]\n', /이어지는 줄/],
      ['? [a]\n: b\n', /컬렉션/],
    ];
    for (const [source, reason] of cases) {
      const error = readError(source);
      expect(error.kind, source).toBe('unsupported');
      expect(error.detail, source).toMatch(reason);
    }
  });

  it('흔한 실제 파일 꼴은 읽는다: 첫 줄 ---, CRLF, 따옴표·주석 안의 탭·!, 이어지는 따옴표, 지역 태그', () => {
    for (const source of ['---\na: 1\n', 'a: 1\r\nb: [x, y]\r\n', 'a: "x\ty!"\nb: 1 # 탭\t!|>\n', 'a: "긴 글\n    이어짐"\n', 'cmd: !reset [a]\n', 'a: [\n    1,\n    2\n  ]\n']) {
      expect(readYaml(source), source).toEqual(parse(source));
    }
  });
});

describe('spec의 읽기 자리', () => {
  it('parseSpec은 지원하지 않는 꼴을 사람이 읽을 수 있는 오류로 거절한다', () => {
    expect(() => parseSpec('name: [1,\t2]\n')).toThrow(/studio\.yaml: 이 YAML 꼴은 지원하지 않습니다: .*탭.*\(1번째 줄/);
    expect(() => parseSpec('name: [1,\nb: {\n')).toThrow(SpecError);
    expect(() => parseSpec('name: [1,\nb: {\n')).toThrow(/studio\.yaml의 YAML 문법이 올바르지 않습니다\(\d+번째 줄/);
  });

  it('compose 가져오기는 지원하지 않는 꼴을 빈 결과로 둔다(원래 문법 오류와 같은 처리)', () => {
    expect(importSupportingServices('\tservices:\n', 'compose.yaml')).toEqual({ services: [], skipped: [] });
  });
});

describe('저장소의 실제 YAML 파일', () => {
  const files = execFileSync('git', ['ls-files', '*.yaml', '*.yml'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && !file.endsWith('pnpm-lock.yaml'));

  it('studio.yaml·compose 파일은 하나도 거절하지 않고 JS yaml과 같은 값을 만든다(두 모드)', () => {
    const targets = files.filter((file) => /(^|\/)studio\.yaml$|compose[^/]*\.ya?ml$/.test(file));
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const file of targets) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      expect(readYaml(source), file).toEqual(parse(source));
      expect(readYaml(source, { merge: true }), file).toEqual(parse(source, { merge: true }));
      expect(JSON.stringify(readYaml(source, { merge: true })), file).toBe(JSON.stringify(parse(source, { merge: true })));
    }
  });

  it('나머지 YAML 파일은 JS가 읽으면 같은 값, JS가 던지면 값으로 읽지 않는다', () => {
    let read = 0;
    for (const file of files) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      let expected: { value: unknown } | undefined;
      try {
        expected = { value: parse(source) };
      } catch {
        expected = undefined;
      }
      if (!expected) {
        expect(() => readYaml(source), file).toThrow(YamlReadError);
      } else {
        expect(readYaml(source), file).toEqual(expected.value);
        read++;
      }
    }
    expect(read).toBeGreaterThan(10);
  });
});
