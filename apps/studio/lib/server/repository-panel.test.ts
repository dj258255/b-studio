import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  findProject: vi.fn(async (): Promise<unknown> => undefined),
  inspectSource: vi.fn(async (): Promise<unknown> => undefined),
  listIssues: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => []),
  listPullRequests: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => []),
  fetchIssueDetail: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
    throw new Error('테스트가 준비되지 않았습니다');
  }),
  fetchPullRequestDetail: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
    throw new Error('테스트가 준비되지 않았습니다');
  }),
}));

vi.mock('./projects', () => ({ findProject: spies.findProject }));
vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return {
    ...actual,
    CheckpointStore: { inspectSource: spies.inspectSource },
    listIssues: spies.listIssues,
    listPullRequests: spies.listPullRequests,
    fetchIssueDetail: spies.fetchIssueDetail,
    fetchPullRequestDetail: spies.fetchPullRequestDetail,
  };
});
// localFolderAllowed()가 실제 gh CLI를 부르지 않도록, projectRepositoryIssues/Pulls 통합 테스트는 개인 PC 모드가 아니라고 둔다(gh CLI 대체는 resolveRepositoryToken에서 따로 테스트한다).
// sessions.ts 전체(무거운 세션 서버 모듈)를 불러오지 않도록 두 함수만 가볍게 흉내 낸다
vi.mock('./sessions', () => ({
  localFolderAllowed: () => false,
  sessionIdFromBranch: (projectId: string, branch: string) => {
    const prefix = `b-studio/${projectId}-`;
    return branch.startsWith(prefix) ? branch.slice(prefix.length) : undefined;
  },
}));

import { RepositoryRateLimitError } from '@b-studio/agent';
import { createRepositoryListCache, projectRepositoryIssue, projectRepositoryIssues, projectRepositoryPull, projectRepositoryPulls, resolveRepositoryToken } from './repository-panel';

const project = { root: '/tmp/orders', spec: { name: 'orders' } };

beforeEach(() => {
  spies.findProject.mockReset().mockResolvedValue(project);
  spies.inspectSource.mockReset().mockResolvedValue({ base: 'main', originUrl: 'git@github.com:acme/orders.git', dirtyFiles: 0, subdir: '' });
  spies.listIssues.mockReset().mockResolvedValue([]);
  spies.listPullRequests.mockReset().mockResolvedValue([]);
  spies.fetchIssueDetail.mockReset().mockRejectedValue(new Error('테스트가 준비되지 않았습니다'));
  spies.fetchPullRequestDetail.mockReset().mockRejectedValue(new Error('테스트가 준비되지 않았습니다'));
});

describe('resolveRepositoryToken', () => {
  it('환경 변수 토큰이 있으면 그것을 쓰고 gh CLI는 부르지 않는다', async () => {
    const ghToken = vi.fn(async () => 'from-cli');
    const token = await resolveRepositoryToken('github', { env: { B_STUDIO_GITHUB_TOKEN: 'from-env' }, allowGhCli: true, ghToken });

    expect(token).toBe('from-env');
    expect(ghToken).not.toHaveBeenCalled();
  });

  it('GitHub는 환경 변수가 없고 개인 PC 모드면 gh CLI 토큰으로 대신한다', async () => {
    const ghToken = vi.fn(async () => 'from-cli');
    const token = await resolveRepositoryToken('github', { env: {}, allowGhCli: true, ghToken });

    expect(token).toBe('from-cli');
    expect(ghToken).toHaveBeenCalledOnce();
  });

  it('여러 사람이 쓰는 서버(개인 PC 모드 아님)에서는 gh CLI를 부르지 않는다', async () => {
    const ghToken = vi.fn(async () => 'from-cli');
    const token = await resolveRepositoryToken('github', { env: {}, allowGhCli: false, ghToken });

    expect(token).toBeUndefined();
    expect(ghToken).not.toHaveBeenCalled();
  });

  it('Gitea는 gh CLI로 대신하지 않는다(GitHub 전용 CLI라서)', async () => {
    const ghToken = vi.fn(async () => 'from-cli');
    const token = await resolveRepositoryToken('gitea', { env: {}, allowGhCli: true, ghToken });

    expect(token).toBeUndefined();
    expect(ghToken).not.toHaveBeenCalled();
  });

  it('gh CLI가 없거나 로그인하지 않았으면(예외) undefined로 조용히 돌아간다', async () => {
    const ghToken = vi.fn(async () => {
      throw new Error('command not found: gh');
    });
    const token = await resolveRepositoryToken('github', { env: {}, allowGhCli: true, ghToken });

    expect(token).toBeUndefined();
  });
});

describe('createRepositoryListCache', () => {
  it('ttl 안에서는 다시 계산하지 않고, ttl이 지나면 다시 계산한다', async () => {
    let now = 0;
    const cache = createRepositoryListCache<number>({ now: () => now, ttlMs: 1_000 });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };

    expect(await cache.load('k', compute)).toBe(1);
    expect(await cache.load('k', compute)).toBe(1);

    now = 1_500;
    expect(await cache.load('k', compute)).toBe(2);
  });

  it('키가 다르면 따로 캐시한다', async () => {
    const cache = createRepositoryListCache<string>({ now: () => 0 });
    expect(await cache.load('a', async () => 'A')).toBe('A');
    expect(await cache.load('b', async () => 'B')).toBe('B');
  });
});

describe('projectRepositoryIssues', () => {
  it('원격 저장소가 없으면 no_remote 이유로 돌려주고 이슈 API는 부르지 않는다', async () => {
    spies.inspectSource.mockResolvedValue({ base: 'main', dirtyFiles: 0, subdir: '' });
    const result = await projectRepositoryIssues('orders-no-remote');

    expect(result).toMatchObject({ ok: false, reason: 'no_remote' });
    expect(spies.listIssues).not.toHaveBeenCalled();
  });

  it('프로젝트를 찾지 못하면 no_remote 이유로 돌려준다', async () => {
    spies.findProject.mockResolvedValue(undefined);
    const result = await projectRepositoryIssues('missing');

    expect(result).toMatchObject({ ok: false, reason: 'no_remote' });
  });

  it('GitHub·Gitea가 아닌 호스트는 unsupported_host 이유로 돌려준다', async () => {
    spies.inspectSource.mockResolvedValue({ base: 'main', originUrl: 'git@gitlab.com:acme/orders.git', dirtyFiles: 0, subdir: '' });
    const result = await projectRepositoryIssues('orders-gitlab');

    expect(result).toMatchObject({ ok: false, reason: 'unsupported_host' });
    expect(result.remote?.kind).toBe('gitlab');
  });

  it('토큰이 없으면 no_token 이유와 설정 방법을 알려 준다', async () => {
    delete process.env.B_STUDIO_GITHUB_TOKEN;
    const result = await projectRepositoryIssues('orders-no-token');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_token');
      expect(result.detail).toContain('gh auth login');
    }
  });

  it('토큰이 있으면 이슈 목록을 받아 그대로 돌려준다', async () => {
    process.env.B_STUDIO_GITHUB_TOKEN = 'ghp_test';
    spies.listIssues.mockResolvedValue([{ number: 1, title: '버그', author: 'yuna', labels: [], updatedAt: '2026-09-01T00:00:00Z', url: 'https://github.com/acme/orders/issues/1', state: 'open' }]);

    const result = await projectRepositoryIssues('orders-ok');

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(1);
    delete process.env.B_STUDIO_GITHUB_TOKEN;
  });

  it('사용량 한도에 걸리면 rate_limited 이유로 돌려준다', async () => {
    process.env.B_STUDIO_GITHUB_TOKEN = 'ghp_test';
    spies.listIssues.mockRejectedValue(new RepositoryRateLimitError('GitHub API 사용량 한도에 걸렸습니다', '2026-09-01T00:00:00Z'));

    const result = await projectRepositoryIssues('orders-limited');

    expect(result).toMatchObject({ ok: false, reason: 'rate_limited' });
    delete process.env.B_STUDIO_GITHUB_TOKEN;
  });
});

describe('projectRepositoryPulls', () => {
  it('헤드 브랜치가 이 프로젝트의 b-studio 세션 브랜치면 세션 id를 채운다', async () => {
    process.env.B_STUDIO_GITHUB_TOKEN = 'ghp_test';
    spies.listPullRequests.mockImplementation((async (_remote: unknown, options: { branchSessionId?: (branch: string) => string | undefined }) => [
      {
        number: 5,
        title: '주문 목록',
        author: 'yuna',
        labels: [],
        updatedAt: '2026-09-01T00:00:00Z',
        url: 'https://github.com/acme/orders/pull/5',
        state: 'open',
        draft: false,
        headBranch: 'b-studio/orders-ok-s1',
        headSha: 'abc',
        sessionId: options.branchSessionId?.('b-studio/orders-ok-s1'),
      },
    ]) as unknown as (...args: unknown[]) => Promise<unknown>);

    const result = await projectRepositoryPulls('orders-ok');

    expect(result.ok).toBe(true);
    expect(result.pulls?.[0]?.sessionId).toBe('s1');
    delete process.env.B_STUDIO_GITHUB_TOKEN;
  });
});

describe('projectRepositoryIssue', () => {
  it('원격 저장소가 없으면 no_remote 이유로 돌려주고 상세 API는 부르지 않는다', async () => {
    spies.inspectSource.mockResolvedValue({ base: 'main', dirtyFiles: 0, subdir: '' });
    const result = await projectRepositoryIssue('orders-no-remote', 57);

    expect(result).toMatchObject({ ok: false, reason: 'no_remote' });
    expect(spies.fetchIssueDetail).not.toHaveBeenCalled();
  });

  it('토큰이 있으면 상세를 받아 그대로 돌려준다', async () => {
    process.env.B_STUDIO_GITHUB_TOKEN = 'ghp_test';
    const issue = { number: 57, title: '주문 목록이 느립니다', author: 'yuna', labels: [], updatedAt: '2026-09-20T00:00:00Z', url: 'https://github.com/acme/orders/issues/57', state: 'open' as const, assignees: [], comments: [], totalComments: 0, commentsTruncated: false, taskList: { total: 0, checked: 0, items: [] }, linkedPulls: [] };
    spies.fetchIssueDetail.mockResolvedValue(issue);

    const result = await projectRepositoryIssue('orders-ok', 57);

    expect(result).toEqual({ ok: true, remote: { kind: 'github', display: 'github.com/acme/orders', webUrl: 'https://github.com/acme/orders' }, issue });
    expect(spies.fetchIssueDetail).toHaveBeenCalledWith(expect.anything(), 57, expect.objectContaining({ token: 'ghp_test' }));
    delete process.env.B_STUDIO_GITHUB_TOKEN;
  });

  it('상세 조회가 실패하면 이유를 담아 돌려준다', async () => {
    process.env.B_STUDIO_GITHUB_TOKEN = 'ghp_test';
    spies.fetchIssueDetail.mockRejectedValue(new RepositoryRateLimitError('GitHub API 사용량 한도에 걸렸습니다'));

    const result = await projectRepositoryIssue('orders-limited', 57);

    expect(result).toMatchObject({ ok: false, reason: 'rate_limited' });
    delete process.env.B_STUDIO_GITHUB_TOKEN;
  });
});

describe('projectRepositoryPull', () => {
  it('헤드 브랜치가 이 프로젝트의 b-studio 세션 브랜치면 세션 id를 채운다', async () => {
    process.env.B_STUDIO_GITHUB_TOKEN = 'ghp_test';
    spies.fetchPullRequestDetail.mockImplementation((async (_remote: unknown, _number: unknown, options: { branchSessionId?: (branch: string) => string | undefined }) => ({
      number: 5,
      title: '주문 목록',
      author: 'yuna',
      labels: [],
      updatedAt: '2026-09-01T00:00:00Z',
      url: 'https://github.com/acme/orders/pull/5',
      state: 'open',
      draft: false,
      headBranch: 'b-studio/orders-ok-s1',
      headSha: 'abc',
      sessionId: options.branchSessionId?.('b-studio/orders-ok-s1'),
      baseBranch: 'main',
      files: [],
      filesSupported: true,
      filesTruncated: false,
      checkRuns: [],
      checksSupported: true,
      reviews: [],
      reviewComments: [],
      reviewCommentsSupported: true,
      linkedIssues: [],
    })) as unknown as (...args: unknown[]) => Promise<unknown>);

    const result = await projectRepositoryPull('orders-ok', 5);

    expect(result.ok).toBe(true);
    expect(result.pull?.sessionId).toBe('s1');
    delete process.env.B_STUDIO_GITHUB_TOKEN;
  });

  it('원격 저장소가 없으면 no_remote 이유로 돌려주고 상세 API는 부르지 않는다', async () => {
    spies.inspectSource.mockResolvedValue({ base: 'main', dirtyFiles: 0, subdir: '' });
    const result = await projectRepositoryPull('orders-no-remote', 5);

    expect(result).toMatchObject({ ok: false, reason: 'no_remote' });
    expect(spies.fetchPullRequestDetail).not.toHaveBeenCalled();
  });
});
