/**
 * 저장소 호스트(GitHub·Gitea)에 쓸 토큰을 찾는다.
 *
 * 저장소 화면(repository-panel.ts)과 PR 자동 리뷰 라운드(sessions.ts, ADR-074)가 함께 쓴다.
 * 두 모듈이 서로를 참조해 순환 의존이 생기지 않도록 이 작은 모듈에 따로 둔다.
 *
 * 환경 변수(`B_STUDIO_GITHUB_TOKEN`·`B_STUDIO_GITEA_TOKEN`)가 있으면 그것을 쓰고,
 * 없으면(GitHub만) 개인 PC 모드에서 `gh auth token`으로 로그인한 CLI 토큰을 대신 쓴다
 * (여러 사람이 쓰는 서버에서는 쓰지 않는다. 로컬 폴더 세션과 같은 경계).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { authConfig } from './auth';

const execFileAsync = promisify(execFile);

export const REPOSITORY_TOKEN_ENV: Record<'github' | 'gitea', string> = { github: 'B_STUDIO_GITHUB_TOKEN', gitea: 'B_STUDIO_GITEA_TOKEN' };

/**
 * 로컬 폴더 세션은 에이전트가 서버의 프로젝트 폴더를 바로 바꾸므로, 인증을 끈 개인 PC에서만 허용한다.
 * gh CLI 토큰 대체(resolveRepositoryToken)도 같은 경계를 쓴다 — sessions.ts와 projects.ts가 서로를 가져오지
 * 않도록(순환 의존), 두 모듈 모두가 가져다 쓸 수 있는 이 작은 모듈에 둔다
 */
export function localFolderAllowed(): boolean {
  try {
    return authConfig().mode === 'none';
  } catch {
    return false;
  }
}

/** `gh auth token`을 부른다. 실행 파일이 없거나 로그인하지 않았으면 undefined(오류로 던지지 않는다) */
export async function ghCliToken(
  run: (cmd: string, args: string[]) => Promise<{ stdout: string }> = (cmd, args) => execFileAsync(cmd, args, { timeout: 5_000 }),
): Promise<string | undefined> {
  try {
    const { stdout } = await run('gh', ['auth', 'token']);
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 이 호스트에 쓸 토큰을 찾는다. 환경 변수가 있으면 그것을 쓰고, 없으면(GitHub만) 개인 PC 모드에서 `gh` CLI 토큰을 대신 쓴다.
 * `ghToken`을 주입할 수 있어 테스트에서 하위 프로세스를 실행하지 않는다.
 */
export async function resolveRepositoryToken(
  kind: 'github' | 'gitea',
  { env = process.env, allowGhCli, ghToken = ghCliToken }: { env?: Record<string, string | undefined>; allowGhCli: boolean; ghToken?: () => Promise<string | undefined> },
): Promise<string | undefined> {
  const fromEnv = env[REPOSITORY_TOKEN_ENV[kind]]?.trim();
  if (fromEnv) return fromEnv;
  if (kind !== 'github' || !allowGhCli) return undefined;
  try {
    return await ghToken();
  } catch {
    return undefined;
  }
}

/** resolveRepositoryToken을 부르는 요청 흐름 하나가 같은 호스트의 토큰을 몇 번이고 다시 묻지 않도록 아주 짧게 담아 둔다 */
const TOKEN_CACHE_TTL_MS = 5_000;
const tokenCache = new Map<'github' | 'gitea', { at: number; token: string | undefined }>();

/**
 * resolveRepositoryToken의 캐시된 버전. 저장소 올리기 미리보기 → 실제 생성처럼 한 요청 흐름에서 같은 호스트의
 * 토큰을 거듭 물으면, 환경 변수가 없는 개인 PC 모드마다 매번 `gh auth token` 하위 프로세스를 띄우게 된다
 * (ADR-105: PR 생성 경로가 이슈 발행 경로와 토큰을 다르게 구해 "PR 작성 페이지" 링크만 보이던 문제의 재발 방지).
 * `env`·`ghToken`·`now`를 주입할 수 있어 테스트에서 하위 프로세스를 실행하지 않고 캐시 만료도 흉내 낼 수 있다
 */
export async function cachedRepositoryToken(
  kind: 'github' | 'gitea',
  { allowGhCli, env, ghToken, now = Date.now }: { allowGhCli: boolean; env?: Record<string, string | undefined>; ghToken?: () => Promise<string | undefined>; now?: () => number },
): Promise<string | undefined> {
  const cached = tokenCache.get(kind);
  if (cached && now() - cached.at < TOKEN_CACHE_TTL_MS) return cached.token;
  const token = await resolveRepositoryToken(kind, { env, allowGhCli, ghToken });
  tokenCache.set(kind, { at: now(), token });
  return token;
}

/** 테스트에서만 쓴다. 캐시된 토큰이 다음 테스트로 새지 않게 한다 */
export function clearRepositoryTokenCache(): void {
  tokenCache.clear();
}
