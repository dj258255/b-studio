import { describe, expect, it } from 'vitest';
import { addSubIssue, buildPullRequest, canCreatePullRequest, compareUrl, createIssue, createPullRequest, fetchIssue, parseRemote, PullRequestError } from './repository';

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

  it('이슈 번호가 있으면 본문 첫 줄에 Closes #N을 넣는다', () => {
    const { body } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      issue: 57,
      commits: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: '요청: 메모 추가', body: '', files: ['api/Order.java'] }],
    });

    expect(body.startsWith('Closes #57\n')).toBe(true);
  });

  it('여러 이슈를 받으면(단수 issue와 합쳐) 본문 첫 줄들에 Closes #N을 하나씩 넣는다', () => {
    const { body } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      issue: 57,
      issues: [58, 57],
      commits: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: '요청: 메모 추가', body: '', files: ['api/Order.java'] }],
    });

    // 단수와 배열을 합치고 중복은 한 번만 남긴다
    expect(body.startsWith('Closes #57\nCloses #58\n')).toBe(true);
  });

  it('필수 단계를 통과한 커밋과 기록 없는 단계를 구분해 검증·돌리지 않은 검증 절에 남긴다', () => {
    const requiredStages = ['plan', 'implement', 'run', 'contract_check', 'test', 'review', 'checkpoint'] as const;
    const { body, missing } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      requiredStages,
      commits: [
        {
          sha: 'a'.repeat(40),
          shortSha: 'aaaaaaa',
          subject: '요청: 주문 목록 API',
          body: '',
          files: ['api/Order.java'],
          passedStages: ['run', 'contract_check', 'test', 'review'],
        },
        { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: '요청: 배송 메모 추가', body: '', files: ['api/V2.sql'], passedStages: ['run', 'contract_check'] },
        { sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: '요청: 화면 정리', body: '', files: ['web/page.tsx'] },
      ],
    });

    expect(body).toContain('## 검증');
    expect(body).toContain('- `aaaaaaa` 주문 목록 API — 통과: run, contract_check, test, review');
    expect(body).toContain('- `ccccccc` 화면 정리 — 통과: 기록 없음');
    // plan·implement·checkpoint는 통과 기록에 없는 것이 정상이라 돌리지 않은 검증으로 세지 않는다
    expect(body).toContain('## 돌리지 않은 검증');
    expect(body).toContain('- `bbbbbbb` 배송 메모 추가 — 기록 없음: test, review');
    expect(body).toContain('- `ccccccc` 화면 정리 — 기록 없음: run, contract_check, test, review');
    expect(missing).toEqual([
      { shortSha: 'bbbbbbb', subject: '배송 메모 추가', stages: ['test', 'review'] },
      { shortSha: 'ccccccc', subject: '화면 정리', stages: ['run', 'contract_check', 'test', 'review'] },
    ]);
  });

  it('모든 커밋이 필수 단계를 통과하면 그렇게 알린다', () => {
    const { body, missing } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      requiredStages: ['run', 'contract_check'],
      commits: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: '요청: 메모 추가', body: '', files: [], passedStages: ['run', 'contract_check'] }],
    });

    expect(missing).toEqual([]);
    expect(body).toContain('## 돌리지 않은 검증\n\n모든 커밋이 필수 단계를 통과했습니다');
  });
});

describe('fetchIssue', () => {
  it('GitHub·Gitea는 issues API로, GitLab은 projects API로 조회하고 제목과 상태를 돌려준다', async () => {
    const github = await fetchIssue(parseRemote('git@github.com:acme/orders.git', {}), 57, {
      env: { B_STUDIO_GITHUB_TOKEN: 't' },
      fetch: fakeFetch([{ status: 200, body: { state: 'open', title: 'PR 미리보기', html_url: 'https://github.com/acme/orders/issues/57' } }]).fn,
    });
    expect(github).toEqual({ state: 'open', title: 'PR 미리보기', url: 'https://github.com/acme/orders/issues/57' });

    const giteaCall = fakeFetch([{ status: 200, body: { state: 'closed', title: '닫힌 이슈', html_url: 'https://git.corp.local/dev/orders/issues/3' } }]);
    const gitea = await fetchIssue(parseRemote('https://git.corp.local/dev/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitea' }), 3, {
      env: { B_STUDIO_GITEA_TOKEN: 't' },
      fetch: giteaCall.fn,
    });
    expect(gitea).toEqual({ state: 'closed', title: '닫힌 이슈', url: 'https://git.corp.local/dev/orders/issues/3' });
    expect(giteaCall.calls[0]).toMatchObject({ url: 'https://git.corp.local/api/v1/repos/dev/orders/issues/3', headers: { authorization: 'token t' } });

    const gitlabCall = fakeFetch([{ status: 200, body: { state: 'opened', title: 'MR 미리보기', web_url: 'https://gitlab.corp.local/platform/orders/-/issues/3' } }]);
    const gitlab = await fetchIssue(parseRemote('git@gitlab.corp.local:platform/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitlab' }), 3, {
      env: { B_STUDIO_GITLAB_TOKEN: 't' },
      fetch: gitlabCall.fn,
    });
    // GitLab은 opened를 open으로 바꾼다
    expect(gitlab).toEqual({ state: 'open', title: 'MR 미리보기', url: 'https://gitlab.corp.local/platform/orders/-/issues/3' });
    expect(gitlabCall.calls[0]?.url).toBe('https://gitlab.corp.local/api/v4/projects/platform%2Forders/issues/3');
  });

  it('조회가 실패하면 이유를 담아 던지고, 토큰이 없으면 요청하지 않는다', async () => {
    const failure = fakeFetch([{ status: 404, body: { message: 'Not Found' } }]);
    const error = await fetchIssue(parseRemote('git@github.com:acme/orders.git', {}), 999, {
      env: { B_STUDIO_GITHUB_TOKEN: 't' },
      fetch: failure.fn,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PullRequestError);
    expect((error as Error).message).toContain('HTTP 404');

    const none = fakeFetch([]);
    await expect(fetchIssue(parseRemote('git@github.com:acme/orders.git', {}), 57, { env: {}, fetch: none.fn })).rejects.toThrow('B_STUDIO_GITHUB_TOKEN');
    await expect(fetchIssue(parseRemote('/Users/dev/orders', {}), 57, { env: {}, fetch: none.fn })).rejects.toThrow(PullRequestError);
    expect(none.calls).toHaveLength(0);
  });
});

describe('createIssue', () => {
  const issue = { title: '[작업 분해] 메모 추가', body: '본문', labels: ['enhancement'] };

  it('GitHub·Gitea는 issues API로, GitLab은 projects API로 이슈를 만들고 번호와 주소를 돌려준다', async () => {
    const github = fakeFetch([{ status: 201, body: { number: 66, html_url: 'https://github.com/acme/orders/issues/66' } }]);
    const created = await createIssue(parseRemote('git@github.com:acme/orders.git', {}), issue, { env: { B_STUDIO_GITHUB_TOKEN: 'ghp' }, fetch: github.fn });
    expect(created).toEqual({ number: 66, url: 'https://github.com/acme/orders/issues/66' });
    expect(github.calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/orders/issues',
      method: 'POST',
      headers: { authorization: 'Bearer ghp' },
      body: { title: issue.title, body: issue.body, labels: ['enhancement'] },
    });

    const gitea = fakeFetch([{ status: 201, body: { number: 3, html_url: 'https://git.corp.local/dev/orders/issues/3' } }]);
    const giteaIssue = await createIssue(parseRemote('https://git.corp.local/dev/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitea' }), { title: 't', body: 'b' }, {
      env: { B_STUDIO_GITEA_TOKEN: 't' },
      fetch: gitea.fn,
    });
    expect(giteaIssue).toEqual({ number: 3, url: 'https://git.corp.local/dev/orders/issues/3' });
    expect(gitea.calls[0]).toMatchObject({ url: 'https://git.corp.local/api/v1/repos/dev/orders/issues', headers: { authorization: 'token t' } });
    // 라벨을 주지 않으면 필드를 넣지 않는다
    expect(gitea.calls[0]!.body).toEqual({ title: 't', body: 'b' });

    const gitlab = fakeFetch([{ status: 201, body: { iid: 7, web_url: 'https://gitlab.corp.local/platform/orders/-/issues/7' } }]);
    const mr = await createIssue(parseRemote('git@gitlab.corp.local:platform/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitlab' }), issue, {
      env: { B_STUDIO_GITLAB_TOKEN: 'glpat' },
      fetch: gitlab.fn,
    });
    expect(mr).toEqual({ number: 7, url: 'https://gitlab.corp.local/platform/orders/-/issues/7' });
    expect(gitlab.calls[0]).toMatchObject({
      url: 'https://gitlab.corp.local/api/v4/projects/platform%2Forders/issues',
      headers: { 'private-token': 'glpat' },
      body: { title: issue.title, description: issue.body, labels: ['enhancement'] },
    });
  });

  it('거절 사유를 알려 주되 토큰은 메시지에 넣지 않고, 토큰이 없으면 요청하지 않는다', async () => {
    const failure = fakeFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    const error = await createIssue(parseRemote('git@github.com:acme/orders.git', {}), issue, { env: { B_STUDIO_GITHUB_TOKEN: 'ghp_secret' }, fetch: failure.fn }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(PullRequestError);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain('ghp_secret');

    const none = fakeFetch([]);
    await expect(createIssue(parseRemote('git@github.com:acme/orders.git', {}), issue, { env: {}, fetch: none.fn })).rejects.toThrow('B_STUDIO_GITHUB_TOKEN');
    await expect(createIssue(parseRemote('/Users/dev/orders', {}), issue, { env: {}, fetch: none.fn })).rejects.toThrow(PullRequestError);
    expect(none.calls).toHaveLength(0);
  });
});

describe('addSubIssue', () => {
  it('GitHub에서 child 이슈 id를 조회해 parent의 하위 이슈로 연결한다', async () => {
    // sub_issue_id는 이슈 번호가 아니라 id라서 GET으로 id를 먼저 얻는다
    const { fn, calls } = fakeFetch([
      { status: 200, body: { id: 90_005, number: 5 } },
      { status: 201, body: { number: 5 } },
    ]);
    const result = await addSubIssue(parseRemote('git@github.com:acme/orders.git', {}), 7, 5, { env: { B_STUDIO_GITHUB_TOKEN: 'ghp' }, fetch: fn });

    expect(result).toEqual({ supported: true });
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/repos/acme/orders/issues/5', method: 'GET' });
    expect(calls[1]).toMatchObject({
      url: 'https://api.github.com/repos/acme/orders/issues/7/sub_issues',
      method: 'POST',
      body: { sub_issue_id: 90_005 },
    });
  });

  it('Gitea·GitLab은 지원하지 않는다고 돌려주고 요청하지 않는다', async () => {
    const { fn, calls } = fakeFetch([]);
    const gitea = await addSubIssue(parseRemote('https://git.corp.local/dev/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitea' }), 7, 5, { env: {}, fetch: fn });
    const gitlab = await addSubIssue(parseRemote('git@gitlab.corp.local:platform/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitlab' }), 7, 5, { env: {}, fetch: fn });

    expect(gitea).toEqual({ supported: false });
    expect(gitlab).toEqual({ supported: false });
    expect(calls).toHaveLength(0);
  });

  it('GitHub에서 토큰이 없으면 요청하지 않고, 연결 실패는 토큰을 넣지 않고 알린다', async () => {
    const none = fakeFetch([]);
    await expect(addSubIssue(parseRemote('git@github.com:acme/orders.git', {}), 7, 5, { env: {}, fetch: none.fn })).rejects.toThrow('B_STUDIO_GITHUB_TOKEN');
    expect(none.calls).toHaveLength(0);

    const failure = fakeFetch([
      { status: 200, body: { id: 90_005 } },
      { status: 410, body: { message: 'Gone' } },
    ]);
    const error = await addSubIssue(parseRemote('git@github.com:acme/orders.git', {}), 7, 5, { env: { B_STUDIO_GITHUB_TOKEN: 'ghp_secret' }, fetch: failure.fn }).catch(
      (reason: unknown) => reason,
    );
    expect((error as Error).message).toContain('HTTP 410');
    expect((error as Error).message).not.toContain('ghp_secret');
  });
});
