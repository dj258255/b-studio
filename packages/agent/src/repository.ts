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

/** 체크리스트("- [ ] ", "- [x] ") 항목 하나 */
export interface TaskListItem {
  text: string;
  checked: boolean;
}

/** 이슈·PR 본문의 체크리스트 진행도. 항목이 없으면 total이 0이다 */
export interface TaskListProgress {
  total: number;
  checked: number;
  items: TaskListItem[];
}

/** 저장소 화면(이슈 상세)의 댓글 하나 */
export interface IssueComment {
  author: string;
  /** 마크다운 원문 */
  body: string;
  /** ISO 8601 */
  createdAt: string;
  url: string;
}

/** 이슈·PR이 서로 가리키는 관계. closes/fixes/resolves #n 문구나 제목·본문의 교차 참조로 찾는다 */
export interface LinkedReference {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  draft?: boolean;
}

/** 저장소 화면(이슈 상세) 하나 */
export interface IssueDetail extends IssueSummary {
  assignees: string[];
  /** 최근 것부터가 아니라 오래된 것부터(대화 순서). 최근 MAX_ISSUE_COMMENTS개만 담는다 */
  comments: IssueComment[];
  /** 지금까지 읽은 댓글 수(comments.length 이상일 수 있다. 더 있으면 truncated) */
  totalComments: number;
  commentsTruncated: boolean;
  taskList: TaskListProgress;
  /** 본문·제목에 closes/fixes/resolves #이슈번호로 이 이슈를 가리키는 PR들 */
  linkedPulls: LinkedReference[];
}

/** 저장소 화면(PR 상세)의 파일 하나. 이진 파일은 patch가 없다(GitHub·Gitea 모두 diff를 안 준다) */
export interface PullFile {
  path: string;
  /** GitHub 원문 그대로(added/removed/modified/renamed/copied/changed/unchanged) */
  status: string;
  additions: number;
  deletions: number;
  /** unified diff 조각. 이진 파일이거나 너무 커서 자르면 없다 */
  patch?: string;
  binary: boolean;
  /** 파일이나 전체 한도를 넘어 patch를 자르거나 아예 뺐다 */
  truncated: boolean;
}

/** 저장소 화면(PR 상세)의 CI 체크 하나 */
export interface CheckRun {
  name: string;
  /** GitHub 원문 그대로(queued/in_progress/completed) */
  status: string;
  /** completed일 때만(success/failure/neutral/cancelled/timed_out/action_required/stale/skipped) */
  conclusion?: string;
  url?: string;
  durationMs?: number;
}

export type IndividualReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending' | 'unknown';

/** 저장소 화면(PR 상세)의 리뷰 하나(리뷰어별 마지막 판정이 아니라, 있었던 리뷰 각각) */
export interface PullReview {
  author: string;
  state: IndividualReviewState;
  /** ISO 8601. 대기 중(PENDING)이면 없다 */
  submittedAt?: string;
}

/** 저장소 화면(PR 상세)의 리뷰 인라인 댓글 하나(파일·줄에 붙은 댓글) */
export interface PullReviewComment {
  author: string;
  body: string;
  path: string;
  /** 줄에 못 붙었으면(파일 댓글) 없다 */
  line?: number;
  url: string;
  createdAt: string;
}

/** 저장소 화면(PR 상세) 하나. files·checkRuns·reviewComments는 host가 지원하지 않으면 빈 배열에 이유를 남긴다 */
export interface PullDetail extends PullRequestSummary {
  body?: string;
  baseBranch: string;
  /** GitHub·Gitea 모두 계산에 시간이 걸려 결과가 없을 때(null)가 있다 */
  mergeable?: boolean;
  mergeableState?: string;
  files: PullFile[];
  filesSupported: boolean;
  filesUnsupportedReason?: string;
  /** 100개 넘게 있어 더 있을 수 있다(다음 쪽을 부르지 않는다, "cheap" 원칙) */
  filesTruncated: boolean;
  checkRuns: CheckRun[];
  checksSupported: boolean;
  checksUnsupportedReason?: string;
  reviews: PullReview[];
  reviewComments: PullReviewComment[];
  reviewCommentsSupported: boolean;
  reviewCommentsUnsupportedReason?: string;
  /** 본문·제목에 closes/fixes/resolves #이슈번호로 이 PR이 가리키는 이슈 번호들 */
  linkedIssues: number[];
}

const GITEA_FILES_UNSUPPORTED = 'Gitea REST API에는 파일별 변경 내용을 안전하게 흉내 낼 표준 API가 없어 아직 지원하지 않습니다';
const GITEA_CHECKS_UNSUPPORTED = 'Gitea는 GitHub 스타일의 체크 실행(check-runs) API가 없어 아직 지원하지 않습니다';
const GITEA_REVIEW_COMMENTS_UNSUPPORTED = 'Gitea는 리뷰 댓글을 리뷰 하나씩 따로 불러와야 해(N+1 호출) 아직 지원하지 않습니다';

/** 이슈 상세에서 보여 줄 댓글 수(가장 최근 것부터) */
const MAX_ISSUE_COMMENTS = 20;
/** 파일 하나의 patch 글자 수 한도 */
const MAX_FILE_PATCH_CHARS = 20_000;
/** PR 전체 patch 글자 수 한도. 이 한도를 넘으면 그 뒤 파일은 patch를 아예 빼고 truncated만 남긴다 */
const MAX_TOTAL_PATCH_CHARS = 200_000;

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

const TASK_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;

/** 이슈·PR 본문에서 "- [ ] 할 일"·"- [x] 한 일" 체크리스트를 뽑는다. 들여쓴 하위 항목도 하나로 센다(중첩 진행도는 화면에서 필요치 않다) */
export function parseTaskList(body: string | undefined): TaskListProgress {
  const items: TaskListItem[] = [];
  for (const line of (body ?? '').split('\n')) {
    const match = TASK_ITEM.exec(line);
    if (!match) continue;
    items.push({ checked: match[1]!.toLowerCase() === 'x', text: match[2]!.trim() });
  }
  return { total: items.length, checked: items.filter((item) => item.checked).length, items };
}

const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;

/** "Closes #12", "fixes #7" 같은 닫기 문구에서 참조한 이슈·PR 번호를 뽑는다(중복 없이, 나온 순서대로) */
export function parseClosingReferences(text: string | undefined): number[] {
  const numbers: number[] = [];
  for (const match of (text ?? '').matchAll(CLOSING_REFERENCE)) {
    const number = Number(match[1]);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

/** GitHub·Gitea 리뷰 상태 문구를 화면이 쓰는 값으로 바꾼다. 둘 다 대문자 스네이크 케이스를 쓴다 */
function mapReviewState(raw: string): IndividualReviewState {
  switch (raw.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
    case 'REQUEST_CHANGES':
      return 'changes_requested';
    case 'COMMENTED':
    case 'COMMENT':
      return 'commented';
    case 'DISMISSED':
      return 'dismissed';
    case 'PENDING':
      return 'pending';
    default:
      return 'unknown';
  }
}

/** patch를 파일·전체 한도에 맞춰 자른다. runningTotal은 지금까지 쓴 글자 수(호출부가 누적해 넘긴다) */
function capPatch(patch: string | undefined, runningTotal: number): { patch?: string; truncated: boolean } {
  if (patch === undefined) return { truncated: false };
  if (runningTotal >= MAX_TOTAL_PATCH_CHARS) return { truncated: true };
  const budget = Math.min(MAX_FILE_PATCH_CHARS, MAX_TOTAL_PATCH_CHARS - runningTotal);
  if (patch.length <= budget) return { patch, truncated: false };
  return { patch: `${patch.slice(0, budget)}\n\n(patch가 길어 뒷부분을 생략했습니다)`, truncated: true };
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

interface RawIssueComment {
  user?: { login?: string };
  body?: string | null;
  created_at: string;
  html_url: string;
}
interface RawAssignee {
  login?: string;
}

/**
 * 저장소 화면 이슈 상세. 본문·라벨·담당자에 더해, 최근 댓글(MAX_ISSUE_COMMENTS개)과 체크리스트 진행도,
 * 이 이슈를 closes/fixes/resolves로 가리키는 PR을 담는다. GitHub·Gitea 모두 이슈·댓글 API 모양이 같다.
 * 연결된 PR은 열림·닫힘을 모두 뒤져(한 번의 목록 호출) 본문·제목에서 closes 문구를 찾는다(호스트별 교차 참조 API 대신 —
 * 두 호스트에 똑같이 통하고 API 호출이 하나뿐이라 더 싸다).
 */
export async function fetchIssueDetail(
  remote: RemoteLocation,
  number: number,
  { env = process.env, fetch: fetchFn = fetch, token }: { env?: Env; fetch?: Fetch; token?: string } = {},
): Promise<IssueDetail> {
  if (remote.kind !== 'github' && remote.kind !== 'gitea') throw new PullRequestError('이슈 상세를 볼 수 있는 저장소 호스트가 아닙니다(GitHub·Gitea만 지원합니다)');
  if (!remote.host || !remote.path) throw new PullRequestError('저장소 주소를 해석하지 못했습니다');
  const auth = token ?? env[TOKEN_ENV[remote.kind]];
  if (!auth) throw new PullRequestError(`${TOKEN_ENV[remote.kind]} 토큰이 없어 이슈 상세를 볼 수 없습니다`);

  const { api, headers, label, owner, repo } = gitHubStyleApi(remote, auth, env);
  const base = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const issueResponse = await fetchFn(`${base}/issues/${number}`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  await assertListOk(issueResponse, label, '이슈');
  const raw = (await issueResponse.json()) as RawIssue & { assignees?: RawAssignee[] };

  const [commentsResult, pullsResult] = await Promise.all([
    fetchFn(`${base}/issues/${number}/comments?per_page=100`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) }).then(
      (response) => (response.ok ? (response.json() as Promise<RawIssueComment[]>) : undefined),
      () => undefined,
    ),
    fetchFn(`${base}/pulls?state=all&per_page=${LIST_PAGE_SIZE}`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) }).then(
      (response) => (response.ok ? (response.json() as Promise<Array<RawPull & { body?: string | null }>>) : undefined),
      () => undefined,
    ),
  ]);

  const allComments = commentsResult ?? [];
  const recent = allComments.slice(-MAX_ISSUE_COMMENTS).map((comment) => ({
    author: comment.user?.login ?? '알 수 없음',
    body: comment.body ?? '',
    createdAt: comment.created_at,
    url: comment.html_url,
  }));

  const linkedPulls: LinkedReference[] = (pullsResult ?? [])
    .filter((pull) => parseClosingReferences(`${pull.title} ${pull.body ?? ''}`).includes(number))
    .map((pull) => ({ number: pull.number, title: pull.title, url: pull.html_url, state: pull.state === 'open' ? 'open' : 'closed', draft: pull.draft === true }));

  return {
    number: raw.number,
    title: raw.title,
    author: raw.user?.login ?? '알 수 없음',
    labels: labelNames(raw.labels),
    updatedAt: raw.updated_at,
    url: raw.html_url,
    state: raw.state === 'open' ? 'open' : 'closed',
    body: raw.body ?? undefined,
    assignees: (raw.assignees ?? []).map((assignee) => assignee.login).filter((login): login is string => Boolean(login)),
    comments: recent,
    totalComments: allComments.length,
    commentsTruncated: allComments.length > MAX_ISSUE_COMMENTS,
    taskList: parseTaskList(raw.body ?? undefined),
    linkedPulls,
  };
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

interface RawPullDetail {
  number: number;
  title: string;
  body?: string | null;
  user?: { login?: string };
  labels?: Array<RawLabel | string>;
  updated_at: string;
  html_url: string;
  state: string;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  /** GitHub만 채운다. 계산이 끝나기 전이면 null */
  mergeable?: boolean | null;
  mergeable_state?: string;
}
interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  started_at?: string | null;
  completed_at?: string | null;
}
interface RawReview {
  user?: { login?: string };
  state: string;
  submitted_at?: string;
}
interface RawReviewComment {
  user?: { login?: string };
  body?: string | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
  html_url: string;
  created_at: string;
}
interface RawPullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * 저장소 화면 PR 상세. 제목·본문·base←head에 더해 GitHub는 바뀐 파일(패치 포함)·체크 실행·리뷰·리뷰 댓글을 모두 담는다.
 * Gitea는 리뷰 API 모양이 GitHub와 같아 리뷰는 함께 지원하지만, 파일별 diff·체크 실행·리뷰 댓글은 한 번에 싸게 받을 API가 없어
 * `*Supported: false`와 이유만 돌려준다(빈 배열로 조용히 감추지 않는다).
 */
export async function fetchPullRequestDetail(
  remote: RemoteLocation,
  number: number,
  {
    env = process.env,
    fetch: fetchFn = fetch,
    token,
    branchSessionId,
  }: { env?: Env; fetch?: Fetch; token?: string; branchSessionId?: (branch: string) => string | undefined } = {},
): Promise<PullDetail> {
  if (remote.kind !== 'github' && remote.kind !== 'gitea') throw new PullRequestError('PR 상세를 볼 수 있는 저장소 호스트가 아닙니다(GitHub·Gitea만 지원합니다)');
  if (!remote.host || !remote.path) throw new PullRequestError('저장소 주소를 해석하지 못했습니다');
  const auth = token ?? env[TOKEN_ENV[remote.kind]];
  if (!auth) throw new PullRequestError(`${TOKEN_ENV[remote.kind]} 토큰이 없어 PR 상세를 볼 수 없습니다`);
  const github = remote.kind === 'github';

  const { api, headers, label, owner, repo } = gitHubStyleApi(remote, auth, env);
  const base = `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const pullResponse = await fetchFn(`${base}/pulls/${number}`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  await assertListOk(pullResponse, label, 'PR');
  const raw = (await pullResponse.json()) as RawPullDetail;

  const [reviewsResult, checksResult, filesResult, reviewCommentsResult] = await Promise.all([
    fetchFn(`${base}/pulls/${number}/reviews?per_page=100`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) }).then(
      (response) => (response.ok ? (response.json() as Promise<RawReview[]>) : undefined),
      () => undefined,
    ),
    github
      ? fetchFn(`${base}/commits/${raw.head.sha}/check-runs?per_page=100`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) }).then(
          (response) => (response.ok ? (response.json() as Promise<{ check_runs: RawCheckRun[] }>) : undefined),
          () => undefined,
        )
      : Promise.resolve(undefined),
    github
      ? fetchFn(`${base}/pulls/${number}/files?per_page=100`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) }).then(
          async (response) => (response.ok ? { files: (await response.json()) as RawPullFile[], hasMore: hasNextPage(response) } : undefined),
          () => undefined,
        )
      : Promise.resolve(undefined),
    github
      ? fetchFn(`${base}/pulls/${number}/comments?per_page=100`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) }).then(
          (response) => (response.ok ? (response.json() as Promise<RawReviewComment[]>) : undefined),
          () => undefined,
        )
      : Promise.resolve(undefined),
  ]);

  let runningTotal = 0;
  const files: PullFile[] = (filesResult?.files ?? []).map((file) => {
    const binary = file.patch === undefined;
    const capped = capPatch(file.patch, runningTotal);
    runningTotal += capped.patch?.length ?? 0;
    return { path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, patch: capped.patch, binary, truncated: capped.truncated };
  });

  const checkRuns: CheckRun[] = (checksResult?.check_runs ?? []).map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion ?? undefined,
    url: run.html_url,
    durationMs: run.started_at && run.completed_at ? new Date(run.completed_at).getTime() - new Date(run.started_at).getTime() : undefined,
  }));

  const reviews: PullReview[] = (reviewsResult ?? []).map((review) => ({
    author: review.user?.login ?? '알 수 없음',
    state: mapReviewState(review.state),
    submittedAt: review.submitted_at,
  }));

  const reviewComments: PullReviewComment[] = (reviewCommentsResult ?? []).map((comment) => ({
    author: comment.user?.login ?? '알 수 없음',
    body: comment.body ?? '',
    path: comment.path,
    line: comment.line ?? comment.original_line ?? undefined,
    url: comment.html_url,
    createdAt: comment.created_at,
  }));

  return {
    number: raw.number,
    title: raw.title,
    author: raw.user?.login ?? '알 수 없음',
    labels: labelNames(raw.labels),
    updatedAt: raw.updated_at,
    url: raw.html_url,
    state: raw.state === 'open' ? 'open' : 'closed',
    draft: raw.draft === true,
    headBranch: raw.head.ref,
    headSha: raw.head.sha,
    sessionId: branchSessionId?.(raw.head.ref),
    checkStatus: github ? combineCheckStatus(checksResult?.check_runs ?? []) : undefined,
    reviewDecision: github ? combineReviewDecision((reviewsResult ?? []).filter((review): review is RawReview & { submitted_at: string } => Boolean(review.submitted_at))) : undefined,
    body: raw.body ?? undefined,
    baseBranch: raw.base.ref,
    mergeable: raw.mergeable ?? undefined,
    mergeableState: raw.mergeable_state,
    files,
    filesSupported: github,
    filesUnsupportedReason: github ? undefined : GITEA_FILES_UNSUPPORTED,
    filesTruncated: filesResult?.hasMore ?? false,
    checkRuns,
    checksSupported: github,
    checksUnsupportedReason: github ? undefined : GITEA_CHECKS_UNSUPPORTED,
    reviews,
    reviewComments,
    reviewCommentsSupported: github,
    reviewCommentsUnsupportedReason: github ? undefined : GITEA_REVIEW_COMMENTS_UNSUPPORTED,
    linkedIssues: parseClosingReferences(`${raw.title} ${raw.body ?? ''}`),
  };
}

/** Link 응답 헤더에 rel="next"가 있으면 더 있다(다음 쪽은 부르지 않는다 — "cheap" 원칙) */
function hasNextPage(response: Response): boolean {
  return /rel="next"/.test(response.headers.get('link') ?? '');
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
