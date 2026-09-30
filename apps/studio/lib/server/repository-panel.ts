/**
 * 개발 화면의 "저장소" 탭이 쓰는 이슈·PR 목록.
 *
 * 프로젝트 폴더의 origin 원격 주소로 호스트를 찾아(`canPublishIssues`와 같은 방식), GitHub·Gitea REST API를 부른다.
 * 토큰은 `B_STUDIO_GITHUB_TOKEN`·`B_STUDIO_GITEA_TOKEN`을 먼저 보고, 개인 PC 모드(인증 없음)에서 GitHub 토큰이 없으면
 * `gh auth token`으로 로그인한 CLI 토큰을 대신 쓴다(여러 사람이 쓰는 서버에서는 쓰지 않는다. 로컬 폴더 세션과 같은 경계).
 * 토큰을 찾는 부분은 repo-token.ts에 따로 둬 PR 자동 리뷰(sessions.ts, ADR-074)와 함께 쓰면서도 순환 참조를 만들지 않는다.
 * 응답은 30초 캐시해 목록을 자주 열어도 API 사용량 한도에 잘 걸리지 않게 한다.
 */
import {
  CheckpointStore,
  listIssues,
  listPullRequests,
  parseRemote,
  PullRequestError,
  RepositoryRateLimitError,
  type GitHostKind,
  type IssueSummary,
  type PullRequestSummary,
  type RepositoryListState,
} from '@b-studio/agent';
import { findProject } from './projects';
import { ghCliToken, REPOSITORY_TOKEN_ENV as TOKEN_ENV, resolveRepositoryToken as resolveToken } from './repo-token';
import { localFolderAllowed, sessionIdFromBranch } from './sessions';

/** 목록을 다시 불러오기까지의 간격. API 사용량 한도(GitHub는 시간당 5,000회)에 여유를 둔다 */
export const REPOSITORY_LIST_TTL_MS = 30_000;

export type RepositoryQueryReason = 'no_remote' | 'unsupported_host' | 'no_token' | 'rate_limited' | 'error';

interface RemoteSummary {
  kind: GitHostKind;
  display: string;
  webUrl?: string;
}

export interface RepositoryIssuesResult {
  ok: boolean;
  remote?: RemoteSummary;
  reason?: RepositoryQueryReason;
  detail?: string;
  issues?: IssueSummary[];
}

export interface RepositoryPullsResult {
  ok: boolean;
  remote?: RemoteSummary;
  reason?: RepositoryQueryReason;
  detail?: string;
  pulls?: PullRequestSummary[];
}

/**
 * 이 호스트에 쓸 토큰을 찾는다. 환경 변수가 있으면 그것을 쓰고, 없으면(GitHub만) 개인 PC 모드에서 `gh` CLI 토큰을 대신 쓴다.
 * `ghToken`을 주입할 수 있어 테스트에서 하위 프로세스를 실행하지 않는다. 실제 검색은 repo-token.ts에 있다(PR 자동 리뷰와 공유).
 */
export async function resolveRepositoryToken(
  kind: 'github' | 'gitea',
  { env = process.env, allowGhCli = localFolderAllowed(), ghToken = ghCliToken }: { env?: Record<string, string | undefined>; allowGhCli?: boolean; ghToken?: () => Promise<string | undefined> } = {},
): Promise<string | undefined> {
  return resolveToken(kind, { env, allowGhCli, ghToken });
}

type RepositoryContext =
  | { ok: true; remote: ReturnType<typeof parseRemote>; kind: 'github' | 'gitea'; token: string }
  | { ok: false; reason: RepositoryQueryReason; detail: string; remote?: RemoteSummary };

async function repositoryContext(projectId: string, deps: { env?: Record<string, string | undefined>; ghToken?: () => Promise<string | undefined> } = {}): Promise<RepositoryContext> {
  const project = await findProject(projectId);
  if (!project) return { ok: false, reason: 'no_remote', detail: '프로젝트를 찾을 수 없습니다' };

  const source = await CheckpointStore.inspectSource(project.root, { allowSubfolder: project.spec.repository?.monorepo === true }).catch(() => undefined);
  if (!source?.originUrl) return { ok: false, reason: 'no_remote', detail: '이 프로젝트는 원격 저장소가 없어 이슈·PR을 볼 수 없습니다' };

  const remote = parseRemote(source.originUrl, deps.env ?? process.env);
  const summary: RemoteSummary = { kind: remote.kind, display: remote.display, webUrl: remote.webUrl };
  if (remote.kind !== 'github' && remote.kind !== 'gitea') {
    return { ok: false, reason: 'unsupported_host', detail: `${remote.display}는 GitHub·Gitea가 아니라 아직 지원하지 않습니다`, remote: summary };
  }

  const token = await resolveRepositoryToken(remote.kind, { env: deps.env, ghToken: deps.ghToken });
  if (!token) {
    return {
      ok: false,
      reason: 'no_token',
      detail:
        remote.kind === 'github'
          ? `${TOKEN_ENV.github}을 설정하거나, 이 PC에서 \`gh auth login\`으로 로그인하세요`
          : `${TOKEN_ENV.gitea}을 설정하세요`,
      remote: summary,
    };
  }
  return { ok: true, remote, kind: remote.kind, token };
}

function queryError(error: unknown): { reason: RepositoryQueryReason; detail: string } {
  if (error instanceof RepositoryRateLimitError) return { reason: 'rate_limited', detail: error.message };
  if (error instanceof PullRequestError) return { reason: 'error', detail: error.message };
  return { reason: 'error', detail: error instanceof Error ? error.message : String(error) };
}

/** 캐시 항목 하나. 성공·실패 모두 캐시해 같은 실패로 API를 반복해서 두드리지 않는다 */
interface CacheEntry<T> {
  at: number;
  value: T;
}

/** 프로젝트별·조건별 캐시. now·ttlMs를 바꿔 끼워 테스트한다 */
export function createRepositoryListCache<T>(options: { now?: () => number; ttlMs?: number } = {}) {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? REPOSITORY_LIST_TTL_MS;
  const entries = new Map<string, CacheEntry<T>>();
  return {
    async load(key: string, compute: () => Promise<T>): Promise<T> {
      const cached = entries.get(key);
      if (cached && now() - cached.at < ttlMs) return cached.value;
      const value = await compute();
      entries.set(key, { at: now(), value });
      return value;
    },
    clear(): void {
      entries.clear();
    },
  };
}

const issuesCache = createRepositoryListCache<RepositoryIssuesResult>();
const pullsCache = createRepositoryListCache<RepositoryPullsResult>();

/** 저장소 화면 이슈 탭. 프로젝트에 원격 저장소가 없거나 지원하지 않는 호스트, 토큰 없음, 사용량 한도는 실패 이유로 돌려주고 던지지 않는다 */
export async function projectRepositoryIssues(projectId: string, state: RepositoryListState = 'open'): Promise<RepositoryIssuesResult> {
  return issuesCache.load(`issues:${projectId}:${state}`, async () => {
    const context = await repositoryContext(projectId);
    if (!context.ok) return { ok: false, reason: context.reason, detail: context.detail, remote: context.remote };
    const summary: RemoteSummary = { kind: context.remote.kind, display: context.remote.display, webUrl: context.remote.webUrl };
    try {
      const issues = await listIssues(context.remote, { state, token: context.token });
      return { ok: true, remote: summary, issues };
    } catch (error) {
      const { reason, detail } = queryError(error);
      return { ok: false, reason, detail, remote: summary };
    }
  });
}

/** 저장소 화면 PR 탭. b-studio 세션이 만든 브랜치면 그 세션 id를 채운다(다른 프로젝트의 헤드 브랜치와 헷갈리지 않게 이 projectId 기준으로만 찾는다) */
export async function projectRepositoryPulls(projectId: string, state: RepositoryListState = 'open'): Promise<RepositoryPullsResult> {
  return pullsCache.load(`pulls:${projectId}:${state}`, async () => {
    const context = await repositoryContext(projectId);
    if (!context.ok) return { ok: false, reason: context.reason, detail: context.detail, remote: context.remote };
    const summary: RemoteSummary = { kind: context.remote.kind, display: context.remote.display, webUrl: context.remote.webUrl };
    try {
      const pulls = await listPullRequests(context.remote, {
        state,
        token: context.token,
        branchSessionId: (branch) => sessionIdFromBranch(projectId, branch),
      });
      return { ok: true, remote: summary, pulls };
    } catch (error) {
      const { reason, detail } = queryError(error);
      return { ok: false, reason, detail, remote: summary };
    }
  });
}
