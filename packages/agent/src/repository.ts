import type { SessionCommit } from './checkpoints';

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

export class PullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullRequestError';
  }
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
 * 세션 커밋만으로 PR 제목과 본문을 만든다. 체크포인트 커밋 본문에 검증 결과가 들어 있어
 * 스튜디오 서버의 메모리 상태 없이도 같은 PR을 다시 만들 수 있다.
 */
export function buildPullRequest({
  projectName,
  base,
  branch,
  commits,
}: {
  projectName: string;
  base: string;
  branch: string;
  commits: SessionCommit[];
}): { title: string; body: string } {
  const requests = commits.map((commit) => commit.subject.replace(/^요청:\s*/, ''));
  const first = requests[0] ?? `${projectName} 세션 변경`;
  const title = `[b-studio] ${first}${requests.length > 1 ? ` 외 ${requests.length - 1}건` : ''}`.slice(0, 120);

  const sections = commits.map((commit, index) => {
    const shown = commit.files.slice(0, 10).map((file) => `\`${file}\``);
    const more = commit.files.length > shown.length ? ` 외 ${commit.files.length - shown.length}개` : '';
    const lines = [`### ${index + 1}. ${requests[index]}`, '', `커밋 \`${commit.shortSha}\`, 파일 ${commit.files.length}개: ${shown.join(', ')}${more}`];
    if (commit.body) {
      lines.push('', '<details>', '<summary>검증 게이트 결과와 에이전트 요약</summary>', '', '~~~text', commit.body, '~~~', '', '</details>');
    }
    return lines.join('\n');
  });

  const body = [
    `\`${projectName}\` 프로젝트의 b-studio 세션에서 처리한 요청 ${commits.length}건입니다.`,
    '요청마다 스튜디오가 바뀐 서비스를 재시작하고 준비 상태와 API 계약을 확인했고, **검증 게이트를 통과한 변경만** 커밋했습니다.',
    '',
    `- 기준 브랜치: \`${base}\``,
    `- 세션 브랜치: \`${branch}\``,
    '',
    '## 요청',
    '',
    sections.join('\n\n'),
  ].join('\n');
  return { title, body: capBody(body) };
}

function originOf(remote: RemoteLocation): string {
  return new URL(remote.webUrl!).origin;
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
