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

const execFileAsync = promisify(execFile);

export const REPOSITORY_TOKEN_ENV: Record<'github' | 'gitea', string> = { github: 'B_STUDIO_GITHUB_TOKEN', gitea: 'B_STUDIO_GITEA_TOKEN' };

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
