import { readFileSync } from 'node:fs';
import { native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { canonicalProjectPath, foldName, normalizeProjectPath } from './path-names';
import * as legacy from './path-policy-legacy';
import { checkToolPolicy, DEFAULT_DENIED_COMMANDS, hasApprovalToken, isProtectedPath, isToolAllowed, isWithinScope } from './policy';

/**
 * path-names·policy의 벡터 시험(ADR-191 3q). 기대값은 옮기기 전 TS가 낸 값이다(JSON 글자, `undefined`는 `null`).
 * 막는 검사라 거의 같은 거부 입력을 함께 밟았다.
 *  - 이름 접기: `.git`·`.GIT`·`.git.`·`.git `·`.gi\u200Bt`·전각·`ſ`·켈빈 기호·결합 악센트·`ß`·`İ`·그리스 시그마 끝 글자·끝의 점과 공백
 *  - 표기 정리: `../`, `a/../b`, `a//b`, 역슬래시(lenient 켜고 끔), `C:/x`, `a:b.txt`, 빈 글자, `.`, NUL
 *  - 보호 경로(거부 목록, 넓게)와 쓰기 범위(허용 목록, 좁게)를 같은 쌍으로: `src` 대 `srcx/a`·`src/../x`·`SRC/a`·`src\a`, `.env`가 `.env.local`을 덮는 점 접두사 규칙
 *  - 도구 정책: 읽기 도구 함의(`read_lines`→`read_file`), 승인 토큰의 공백 종류, 금지 명령의 셸 감싸기(`sh -c`, `bash -lc`)와 `gradle --stop` 변형
 * Windows 판(`path.sep === '\\'`)은 Rust 함수를 직접 부른다(껍데기는 이 기계의 플랫폼 값을 넘긴다).
 * 옛 TS(`path-policy-legacy.ts`)에 돌리면 의도한 차이(맨 아래 describe)만 실패한다.
 */
type Vector = [fn: string, args: unknown[], expected: string];
// 벡터는 같은 폴더의 `path-policy-vectors.json`(옛 TS가 낸 값)이다. 리터럴로 두면 타입 검사가 감당하지 못한다
const VECTORS = JSON.parse(readFileSync(new URL('./path-policy-vectors.json', import.meta.url), 'utf8')) as Vector[];

const UNDEF = (value: unknown): unknown => (value !== null && typeof value === 'object' && '$undef' in (value as object) ? undefined : value);
const fromNullable = (value: string | null): string | undefined => value ?? undefined;

function run(fn: string, args: unknown[]): unknown {
  switch (fn) {
    case 'foldName':
      return foldName(args[0] as string);
    case 'normalize':
      return normalizeProjectPath(args[0] as string, { lenientSeparators: args[1] as boolean });
    case 'canonical':
      return canonicalProjectPath(args[0] as string, { lenientSeparators: args[1] as boolean });
    case 'normalizeWin':
      return fromNullable(native.normalizeProjectPath(args[0] as string, args[1] as boolean, true));
    case 'canonicalWin':
      return fromNullable(native.canonicalProjectPath(args[0] as string, args[1] as boolean, true));
    case 'isProtectedPath':
      return isProtectedPath(args[0] as string, args[1] as string);
    case 'isWithinScope':
      return isWithinScope(args[0] as string, args[1] as string);
    case 'isProtectedPathWin':
      return native.isProtectedPath(args[0] as string, args[1] as string, true);
    case 'isWithinScopeWin':
      return native.isWithinScope(args[0] as string, args[1] as string, true);
    case 'isToolAllowed':
      return isToolAllowed(args[0] as string, args[1] as string[]);
    case 'hasApprovalToken':
      return hasApprovalToken(UNDEF(args[0]) as string | undefined);
    case 'policy':
      return checkToolPolicy(args[0] as string, args[1], UNDEF(args[2]) as never, (args[3] as string | null) ?? undefined);
    case 'policyShape':
      return checkToolPolicy(args[0] as string, args[1], args[0] === 'write_file' ? { protectedPaths: ['x'], writablePaths: ['y'] } : undefined, undefined);
    case 'policyWin': {
      const input = args[1] as { path: string };
      const out = JSON.parse(native.checkToolPolicy(args[0] as string, input.path, [], JSON.stringify(args[2]), undefined, [...DEFAULT_DENIED_COMMANDS], true)) as { decision: string; reason?: string };
      return out.reason === undefined ? { tool: args[0], decision: out.decision } : { tool: args[0], decision: out.decision, reason: out.reason };
    }
    default:
      throw new Error(`알 수 없는 벡터 함수: ${fn}`);
  }
}

describe('path-names·policy 벡터(옛 TS가 낸 값)', () => {
  it(`${VECTORS.length}개 벡터가 모두 같다`, () => {
    const bad: string[] = [];
    for (const [fn, args, expected] of VECTORS) {
      const actual = JSON.stringify(run(fn, args) ?? null);
      if (actual !== expected) bad.push(`${fn} ${JSON.stringify(args)}\n  기대 ${expected}\n  실제 ${actual}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(VECTORS.length).toBeGreaterThan(4000);
  });

  it('벡터가 모든 판정 갈래를 밟는다: 허용, 경로 이탈, 범위 밖, 보호 경로, 금지 명령, gradle --stop, 도구 목록, 승인', () => {
    const reasons = new Set<string>();
    let allow = 0;
    for (const [fn, , expected] of VECTORS) {
      if (!fn.startsWith('policy')) continue;
      const r = JSON.parse(expected) as { decision: string; reason?: string };
      if (r.decision === 'allow') allow += 1;
      else reasons.add(r.reason!.startsWith("tool '") ? 'tool' : r.reason!.split(':')[0]!);
    }
    expect(allow).toBeGreaterThan(100);
    expect([...reasons].sort()).toEqual(['command is blocked by execution policy', 'gradle --stop is blocked', "path is outside this task's writable scope", 'path is protected by execution policy', 'path leaves the project', 'this tool requires an explicit approval before execution', 'tool'].sort());
  });

  it('옛 구현은 접미사·대소문자·덧붙임을 달리 본다 — 쓰기 범위는 이름을 접지 않고, 보호 경로는 접는다(같은 쌍)', () => {
    for (const file of ['SRC/a', 'src\u200B/a', 'srcx/a', 'src.bak/a', 'src\u00e9/a']) {
      expect(isWithinScope(file, 'src'), file).toBe(false);
    }
    for (const file of ['.GIT/config', '.gi\u200Bt/config', '\uFF0E\uFF47\uFF49\uFF54/x', '.git./x', '.git /x']) {
      expect(isProtectedPath(file, '.git'), file).toBe(true);
    }
    for (const file of ['.gitx', '.git2', '.gitignore']) expect(isProtectedPath(file, '.git'), file).toBe(false);
  });
});

describe('의도한 차이(옛 TS에 돌리면 실패한다, 모두 더 막는 쪽)', () => {
  it('보호 경로에 빈 규칙이 있으면 거절한다: 옛 구현은 `find`가 찾은 빈 글자를 거짓으로 보아 통과시켰다', () => {
    const policy = { protectedPaths: ['', 'infra'] };
    expect(legacy.checkToolPolicy('write_file', { path: 'web/x.ts' }, policy, undefined)).toEqual({ tool: 'write_file', decision: 'allow' });
    expect(checkToolPolicy('write_file', { path: 'web/x.ts' }, policy, undefined)).toEqual({ tool: 'write_file', decision: 'deny', reason: 'path is protected by execution policy: ' });
  });

  it('금지 명령에 빈 규칙이 있으면 거절한다: 옛 구현은 빈 규칙을 찾은 채 통과시켜 뒤의 규칙도 건너뛰었다', () => {
    const policy = { deniedCommands: ['', 'git status'] };
    const input = { command: ['sh', '-c', ' git status'] };
    expect(legacy.checkToolPolicy('run_in_service', input, policy, undefined).decision).toBe('allow');
    expect(checkToolPolicy('run_in_service', input, policy, undefined)).toEqual({ tool: 'run_in_service', decision: 'deny', reason: 'command is blocked by execution policy: ' });
  });

  it('도구 이름이 Object.prototype의 속성 이름이면 옛 구현은 던졌고 새 구현은 거절한다', () => {
    for (const tool of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(() => legacy.isToolAllowed(tool, ['read_file']), tool).toThrow();
      expect(isToolAllowed(tool, ['read_file']), tool).toBe(false);
      expect(checkToolPolicy(tool, {}, { allowedTools: ['read_file'] }, undefined), tool).toMatchObject({ decision: 'deny' });
      // 목록에 이름이 적혀 있으면 허용한다(옛 구현도 `includes`에서 돌아왔다)
      expect(isToolAllowed(tool, [tool]), tool).toBe(true);
    }
  });

  it('정책의 모양이 어긋나면 Rust가 던진다(부르는 쪽이 도구 실행을 막는다)', () => {
    expect(() => native.checkToolPolicy('write_file', 'a', [], '{"protectedPaths":"x"}', undefined, [], false)).toThrow();
    expect(() => native.checkToolPolicy('write_file', 'a', [], '[1]', undefined, [], false)).toThrow();
    expect(() => native.checkToolPolicy('write_file', 'a', [], 'not json', undefined, [], false)).toThrow();
  });
});
