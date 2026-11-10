import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 옮기기 전(ADR-191 3ac) `claude-cli-process.ts`의 CLI 실행 파일 고르기를 그대로 복사한 것. 차등 시험·벡터의 기준이다. 지우지 않는다.
 * 쓰는 곳은 `*-differential.test.ts`·`*-vectors.test.ts`뿐이다(`export`만 더했다).
 */

export function notFound(command: string, why: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT: ${why}`), { code: 'ENOENT' });
}

/** `inner`의 실제 경로가 `root`의 실제 경로와 같거나 그 안인가. 실제 경로를 못 읽으면 안으로 본다(막는 쪽) */
export function insideRoot(file: string, root: string): boolean {
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(file);
    realRoot = realpathSync(root);
  } catch {
    return true;
  }
  const rel = path.relative(realRoot, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * CLI 실행 파일을 절대 경로로 찾는다. 자식 프로세스는 cwd를 프로젝트 루트로 띄우므로, spawn에 이름만 넘기면 PATH의 빈 항목·`.`·상대 항목이
 * 프로젝트 폴더(에이전트가 파일을 쓰는 곳)로 풀려 심어 둔 실행 파일이 b-studio의 권한으로 돈다. 그래서:
 *  - 경로가 든 명령은 절대 경로만 받는다(상대 경로는 cwd 기준이라 거절).
 *  - 이름만 든 명령은 `env`의 PATH에서 절대 항목만 차례로 본다(빈 항목·상대 항목은 건너뛴다). 실행할 수 있는 파일만 고른다.
 *  - `forbiddenRoot`(프로젝트 루트)가 있으면 실제 경로(링크를 따라간 경로)가 그 안인 후보는 버린다.
 * 못 찾으면 ENOENT로 던진다(띄우지 않는다).
 */
export function resolveCliCommand(command: string, env: NodeJS.ProcessEnv, forbiddenRoot?: string): string {
  const hasSeparator = command.includes('/') || (process.platform === 'win32' && command.includes('\\'));
  if (hasSeparator) {
    if (!path.isAbsolute(command)) throw notFound(command, '실행 파일 경로는 절대 경로여야 합니다');
    if (forbiddenRoot !== undefined && insideRoot(command, forbiddenRoot)) throw notFound(command, '프로젝트 폴더 안의 실행 파일은 띄우지 않습니다');
    return command;
  }
  const dirs = (env[pathKeyOf(env)] ?? '').split(path.delimiter).filter((dir) => dir !== '' && path.isAbsolute(dir));
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (!isExecutableFile(candidate)) continue;
      if (forbiddenRoot !== undefined && insideRoot(candidate, forbiddenRoot)) continue;
      return candidate;
    }
  }
  throw notFound(command, 'PATH의 절대 경로 항목에서 찾지 못했습니다(빈 항목·상대 항목과 프로젝트 폴더 안은 보지 않습니다)');
}

export function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return process.platform === 'win32' ? (Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH') : 'PATH';
}

/**
 * 자식에게 넘길 환경. PATH에서 빈 항목·상대 항목과, `forbiddenRoot`가 있으면 실제 경로가 그 안인 항목(실제 경로를 못 읽은 항목 포함)을 뺀다.
 * 실행 파일을 절대 경로로 띄워도 `#!/usr/bin/env node` 같은 스크립트는 자식의 PATH에서 인터프리터를 다시 찾는다.
 * cwd가 프로젝트 루트라 `.`·빈 항목이 남으면 에이전트가 심은 `node`가 돈다(커밋 보안 검토 지적). 나머지 환경 변수는 그대로 둔다.
 */
export function childEnv(env: NodeJS.ProcessEnv, forbiddenRoot?: string): NodeJS.ProcessEnv {
  const key = pathKeyOf(env);
  const value = env[key];
  if (value === undefined) return { ...env };
  const kept = value
    .split(path.delimiter)
    .filter((dir) => dir !== '' && path.isAbsolute(dir))
    .filter((dir) => forbiddenRoot === undefined || !insideRoot(dir, forbiddenRoot));
  return { ...env, [key]: kept.join(path.delimiter) };
}
