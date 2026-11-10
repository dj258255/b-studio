import nodePath from 'node:path';
import { foldName } from './path-policy-legacy';

/**
 * workspace.ts의 막는 검사를 Rust로 옮기면서(ADR-191 3단계 3w) 옮기기 전 TS 구현을 그대로 둔 기준 복사본이다. 차등·벡터 시험만 쓴다.
 * 바뀐 곳은 `isInside`가 경로 모듈(`path.posix`·`path.win32`)을 인자로 받는 것과, `resolveInputProblem`·`externalInputProblem`이
 * `#resolve`·`#normalizeExternal`의 앞 두 검사를 따로 떼어 낸 것뿐이다. 지우지 않는다 — 시험이 기준으로 삼는다.
 */
const DENIED_SEGMENTS = new Set(['.git', 'node_modules', '.next', 'build', '.gradle', '.venv', '__pycache__']);
const DENIED_FILES = [/^\.env(\..*)?$/];
const ENV_TEMPLATE_FILE = /^\.env(\.[\w-]+)*\.(example|sample|template|dist)$/;

export function isDeniedFileName(segment: string): boolean {
  return DENIED_FILES.some((pattern) => pattern.test(foldName(segment))) && !ENV_TEMPLATE_FILE.test(segment.normalize('NFC').toLowerCase());
}

export function isSecretFile(file: string): boolean {
  return file
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => isDeniedFileName(segment));
}

export function isDenied(segment: string): boolean {
  return DENIED_SEGMENTS.has(foldName(segment)) || isDeniedFileName(segment);
}

export function isInside(root: string, target: string, p: typeof nodePath.posix = nodePath.posix): boolean {
  const relative = p.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
}

/** `#resolve`의 앞 두 검사: 1 절대 경로, 2 쓸 수 없는 글자, 0 없음 */
export function resolveInputProblem(file: string, p: typeof nodePath.posix = nodePath.posix): number {
  if (p.isAbsolute(file)) return 1;
  if (file.includes('\0') || (p.sep !== '\\' && file.includes('\\'))) return 2;
  return 0;
}

/** `#normalizeExternal`의 절대 경로 검사 */
export function externalInputProblem(file: string, p: typeof nodePath.posix = nodePath.posix): number {
  return p.isAbsolute(file) ? 1 : 0;
}
