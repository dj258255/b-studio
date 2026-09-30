import type { WorkflowStage } from '@b-studio/spec';
import type { SessionCommit } from './checkpoints';
import { VERIFICATION_STAGES } from './workflow';

export type GitHostKind = 'github' | 'gitlab' | 'gitea' | 'other' | 'local';

export interface RemoteLocation {
  kind: GitHostKind;
  /** 화면 표시용. 자격 증명을 뺐다 */
  display: string;
  /** 웹 주소의 호스트 (포트 포함) */
  host?: string;
  /** owner/repo 또는 group/sub/repo. .git은 뺐다 */
  path?: string;
  /** 브라우저로 여는 저장소 주소 */
  webUrl?: string;
}

export interface PullRequestInput {
  title: string;
  body: string;
  base: string;
  branch: string;
}

export interface PullRequestResult {
  url: string;
  number: number;
  /** false면 같은 브랜치로 이미 열려 있던 PR을 찾은 것이다 */
  created: boolean;
}

export interface IssueInput {
  title: string;
  body: string;
  labels?: string[];
}

export interface IssueResult {
  number: number;
  url: string;
}

/** 하위 이슈 연결 지원 여부. GitHub만 하위 이슈 API가 있고 Gitea·GitLab은 지원하지 않는다 */
export interface SubIssueResult {
  supported: boolean;
}

/** 원격 이슈 조회 결과. 미리보기의 "이슈가 열려 있는가" 확인에 쓴다 */
export interface IssueLookup {
  /** GitHub·Gitea는 open/closed를, GitLab은 opened를 open으로 바꿔 준다 */
  state: 'open' | 'closed';
  title: string;
  url: string;
}

export class PullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullRequestError';
  }
}

/** GitHub·Gitea의 API 사용량 한도에 걸렸다. 토큰 값은 담지 않는다 */
export class RepositoryRateLimitError extends PullRequestError {
  /** 한도가 풀리는 시각(ISO 8601). 응답 헤더에 없으면 없다 */
  readonly retryAt?: string;
  constructor(message: string, retryAt?: string) {
    super(message);
    this.name = 'RepositoryRateLimitError';
    this.retryAt = retryAt;
  }
}

export type RepositoryListState = 'all' | 'open' | 'closed';

/** 저장소 화면(이슈 탭)의 이슈 한 줄 */
export interface IssueSummary {
  number: number;
  title: string;
  author: string;
  labels: string[];
  /** ISO 8601 */
  updatedAt: string;
  url: string;
  state: 'open' | 'closed';
  /** 본문(마크다운). GitHub·Gitea 모두 목록 API가 통째로 돌려줘 따로 조회하지 않는다. 없으면(빈 이슈) 없다 */
  body?: string;
}

/** GitHub Checks API로 얻는 커밋의 결합 CI 상태. 값을 못 얻으면(권한·API 미지원) 'unknown' */
export type CheckStatus = 'success' | 'failure' | 'pending' | 'unknown';
/** 리뷰 판정. GraphQL 전용 필드라 REST 리뷰 목록에서 직접 계산한다 */
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'unknown';

/** 저장소 화면(PR 탭)의 PR 한 줄 */
export interface PullRequestSummary {
  number: number;
  title: string;
  author: string;
  labels: string[];
  /** ISO 8601 */
  updatedAt: string;
  url: string;
  state: 'open' | 'closed';
  draft: boolean;
  headBranch: string;
  headSha: string;
  /** GitHub만 채운다(Gitea·GitLab은 값을 싸게 얻을 방법이 없어 비워 둔다) */
  checkStatus?: CheckStatus;
  reviewDecision?: ReviewDecision;
  /** 헤드 브랜치가 b-studio 세션이 만든 브랜치면 그 세션 id */
  sessionId?: string;
}

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

const PROVIDERS = ['github', 'gitlab', 'gitea'] as const;
const TOKEN_ENV: Record<(typeof PROVIDERS)[number], string> = {
  github: 'B_STUDIO_GITHUB_TOKEN',
  gitlab: 'B_STUDIO_GITLAB_TOKEN',
  gitea: 'B_STUDIO_GITEA_TOKEN',
};
const API_TIMEOUT_MS = 30_000;
/** GitHub PR 본문 한도(65,536자)보다 여유 있게 자른다 */
const MAX_PULL_REQUEST_BODY = 60_000;
/** 저장소 화면 한 쪽에 보여 줄 최대 개수. 화면은 열림만 기본으로 보여 더 넘길 일이 드물다 */
const LIST_PAGE_SIZE = 50;
/** CI 상태·리뷰 판정은 PR마다 API 호출이 더 들어, 목록 앞쪽 이만큼만 채운다 */
const MAX_PR_DETAILS = 25;

/**
 * git 원격 주소를 해석한다. https, ssh://, scp 형식(git@host:owner/repo), 로컬 경로를 지원한다.
 * 사내 호스트는 이름만으로 종류를 알 수 없으므로 B_STUDIO_GIT_PROVIDER로 정한다.
 */
export function parseRemote(url: string, env: Env = process.env): RemoteLocation {
  const trimmed = url.trim();
  let host: string;
  let repoPath: string;
  let scheme = 'https';

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'file:') return { kind: 'local', display: decodeURIComponent(parsed.pathname) };
    // ssh 포트는 웹 주소의 포트가 아니다
    host = parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : parsed.hostname;
    repoPath = decodeURIComponent(parsed.pathname);
    if (parsed.protocol === 'http:') scheme = 'http';
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
    // "C:\repo" 같은 윈도우 경로는 한 글자 호스트처럼 보인다
    if (!scp || scp[1]!.length === 1) return { kind: 'local', display: trimmed };
    host = scp[1]!;
    repoPath = scp[2]!;
  }

  const cleanPath = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  const hostname = host.replace(/:\d+$/, '');
  const override = PROVIDERS.find((provider) => provider === env.B_STUDIO_GIT_PROVIDER);
  const kind: GitHostKind = override ?? (hostname === 'github.com' ? 'github' : hostname === 'gitlab.com' ? 'gitlab' : 'other');
  return { kind, display: `${host}/${cleanPath}`, host, path: cleanPath, webUrl: `${scheme}://${host}/${cleanPath}` };
}

/** 토큰이 없어도 사람이 직접 PR을 만들 수 있게 작성 페이지 주소를 만든다 */
export function compareUrl(remote: RemoteLocation, base: string, branch: string): string | undefined {
  if (!remote.webUrl) return undefined;
  switch (remote.kind) {
    case 'github':
      return `${remote.webUrl}/compare/${encodeRef(base)}...${encodeRef(branch)}?expand=1`;
    case 'gitea':
      return `${remote.webUrl}/compare/${encodeRef(base)}...${encodeRef(branch)}`;
    case 'gitlab':
      return `${remote.webUrl}/-/merge_requests/new?${new URLSearchParams({
        'merge_request[source_branch]': branch,
        'merge_request[target_branch]': base,
      })}`;
    default:
      return undefined;
  }
}

export function canCreatePullRequest(remote: RemoteLocation, env: Env = process.env): boolean {
  return remote.kind !== 'other' && remote.kind !== 'local' && Boolean(env[TOKEN_ENV[remote.kind]]);
}

/** 이미 같은 브랜치로 열린 PR이 있으면 새로 만들지 않고 그 주소를 돌려준다 */
export async function createPullRequest(
  remote: RemoteLocation,
  input: PullRequestInput,
  { env = process.env, fetch: fetchFn = fetch }: { env?: Env; fetch?: Fetch } = {},
): Promise<PullRequestResult> {
  if (remote.kind === 'other' || remote.kind === 'local' || !remote.host || !remote.path) {
    throw new PullRequestError('PR을 만들 수 있는 저장소 호스트가 아닙니다. 사내 호스트라면 B_STUDIO_GIT_PROVIDER를 설정하세요');
  }
  const token = env[TOKEN_ENV[remote.kind]];
  if (!token) throw new PullRequestError(`${TOKEN_ENV[remote.kind]} 토큰이 없어 PR을 만들 수 없습니다`);

  const body = capBody(input.body);
  return remote.kind === 'gitlab'
    ? createMergeRequest(remote, { ...input, body }, token, env, fetchFn)
    : createGitHubStylePullRequest(remote, { ...input, body }, token, env, fetchFn);
}

/** GitHub와 Gitea는 PR API 모양이 같다. 이미 있으면 GitHub는 422, Gitea는 409를 돌려준다 */
async function createGitHubStylePullRequest(
  remote: RemoteLocation,
  input: PullRequestInput,
  token: string,
  env: Env,
  fetchFn: Fetch,
): Promise<PullRequestResult> {
  const [owner, repo, ...rest] = remote.path!.split('/');
  if (!owner || !repo || rest.length > 0) throw new PullRequestError(`저장소 경로가 owner/repo 형식이 아닙니다: ${remote.path}`);

  const github = remote.kind === 'github';
  const origin = originOf(remote);
  const api = github
    ? (env.B_STUDIO_GITHUB_API_URL ?? (remote.host === 'github.com' ? 'https://api.github.com' : `${origin}/api/v3`))
    : (env.B_STUDIO_GITEA_API_URL ?? `${origin}/api/v1`);
  const headers = {
    accept: github ? 'application/vnd.github+json' : 'application/json',
    authorization: github ? `Bearer ${token}` : `token ${token}`,
    'content-type': 'application/json',
    ...(github ? { 'x-github-api-version': '2022-11-28' } : {}),
  };
  const pulls = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  const label = github ? 'GitHub' : 'Gitea';

  const response = await fetchFn(pulls, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: input.title, body: input.body, head: input.branch, base: input.base }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (response.status === 201) {
    const data = (await response.json()) as { html_url: string; number: number };
    return { url: data.html_url, number: data.number, created: true };
  }
  if (response.status === 422 || response.status === 409) {
    const list = await fetchFn(`${pulls}?state=open&${github ? 'per_page' : 'limit'}=50`, {
      headers,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (list.ok) {
      const open = (await list.json()) as Array<{ html_url: string; number: number; head?: { ref?: string }; base?: { ref?: string } }>;
      const existing = open.find((pull) => pull.head?.ref === input.branch && pull.base?.ref === input.base);
      if (existing) return { url: existing.html_url, number: existing.number, created: false };
    }
  }
  throw new PullRequestError(`${label} API가 PR 생성을 거절했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
}

async function createMergeRequest(
  remote: RemoteLocation,
  input: PullRequestInput,
  token: string,
  env: Env,
  fetchFn: Fetch,
): Promise<PullRequestResult> {
  const api = env.B_STUDIO_GITLAB_API_URL ?? `${originOf(remote)}/api/v4`;
  const headers = { 'private-token': token, 'content-type': 'application/json' };
  const mergeRequests = `${api}/projects/${encodeURIComponent(remote.path!)}/merge_requests`;

  const response = await fetchFn(mergeRequests, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source_branch: input.branch, target_branch: input.base, title: input.title, description: input.body }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (response.status === 201) {
    const data = (await response.json()) as { web_url: string; iid: number };
    return { url: data.web_url, number: data.iid, created: true };
  }
  if (response.status === 409) {
    const query = new URLSearchParams({ state: 'opened', source_branch: input.branch, target_branch: input.base });
    const list = await fetchFn(`${mergeRequests}?${query}`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (list.ok) {
      const [existing] = (await list.json()) as Array<{ web_url: string; iid: number }>;
      if (existing) return { url: existing.web_url, number: existing.iid, created: false };
    }
  }
  throw new PullRequestError(`GitLab API가 MR 생성을 거절했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
}

/**
 * 원격 이슈를 조회한다. 미리보기에서 이슈가 존재하고 열려 있는지 확인할 때 쓴다.
 * GitHub·Gitea는 `GET /repos/{owner}/{repo}/issues/{n}`, GitLab은 `GET /projects/{id}/issues/{iid}`를 쓴다.
 * GitLab은 MR 설명의 `Closes #N`으로 이슈를 닫으므로 같은 문구를 쓴다
 * (https://docs.gitlab.com/user/project/issues/managing_issues/#closing-issues-automatically).
 */
export async function fetchIssue(
  remote: RemoteLocation,
  issue: number,
  { env = process.env, fetch: fetchFn = fetch }: { env?: Env; fetch?: Fetch } = {},
): Promise<IssueLookup> {
  if (remote.kind === 'other' || remote.kind === 'local' || !remote.host || !remote.path) {
    throw new PullRequestError('이슈를 조회할 수 있는 저장소 호스트가 아닙니다. 사내 호스트라면 B_STUDIO_GIT_PROVIDER를 설정하세요');
  }
  const token = env[TOKEN_ENV[remote.kind]];
  if (!token) throw new PullRequestError(`${TOKEN_ENV[remote.kind]} 토큰이 없어 이슈를 확인할 수 없습니다`);

  if (remote.kind === 'gitlab') {
    const api = env.B_STUDIO_GITLAB_API_URL ?? `${originOf(remote)}/api/v4`;
    const response = await fetchFn(`${api}/projects/${encodeURIComponent(remote.path)}/issues/${issue}`, {
      headers: { 'private-token': token },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new PullRequestError(`GitLab 이슈 조회가 실패했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
    const data = (await response.json()) as { state: string; title: string; web_url: string };
    return { state: data.state === 'opened' ? 'open' : 'closed', title: data.title, url: data.web_url };
  }

  const [owner, repo, ...rest] = remote.path.split('/');
  if (!owner || !repo || rest.length > 0) throw new PullRequestError(`저장소 경로가 owner/repo 형식이 아닙니다: ${remote.path}`);
  const github = remote.kind === 'github';
  const origin = originOf(remote);
  const api = github
    ? (env.B_STUDIO_GITHUB_API_URL ?? (remote.host === 'github.com' ? 'https://api.github.com' : `${origin}/api/v3`))
    : (env.B_STUDIO_GITEA_API_URL ?? `${origin}/api/v1`);
  const label = github ? 'GitHub' : 'Gitea';
  const response = await fetchFn(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue}`, {
    headers: {
      accept: github ? 'application/vnd.github+json' : 'application/json',
      authorization: github ? `Bearer ${token}` : `token ${token}`,
      ...(github ? { 'x-github-api-version': '2022-11-28' } : {}),
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new PullRequestError(`${label} 이슈 조회가 실패했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
  const data = (await response.json()) as { state: string; title: string; html_url: string };
  return { state: data.state === 'open' ? 'open' : 'closed', title: data.title, url: data.html_url };
}

/** PR/MR 주소에서 번호를 뽑는다(github.com/o/r/pull/N, gitea .../pulls/N, gitlab .../-/merge_requests/N). 못 찾으면 undefined */
export function parsePullRequestNumber(url: string): number | undefined {
  const match = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : undefined;
}

/**
 * PR(MR)에 댓글 하나를 단다. GitHub·Gitea는 이슈 댓글 API(PR도 이슈 번호를 공유한다)를,
 * GitLab은 머지 리퀘스트 노트 API를 쓴다. PR 자동 리뷰(ADR-074)가 라운드마다 한 번씩 부른다.
 */
export async function postComment(
  remote: RemoteLocation,
  number: number,
  body: string,
  { env = process.env, fetch: fetchFn = fetch, token }: { env?: Env; fetch?: Fetch; token?: string } = {},
): Promise<{ url?: string }> {
  if (remote.kind === 'other' || remote.kind === 'local' || !remote.host || !remote.path) {
    throw new PullRequestError('댓글을 남길 수 있는 저장소 호스트가 아닙니다. 사내 호스트라면 B_STUDIO_GIT_PROVIDER를 설정하세요');
  }
  // 토큰을 직접 주면(개인 PC 모드의 gh CLI 폴백 등) 그것을 쓰고, 아니면 환경 변수를 본다
  const auth = token ?? env[TOKEN_ENV[remote.kind]];
  if (!auth) throw new PullRequestError(`${TOKEN_ENV[remote.kind]} 토큰이 없어 댓글을 남길 수 없습니다`);

  if (remote.kind === 'gitlab') {
    const api = env.B_STUDIO_GITLAB_API_URL ?? `${originOf(remote)}/api/v4`;
    const response = await fetchFn(`${api}/projects/${encodeURIComponent(remote.path)}/merge_requests/${number}/notes`, {
      method: 'POST',
      headers: { 'private-token': auth, 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (response.status !== 201) throw new PullRequestError(`GitLab API가 댓글 작성을 거절했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
    const data = (await response.json()) as { id: number };
    return { url: `${remote.webUrl}/-/merge_requests/${number}#note_${data.id}` };
  }

  const { api, headers, label, owner, repo } = gitHubStyleApi(remote, auth, env);
  const response = await fetchFn(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (response.status !== 201) throw new PullRequestError(`${label} API가 댓글 작성을 거절했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
  const data = (await response.json()) as { html_url: string };
  return { url: data.html_url };
}

interface RawLabel {
  name?: string;
}
interface RawIssue {
  number: number;
  title: string;
  user?: { login?: string };
  labels?: Array<RawLabel | string>;
  updated_at: string;
  html_url: string;
  state: string;
  body?: string | null;
  /** GitHub·Gitea 모두 이슈 목록에 PR도 섞어 주고, 이 필드가 있으면 PR이다 */
  pull_request?: unknown;
}
interface RawPull {
  number: number;
  title: string;
  user?: { login?: string };
  labels?: Array<RawLabel | string>;
  updated_at: string;
  html_url: string;
  state: string;
  draft?: boolean;
  head: { ref: string; sha: string };
}

function labelNames(labels: Array<RawLabel | string> | undefined): string[] {
  return (labels ?? []).map((label) => (typeof label === 'string' ? label : (label.name ?? ''))).filter(Boolean);
}

/**
 * 원격 저장소 화면의 이슈 탭 목록. GitHub·Gitea는 `GET /repos/{owner}/{repo}/issues`를 쓴다(PR도 섞여 오므로 뺀다).
 * GitLab은 아직 지원하지 않는다(호스트별 화면 모양이 달라 REST 응답을 그대로 맞추기보다 필요해지면 추가한다).
 */
export async function listIssues(
  remote: RemoteLocation,
  { state = 'open', env = process.env, fetch: fetchFn = fetch, token }: { state?: RepositoryListState; env?: Env; fetch?: Fetch; token?: string } = {},
): Promise<IssueSummary[]> {
  if (remote.kind !== 'github' && remote.kind !== 'gitea') throw new PullRequestError('이슈 목록을 볼 수 있는 저장소 호스트가 아닙니다(GitHub·Gitea만 지원합니다)');
  if (!remote.host || !remote.path) throw new PullRequestError('저장소 주소를 해석하지 못했습니다');
  const auth = token ?? env[TOKEN_ENV[remote.kind]];
  if (!auth) throw new PullRequestError(`${TOKEN_ENV[remote.kind]} 토큰이 없어 이슈 목록을 볼 수 없습니다`);

  const { api, headers, label, owner, repo } = gitHubStyleApi(remote, auth, env);
  const response = await fetchFn(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=${LIST_PAGE_SIZE}`, {
    headers,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  await assertListOk(response, label, '이슈 목록');
  const data = (await response.json()) as RawIssue[];
  return data
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: item.title,
      author: item.user?.login ?? '알 수 없음',
      labels: labelNames(item.labels),
      updatedAt: item.updated_at,
      url: item.html_url,
      state: item.state === 'open' ? 'open' : 'closed',
      body: item.body ?? undefined,
    }));
}

/**
 * 원격 저장소 화면의 PR 탭 목록. GitHub·Gitea는 `GET /repos/{owner}/{repo}/pulls`를 쓴다.
 * GitHub는 목록 앞쪽 `MAX_PR_DETAILS`개만 CI 결합 상태(Checks API)와 리뷰 판정(리뷰 목록에서 계산)을 더 받아 채운다.
 * `branchSessionId`를 주면 헤드 브랜치에서 b-studio 세션 id를 뽑아 `sessionId`에 채운다(브랜치 이름 규칙은 studio 쪽이 안다).
 */
export async function listPullRequests(
  remote: RemoteLocation,
  {
    state = 'open',
    env = process.env,
    fetch: fetchFn = fetch,
    token,
    branchSessionId,
  }: { state?: RepositoryListState; env?: Env; fetch?: Fetch; token?: string; branchSessionId?: (branch: string) => string | undefined } = {},
): Promise<PullRequestSummary[]> {
  if (remote.kind !== 'github' && remote.kind !== 'gitea') throw new PullRequestError('PR 목록을 볼 수 있는 저장소 호스트가 아닙니다(GitHub·Gitea만 지원합니다)');
  if (!remote.host || !remote.path) throw new PullRequestError('저장소 주소를 해석하지 못했습니다');
  const auth = token ?? env[TOKEN_ENV[remote.kind]];
  if (!auth) throw new PullRequestError(`${TOKEN_ENV[remote.kind]} 토큰이 없어 PR 목록을 볼 수 없습니다`);

  const { api, headers, label, owner, repo } = gitHubStyleApi(remote, auth, env);
  const response = await fetchFn(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=${LIST_PAGE_SIZE}`, {
    headers,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  await assertListOk(response, label, 'PR 목록');
  const data = (await response.json()) as RawPull[];
  const summaries: PullRequestSummary[] = data.map((item) => ({
    number: item.number,
    title: item.title,
    author: item.user?.login ?? '알 수 없음',
    labels: labelNames(item.labels),
    updatedAt: item.updated_at,
    url: item.html_url,
    state: item.state === 'open' ? 'open' : 'closed',
    draft: item.draft === true,
    headBranch: item.head.ref,
    headSha: item.head.sha,
    sessionId: branchSessionId?.(item.head.ref),
  }));

  if (remote.kind === 'github') {
    await Promise.all(summaries.slice(0, MAX_PR_DETAILS).map((summary) => attachChecksAndReviews(summary, { api, headers, owner, repo }, fetchFn)));
  }
  return summaries;
}

/** 응답 헤더로 사용량 한도를 구분해 던진다. 그 밖의 실패는 기존 오류 문구 형식을 따른다 */
async function assertListOk(response: Response, label: string, what: string): Promise<void> {
  if (response.ok) return;
  if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
    const resetHeader = response.headers.get('x-ratelimit-reset');
    const retryAt = resetHeader ? new Date(Number(resetHeader) * 1000).toISOString() : undefined;
    throw new RepositoryRateLimitError(`${label} API 사용량 한도에 걸렸습니다${retryAt ? ` (${retryAt}에 풀립니다)` : ''}`, retryAt);
  }
  throw new PullRequestError(`${label} API가 ${what} 조회를 거절했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
}

/**
 * PR 하나에 CI 결합 상태와 리뷰 판정을 더한다. 실패해도(권한·API 미지원) 목록 자체는 보여 줘야 하므로 'unknown'으로 두고 던지지 않는다.
 * Checks API(`commits/{sha}/check-runs`)는 GitHub Actions 등 체크 앱 기준이라, 그 밖의 상태 API(Statuses)만 쓰는 CI는 잡지 못할 수 있다.
 */
async function attachChecksAndReviews(
  summary: PullRequestSummary,
  ctx: { api: string; headers: Record<string, string>; owner: string; repo: string },
  fetchFn: Fetch,
): Promise<void> {
  const base = `${ctx.api}/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}`;
  const [checks, reviews] = await Promise.all([
    fetchFn(`${base}/commits/${summary.headSha}/check-runs?per_page=100`, { headers: ctx.headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) }).then(
      (response) => (response.ok ? (response.json() as Promise<{ check_runs: Array<{ status: string; conclusion: string | null }> }>) : undefined),
      () => undefined,
    ),
    fetchFn(`${base}/pulls/${summary.number}/reviews?per_page=100`, { headers: ctx.headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) }).then(
      (response) => (response.ok ? (response.json() as Promise<Array<{ user?: { login?: string }; state: string; submitted_at: string }>>) : undefined),
      () => undefined,
    ),
  ]);
  summary.checkStatus = checks ? combineCheckStatus(checks.check_runs) : 'unknown';
  summary.reviewDecision = reviews ? combineReviewDecision(reviews) : 'unknown';
}

/** 체크가 하나라도 안 끝났으면 pending, 끝났는데 실패·취소·조치 필요가 있으면 failure, 아니면 success */
function combineCheckStatus(runs: Array<{ status: string; conclusion: string | null }>): CheckStatus {
  if (runs.length === 0) return 'unknown';
  if (runs.some((run) => run.status !== 'completed')) return 'pending';
  const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);
  if (runs.some((run) => run.conclusion && FAILING.has(run.conclusion))) return 'failure';
  return 'success';
}

/** 리뷰어별 마지막 판정만 센다(코멘트만 남긴 리뷰는 판정에 안 넣는다) */
function combineReviewDecision(reviews: Array<{ user?: { login?: string }; state: string; submitted_at: string }>): ReviewDecision {
  const latest = new Map<string, string>();
  for (const review of [...reviews].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))) {
    const reviewer = review.user?.login;
    if (!reviewer || review.state === 'COMMENTED') continue;
    latest.set(reviewer, review.state);
  }
  const states = [...latest.values()];
  if (states.length === 0) return 'unknown';
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.every((entry) => entry === 'APPROVED')) return 'approved';
  return 'review_required';
}

/**
 * 원격 저장소에 이슈를 만든다. GitHub·Gitea는 `POST /repos/{owner}/{repo}/issues`, GitLab은 `POST /projects/{id}/issues`를 쓴다.
 * 토큰·API 주소 규칙은 createPullRequest와 같다.
 */
export async function createIssue(
  remote: RemoteLocation,
  input: IssueInput,
  { env = process.env, fetch: fetchFn = fetch }: { env?: Env; fetch?: Fetch } = {},
): Promise<IssueResult> {
  if (remote.kind === 'other' || remote.kind === 'local' || !remote.host || !remote.path) {
    throw new PullRequestError('이슈를 만들 수 있는 저장소 호스트가 아닙니다. 사내 호스트라면 B_STUDIO_GIT_PROVIDER를 설정하세요');
  }
  const token = env[TOKEN_ENV[remote.kind]];
  if (!token) throw new PullRequestError(`${TOKEN_ENV[remote.kind]} 토큰이 없어 이슈를 만들 수 없습니다`);

  if (remote.kind === 'gitlab') {
    const api = env.B_STUDIO_GITLAB_API_URL ?? `${originOf(remote)}/api/v4`;
    const response = await fetchFn(`${api}/projects/${encodeURIComponent(remote.path)}/issues`, {
      method: 'POST',
      headers: { 'private-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ title: input.title, description: input.body, ...(input.labels?.length ? { labels: input.labels } : {}) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (response.status !== 201) throw new PullRequestError(`GitLab API가 이슈 생성을 거절했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
    const data = (await response.json()) as { iid: number; web_url: string };
    return { number: data.iid, url: data.web_url };
  }

  const { api, headers, label, owner, repo } = gitHubStyleApi(remote, token, env);
  const response = await fetchFn(`${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: input.title, body: input.body, ...(input.labels?.length ? { labels: input.labels } : {}) }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (response.status !== 201) throw new PullRequestError(`${label} API가 이슈 생성을 거절했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
  const data = (await response.json()) as { number: number; html_url: string };
  return { number: data.number, url: data.html_url };
}

/**
 * GitHub에서 child 이슈를 parent의 하위 이슈로 연결한다.
 * `sub_issue_id`는 이슈 번호가 아니라 이슈 id라서, 먼저 child 이슈를 조회해 id를 얻는다.
 * Gitea·GitLab은 하위 이슈 API가 없어 `{ supported: false }`를 돌려준다(추적 이슈 본문의 체크리스트로 대신한다).
 */
export async function addSubIssue(
  remote: RemoteLocation,
  parent: number,
  child: number,
  { env = process.env, fetch: fetchFn = fetch }: { env?: Env; fetch?: Fetch } = {},
): Promise<SubIssueResult> {
  if (remote.kind !== 'github') return { supported: false };
  if (!remote.host || !remote.path) throw new PullRequestError('하위 이슈를 연결할 수 있는 저장소 호스트가 아닙니다');
  const token = env[TOKEN_ENV.github];
  if (!token) throw new PullRequestError(`${TOKEN_ENV.github} 토큰이 없어 하위 이슈를 연결할 수 없습니다`);
  const { api, headers } = gitHubStyleApi(remote, token, env);
  const issues = `${api}/repos/${encodeURIComponent(remote.path.split('/')[0]!)}/${encodeURIComponent(remote.path.split('/')[1]!)}/issues`;

  const childResponse = await fetchFn(`${issues}/${child}`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!childResponse.ok) throw new PullRequestError(`GitHub 이슈 조회가 실패했습니다 (HTTP ${childResponse.status}): ${await errorMessage(childResponse)}`);
  const { id } = (await childResponse.json()) as { id: number };

  const response = await fetchFn(`${issues}/${parent}/sub_issues`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sub_issue_id: id }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (response.status !== 201) throw new PullRequestError(`GitHub 하위 이슈 연결이 실패했습니다 (HTTP ${response.status}): ${await errorMessage(response)}`);
  return { supported: true };
}

/** buildPullRequest가 돌려주는 PR 초안과, 필수 단계 기록이 없는 커밋 */
export interface PullRequestDraft {
  title: string;
  body: string;
  /** requiredStages 중 통과 기록이 없는 단계가 있는 커밋만. 오래된 것부터 */
  missing: Array<{ shortSha: string; subject: string; stages: WorkflowStage[] }>;
}

/**
 * 세션 커밋만으로 PR 제목과 본문을 만든다. 체크포인트 커밋 본문에 검증 결과가 들어 있어
 * 스튜디오 서버의 메모리 상태 없이도 같은 PR을 다시 만들 수 있다.
 */
export function buildPullRequest({
  projectName,
  base,
  branch,
  commits,
  issue,
  issues,
  requiredStages = [],
}: {
  projectName: string;
  base: string;
  branch: string;
  commits: SessionCommit[];
  /** 연결할 이슈 번호 하나. issues와 함께 주면 둘을 합친다 */
  issue?: number;
  /** 연결할 이슈 번호들. 있으면 본문 첫 줄들에 `Closes #N`을 하나씩 넣는다 */
  issues?: readonly number[];
  /** 이 프로젝트의 필수 워크플로 단계. 통과 기록이 없는 검증 단계를 "돌리지 않은 검증"에 모은다 */
  requiredStages?: readonly WorkflowStage[];
}): PullRequestDraft {
  const requests = commits.map(requestName);
  const first = requests[0] ?? `${projectName} 세션 변경`;
  const title = `[b-studio] ${first}${requests.length > 1 ? ` 외 ${requests.length - 1}건` : ''}`.slice(0, 120);

  // 통과 기록은 검증 단계만 남으므로, plan·implement·checkpoint는 없는 것이 정상이다
  const stages = requiredStages.filter((stage) => VERIFICATION_STAGES.includes(stage));
  const missing = commits
    .map((commit, index) => {
      const passed = new Set(commit.passedStages ?? []);
      return { shortSha: commit.shortSha, subject: requests[index]!, stages: stages.filter((stage) => !passed.has(stage)) };
    })
    .filter((entry) => entry.stages.length > 0);

  const sections = commits.map((commit, index) => {
    const shown = commit.files.slice(0, 10).map((file) => `\`${file}\``);
    const more = commit.files.length > shown.length ? ` 외 ${commit.files.length - shown.length}개` : '';
    const lines = [`### ${index + 1}. ${requests[index]}`, '', `커밋 \`${commit.shortSha}\`, 파일 ${commit.files.length}개: ${shown.join(', ')}${more}`];
    if (commit.body) {
      lines.push('', '<details>', '<summary>검증 게이트 결과와 에이전트 요약</summary>', '', '~~~text', commit.body, '~~~', '', '</details>');
    }
    return lines.join('\n');
  });

  const verification = commits.map((commit, index) => {
    const passed = commit.passedStages ?? [];
    return `- \`${commit.shortSha}\` ${requests[index]} — 통과: ${passed.length > 0 ? passed.join(', ') : '기록 없음'}`;
  });
  const unverified = missing.length > 0 ? missing.map((entry) => `- \`${entry.shortSha}\` ${entry.subject} — 기록 없음: ${entry.stages.join(', ')}`) : ['모든 커밋이 필수 단계를 통과했습니다'];

  const linked = [...new Set([...(issue === undefined ? [] : [issue]), ...(issues ?? [])])];
  const body = [
    ...(linked.length === 0 ? [] : [...linked.map((number) => `Closes #${number}`), '']),
    `\`${projectName}\` 프로젝트의 b-studio 세션에서 처리한 요청 ${commits.length}건입니다.`,
    '요청마다 스튜디오가 바뀐 서비스를 재시작하고 준비 상태와 API 계약을 확인했고, **검증 게이트를 통과한 변경만** 커밋했습니다.',
    '',
    `- 기준 브랜치: \`${base}\``,
    `- 세션 브랜치: \`${branch}\``,
    '',
    '## 요청',
    '',
    sections.join('\n\n'),
    '',
    '## 검증',
    '',
    verification.join('\n'),
    '',
    '## 돌리지 않은 검증',
    '',
    unverified.join('\n'),
  ].join('\n');
  return { title, body: capBody(body), missing };
}

/** 체크포인트 커밋 제목에서 "요청: " 접두사를 뺀 사람이 읽는 이름 */
function requestName(commit: SessionCommit): string {
  return commit.subject.replace(/^요청:\s*/, '');
}

function originOf(remote: RemoteLocation): string {
  return new URL(remote.webUrl!).origin;
}

/** GitHub와 Gitea는 API 주소·헤더 모양이 같다. 이슈 API에서 함께 쓴다 */
function gitHubStyleApi(
  remote: RemoteLocation,
  token: string,
  env: Env,
): { api: string; headers: Record<string, string>; label: string; owner: string; repo: string } {
  const [owner, repo, ...rest] = remote.path!.split('/');
  if (!owner || !repo || rest.length > 0) throw new PullRequestError(`저장소 경로가 owner/repo 형식이 아닙니다: ${remote.path}`);
  const github = remote.kind === 'github';
  const origin = originOf(remote);
  const api = github
    ? (env.B_STUDIO_GITHUB_API_URL ?? (remote.host === 'github.com' ? 'https://api.github.com' : `${origin}/api/v3`))
    : (env.B_STUDIO_GITEA_API_URL ?? `${origin}/api/v1`);
  return {
    api,
    headers: {
      accept: github ? 'application/vnd.github+json' : 'application/json',
      authorization: github ? `Bearer ${token}` : `token ${token}`,
      'content-type': 'application/json',
      ...(github ? { 'x-github-api-version': '2022-11-28' } : {}),
    },
    label: github ? 'GitHub' : 'Gitea',
    owner,
    repo,
  };
}

function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function capBody(body: string): string {
  return body.length <= MAX_PULL_REQUEST_BODY ? body : `${body.slice(0, MAX_PULL_REQUEST_BODY)}\n\n(본문이 길어 뒷부분을 생략했습니다)`;
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const data = JSON.parse(text) as { message?: unknown; errors?: Array<{ message?: string }> | unknown };
    const detail = Array.isArray(data.errors) ? data.errors.map((error: { message?: string }) => error.message).filter(Boolean).join('; ') : '';
    const message = typeof data.message === 'string' ? data.message : JSON.stringify(data.message ?? data);
    return `${message}${detail ? ` (${detail})` : ''}`.slice(0, 300);
  } catch {
    return text.slice(0, 300) || '응답 본문 없음';
  }
}
