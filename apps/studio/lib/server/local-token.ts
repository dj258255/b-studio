import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * 이 서버의 로컬 토큰(ADR-173 덧붙임). 개인 PC 모드에는 로그인이 없어서, 같은 컴퓨터의 다른 프로세스가 스튜디오 포트로
 * 보내는 요청을 가릴 수단이 없다. 그래서 서버가 시작할 때 추측할 수 없는 토큰을 하나 만들어 이 사용자만 읽을 수 있는
 * 파일에 두고, 그 토큰을 든 주소로 연 창(쿠키)에서만 터미널 통로를 쓴다(Jupyter와 같은 방식).
 *
 * 서버 프로세스가 살아 있는 동안 같은 값을 쓴다(개발 서버의 HMR에도 유지되게 globalThis에 둔다). 서버를 다시 띄우면 새 값이고 파일도 덮어쓴다.
 */

export const LOCAL_TOKEN_COOKIE = 'b_studio_local';
/** 토큰 교환 페이지 경로. 토큰은 주소의 `#` 뒤에 실려 온다(서버 로그와 방문 기록에 남지 않는다) */
export const LOCAL_TOKEN_PAGE_PATH = '/local-auth';
/** 교환을 받는 API 경로. 페이지가 토큰을 본문으로 옮겨 보낸다 */
export const LOCAL_TOKEN_API_PATH = '/api/local-auth';
const TOKEN_BYTES = 32;

const store = globalThis as typeof globalThis & { __bStudioLocalToken?: string };

/** 토큰 파일의 자리. 테스트는 B_STUDIO_LOCAL_TOKEN_FILE로 임시 폴더를 가리킨다 */
export function localTokenPath(env: Record<string, string | undefined> = process.env): string {
  const configured = env.B_STUDIO_LOCAL_TOKEN_FILE?.trim();
  if (configured) return configured;
  return path.join(env.HOME ?? homedir(), '.cache', 'b-studio', 'launch', 'local-token');
}

/** 이 서버의 로컬 토큰. 처음 부를 때 만들어 파일(0600)에 쓰고 같은 값을 돌려준다 */
export function localToken(env: Record<string, string | undefined> = process.env): string {
  store.__bStudioLocalToken ??= createLocalToken(env);
  return store.__bStudioLocalToken;
}

/** 쿠키 값이 이 서버의 토큰과 같은가(시간 일정 비교) */
export function hasLocalToken(cookie: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (!cookie) return false;
  return safeEqual(cookie, localToken(env));
}

function createLocalToken(env: Record<string, string | undefined>): string {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  writeTokenFile(localTokenPath(env), token);
  return token;
}

/**
 * 토큰을 파일에 쓴다. 폴더 0700, 파일 0600. 추측할 수 없는 임시 파일을 새로 만들 때만 성공하는 방식(wx)으로 쓰고 rename한다 —
 * 자리에 미리 심어 둔 링크를 따라 쓰지 않는다(rename은 자리의 링크 자체를 바꾼다). host-terminal.ts의 방식과 같다
 */
function writeTokenFile(file: string, token: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirInfo = lstatSync(dir, { throwIfNoEntry: false });
  if (dirInfo?.isDirectory() && !dirInfo.isSymbolicLink()) chmodSync(dir, 0o700);
  const staged = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(staged, `${token}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(staged, file);
  chmodSync(file, 0o600);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
