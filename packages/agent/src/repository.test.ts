import { describe, expect, it } from 'vitest';
import { buildPullRequest, canCreatePullRequest, compareUrl, createPullRequest, parseRemote, PullRequestError } from './repository';

describe('parseRemote', () => {
  it.each([
    ['https://github.com/acme/orders.git', { kind: 'github', display: 'github.com/acme/orders', path: 'acme/orders', webUrl: 'https://github.com/acme/orders' }],
    ['git@github.com:acme/orders.git', { kind: 'github', path: 'acme/orders', webUrl: 'https://github.com/acme/orders' }],
    [
      'ssh://git@gitlab.example.com:2222/platform/admin/orders.git',
      { kind: 'other', display: 'gitlab.example.com/platform/admin/orders', webUrl: 'https://gitlab.example.com/platform/admin/orders' },
    ],
    ['http://127.0.0.1:3000/dev/orders.git', { kind: 'other', host: '127.0.0.1:3000', webUrl: 'http://127.0.0.1:3000/dev/orders' }],
    ['/Users/dev/orders', { kind: 'local', display: '/Users/dev/orders' }],
    ['file:///srv/git/orders.git', { kind: 'local', display: '/srv/git/orders.git' }],
  ])('%s', (url, expected) => {
    expect(parseRemote(url, {})).toMatchObject(expected);
  });

  it('사내 호스트는 B_STUDIO_GIT_PROVIDER로 종류를 정하고, 결과에 자격 증명을 남기지 않는다', () => {
    const remote = parseRemote('https://bot:secret-token@gitlab.corp.local/platform/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitlab' });
    expect(remote).toMatchObject({ kind: 'gitlab', display: 'gitlab.corp.local/platform/orders', webUrl: 'https://gitlab.corp.local/platform/orders' });
    expect(JSON.stringify(remote)).not.toContain('secret-token');
  });
});

describe('compareUrl · canCreatePullRequest', () => {
  it('호스트마다 PR 작성 페이지 주소를 만든다', () => {
    expect(compareUrl(parseRemote('git@github.com:acme/orders.git', {}), 'main', 'b-studio/orders-s1')).toBe(
      'https://github.com/acme/orders/compare/main...b-studio/orders-s1?expand=1',
    );
    expect(compareUrl(parseRemote('https://gitlab.com/platform/orders.git', {}), 'main', 'b-studio/orders-s1')).toBe(
      'https://gitlab.com/platform/orders/-/merge_requests/new?merge_request%5Bsource_branch%5D=b-studio%2Forders-s1&merge_request%5Btarget_branch%5D=main',
    );
    expect(compareUrl(parseRemote('/Users/dev/orders', {}), 'main', 'b-studio/orders-s1')).toBeUndefined();
  });

  it('호스트에 맞는 토큰이 있을 때만 PR을 만들 수 있다', () => {
    const github = parseRemote('git@github.com:acme/orders.git', {});
    expect(canCreatePullRequest(github, {})).toBe(false);
    expect(canCreatePullRequest(github, { B_STUDIO_GITLAB_TOKEN: 't' })).toBe(false);
    expect(canCreatePullRequest(github, { B_STUDIO_GITHUB_TOKEN: 't' })).toBe(true);
  });
});

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error('예상하지 못한 요청');
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const input = { title: '[b-studio] 메모 추가', body: '본문', base: 'main', branch: 'b-studio/orders-s1' };

describe('createPullRequest', () => {
  it('GitHub에 PR을 만든다', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: { html_url: 'https://github.com/acme/orders/pull/12', number: 12 } }]);
    const result = await createPullRequest(parseRemote('git@github.com:acme/orders.git', {}), input, {
      env: { B_STUDIO_GITHUB_TOKEN: 'ghp_test' },
      fetch: fn,
    });

    expect(result).toEqual({ url: 'https://github.com/acme/orders/pull/12', number: 12, created: true });
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/orders/pulls',
      method: 'POST',
      headers: { authorization: 'Bearer ghp_test' },
      body: { title: input.title, head: 'b-studio/orders-s1', base: 'main' },
    });
  });

  it('같은 브랜치로 열린 PR이 있으면 그 PR을 돌려준다', async () => {
    const { fn, calls } = fakeFetch([
      { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] } },
      { status: 200, body: [{ html_url: 'https://github.com/acme/orders/pull/7', number: 7, head: { ref: 'b-studio/orders-s1' }, base: { ref: 'main' } }] },
    ]);
    const result = await createPullRequest(parseRemote('https://github.com/acme/orders', {}), input, {
      env: { B_STUDIO_GITHUB_TOKEN: 't' },
      fetch: fn,
    });

    expect(result).toEqual({ url: 'https://github.com/acme/orders/pull/7', number: 7, created: false });
    expect(calls[1]?.method).toBe('GET');
  });

  it('사내 GitLab에 MR을 만든다', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: { web_url: 'https://gitlab.corp.local/platform/orders/-/merge_requests/3', iid: 3 } }]);
    const remote = parseRemote('git@gitlab.corp.local:platform/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitlab' });
    const result = await createPullRequest(remote, input, { env: { B_STUDIO_GITLAB_TOKEN: 'glpat' }, fetch: fn });

    expect(result).toMatchObject({ number: 3, created: true });
    expect(calls[0]).toMatchObject({
      url: 'https://gitlab.corp.local/api/v4/projects/platform%2Forders/merge_requests',
      headers: { 'private-token': 'glpat' },
      body: { source_branch: 'b-studio/orders-s1', target_branch: 'main' },
    });
  });

  it('거절 사유를 알려 주되 토큰은 메시지에 넣지 않는다', async () => {
    const { fn } = fakeFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    const error = await createPullRequest(parseRemote('git@github.com:acme/orders.git', {}), input, {
      env: { B_STUDIO_GITHUB_TOKEN: 'ghp_secret' },
      fetch: fn,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PullRequestError);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).toContain('Bad credentials');
    expect((error as Error).message).not.toContain('ghp_secret');
  });

  it('토큰이 없거나 지원하지 않는 호스트면 요청하지 않는다', async () => {
    const { fn, calls } = fakeFetch([]);
    await expect(createPullRequest(parseRemote('git@github.com:acme/orders.git', {}), input, { env: {}, fetch: fn })).rejects.toThrow('B_STUDIO_GITHUB_TOKEN');
    await expect(createPullRequest(parseRemote('/Users/dev/orders', {}), input, { env: {}, fetch: fn })).rejects.toThrow(PullRequestError);
    expect(calls).toHaveLength(0);
  });
});

describe('buildPullRequest', () => {
  it('세션 커밋만으로 제목과 요청별 검증 결과를 만든다', () => {
    const { title, body } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      commits: [
        { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: '요청: 주문 목록 API와 화면을 만들어줘', body: '검증 통과\n- api: 재시작 후 준비 완료', files: ['api/Order.java'] },
        { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: '요청: 주문에 배송 메모 필드 추가해줘', body: '', files: ['api/V2.sql', 'web/app/orders/page.tsx'] },
      ],
    });

    expect(title).toBe('[b-studio] 주문 목록 API와 화면을 만들어줘 외 1건');
    expect(body).toContain('- 기준 브랜치: `main`');
    expect(body).toContain('### 1. 주문 목록 API와 화면을 만들어줘');
    expect(body).toContain('~~~text\n검증 통과\n- api: 재시작 후 준비 완료\n~~~');
    expect(body).toContain('### 2. 주문에 배송 메모 필드 추가해줘\n\n커밋 `bbbbbbb`, 파일 2개: `api/V2.sql`, `web/app/orders/page.tsx`');
  });
});
