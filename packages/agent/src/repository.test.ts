import { describe, expect, it } from 'vitest';
import {
  addSubIssue,
  buildPullRequest,
  canCreatePullRequest,
  compareUrl,
  createIssue,
  createLabel,
  createPullRequest,
  ensureLabels,
  fetchIssue,
  fetchIssueDetail,
  fetchPullRequestDetail,
  listIssueComments,
  listIssues,
  listLabels,
  listPullRequests,
  parseClosingReferences,
  parsePullRequestNumber,
  parseRemote,
  parseTaskList,
  postComment,
  PullRequestError,
  RepositoryRateLimitError,
  updateComment,
  updateIssue,
} from './repository';

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

  it('토큰을 따로 주면(개인 PC 모드의 gh CLI 대체 등) 환경 변수가 없어도 PR을 만들 수 있다(57번 버그)', () => {
    const github = parseRemote('git@github.com:acme/orders.git', {});
    expect(canCreatePullRequest(github, {}, 'gh-cli-token')).toBe(true);
    // 환경 변수가 있어도 따로 준 토큰이 있으면 그것으로 판단한다
    expect(canCreatePullRequest(github, {}, undefined)).toBe(false);
  });
});

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
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
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json', ...next.headers } });
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

  it('환경 변수가 없어도 따로 준 토큰(개인 PC 모드의 gh CLI 대체 등)으로 PR을 만든다(57번 버그)', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: { html_url: 'https://github.com/acme/orders/pull/12', number: 12 } }]);
    const result = await createPullRequest(parseRemote('git@github.com:acme/orders.git', {}), input, { env: {}, fetch: fn, token: 'gh-cli-token' });

    expect(result).toMatchObject({ number: 12, created: true });
    expect(calls[0]).toMatchObject({ headers: { authorization: 'Bearer gh-cli-token' } });
  });
});

describe('parsePullRequestNumber', () => {
  it.each([
    ['https://github.com/acme/orders/pull/12', 12],
    ['https://git.corp.local/dev/orders/pulls/7', 7],
    ['https://gitlab.corp.local/platform/orders/-/merge_requests/3', 3],
    ['https://gitlab.corp.local/platform/orders/-/merge_requests/3#note_9', 3],
    ['https://github.com/acme/orders', undefined],
  ])('%s → %s', (url, expected) => {
    expect(parsePullRequestNumber(url)).toBe(expected);
  });
});

describe('postComment', () => {
  it('GitHub·Gitea는 이슈 댓글 API로 PR(MR)에 댓글을 단다', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: { html_url: 'https://github.com/acme/orders/pull/12#issuecomment-1' } }]);
    const result = await postComment(parseRemote('git@github.com:acme/orders.git', {}), 12, '### AI 리뷰\n\n표', {
      env: { B_STUDIO_GITHUB_TOKEN: 'ghp_test' },
      fetch: fn,
    });
    expect(result.url).toBe('https://github.com/acme/orders/pull/12#issuecomment-1');
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/orders/issues/12/comments');
    expect(calls[0]!.body).toEqual({ body: '### AI 리뷰\n\n표' });
  });

  it('GitLab은 머지 리퀘스트 노트 API로 댓글을 달고, 응답의 id로 주소를 만든다', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: { id: 9 } }]);
    const remote = parseRemote('https://gitlab.corp.local/platform/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitlab' });
    const result = await postComment(remote, 3, '표', { env: { B_STUDIO_GITLAB_TOKEN: 'glpat' }, fetch: fn });
    expect(result.url).toBe('https://gitlab.corp.local/platform/orders/-/merge_requests/3#note_9');
    expect(calls[0]!.url).toContain('/merge_requests/3/notes');
  });

  it('환경 변수 토큰보다 넘겨준 token을 우선한다(gh CLI 폴백 재사용)', async () => {
    const { fn, calls } = fakeFetch([{ status: 201, body: { html_url: 'https://github.com/acme/orders/pull/12#issuecomment-2' } }]);
    await postComment(parseRemote('git@github.com:acme/orders.git', {}), 12, '표', { env: {}, fetch: fn, token: 'gh-cli-token' });
    expect(calls[0]!.headers.authorization).toBe('Bearer gh-cli-token');
  });

  it('토큰이 없거나 지원하지 않는 호스트면 요청하지 않는다', async () => {
    const { fn, calls } = fakeFetch([]);
    await expect(postComment(parseRemote('git@github.com:acme/orders.git', {}), 12, '표', { env: {}, fetch: fn })).rejects.toThrow('B_STUDIO_GITHUB_TOKEN');
    await expect(postComment(parseRemote('/Users/dev/orders', {}), 12, '표', { env: {}, fetch: fn })).rejects.toThrow(PullRequestError);
    expect(calls).toHaveLength(0);
  });

  it('거절 사유를 알려 준다', async () => {
    const { fn } = fakeFetch([{ status: 404, body: { message: 'Not Found' } }]);
    await expect(postComment(parseRemote('git@github.com:acme/orders.git', {}), 12, '표', { env: { B_STUDIO_GITHUB_TOKEN: 'ghp_test' }, fetch: fn })).rejects.toThrow('HTTP 404');
  });
});

describe('buildPullRequest', () => {
  it('세션 커밋만으로 제목과 요청별 검증 결과를 만든다(제목은 가장 많이 바뀐 커밋을 요약한다)', () => {
    const { title, body } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      commits: [
        { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: '요청: 주문 목록 API와 화면을 만들어줘', body: '검증 통과\n- api: 재시작 후 준비 완료', files: ['api/Order.java'] },
        { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: '요청: 주문에 배송 메모 필드 추가해줘', body: '', files: ['api/V2.sql', 'web/app/orders/page.tsx'] },
      ],
    });

    // 두 번째 커밋이 파일을 더 많이 바꿔(2개 > 1개) 제목의 기본값이 된다
    expect(title).toBe('[b-studio] 주문에 배송 메모 필드 추가해줘');
    expect(body).toContain('- 기준 브랜치: `main`');
    expect(body).toContain('### 1. 주문 목록 API와 화면을 만들어줘');
    expect(body).toContain('~~~text\n검증 통과\n- api: 재시작 후 준비 완료\n~~~');
    expect(body).toContain('### 2. 주문에 배송 메모 필드 추가해줘\n\n커밋 `bbbbbbb`, 파일 2개: `api/V2.sql`, `web/app/orders/page.tsx`');
  });

  it('요구사항 id가 걸려 있으면 제목을 요구사항 수·범위로 요약한다', () => {
    const { title } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      requirementIds: ['R2', 'R5', 'R23'],
      commits: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: '요청: 작업 분해 통합: 다음 필수(must) 요구사항을 모두 구현', body: '', files: Array.from({ length: 30 }, (_, i) => `api/f${i}.java`) }],
    });

    expect(title).toBe('[b-studio] feat: 요구사항 3개 구현과 검증 (R2~R23)');
  });

  it('제목은 접두어를 포함해 72자 안팎을 넘지 않는다', () => {
    const { title } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      commits: [
        {
          sha: 'a'.repeat(40),
          shortSha: 'aaaaaaa',
          subject: '요청: 아주 길게 설명하는 요청 글이어서 제목에 그대로 쓰면 72자를 훌쩍 넘기는 경우를 테스트하기 위한 글입니다',
          body: '',
          files: ['api/Order.java'],
        },
      ],
    });

    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.startsWith('[b-studio] ')).toBe(true);
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

  it('여러 이슈를 받으면(단수 issue와 합쳐) 본문 첫 줄들에 Closes #N을 하나씩 넣고 중복되지 않게 한 블록으로만 쓴다', () => {
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
    // Closes 블록은 본문에 한 번만 나온다(버그 리포트: 같은 이슈가 위아래 두 번 나왔다)
    expect(body.match(/Closes #57/g)).toHaveLength(1);
    expect(body.match(/Closes #58/g)).toHaveLength(1);
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

  it('문서 체크포인트(Workflow-Verify: docs)는 필수 단계 누락으로 세지 않고 "문서 체크포인트"로 보여준다', () => {
    const { body, missing } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      requiredStages: ['run', 'contract_check', 'review'],
      commits: [
        { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: '요청: 주문 API', body: '', files: ['api/Order.java'], passedStages: ['run', 'contract_check', 'review'] },
        { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'docs: 요구사항을 정리한다', body: '', files: ['docs/requirements.md'], verify: 'docs' },
      ],
    });

    // 문서 체크포인트는 "필수 단계 기록이 없는 커밋"으로 세지 않는다 — stages_passed 점검이 이 배열로 판단한다
    expect(missing).toEqual([]);
    expect(body).toContain('- `bbbbbbb` docs: 요구사항을 정리한다 — 문서 체크포인트(게이트 대상 아님)');
    expect(body).toContain('## 돌리지 않은 검증\n\n- `bbbbbbb` docs: 요구사항을 정리한다 — 문서만 바뀜(게이트 대상 아님)');
  });

  it('Workflow-Verify: docs여도 문서가 아닌 파일이 섞여 있으면 예외로 치지 않는다(트레일러를 그대로 믿지 않는다)', () => {
    const { body, missing } = buildPullRequest({
      projectName: 'orders',
      base: 'main',
      branch: 'b-studio/orders-s1',
      requiredStages: ['run', 'contract_check'],
      commits: [
        { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: '요청: 뒤섞인 커밋', body: '', files: ['docs/requirements.md', 'api/Order.java'], verify: 'docs' },
      ],
    });

    expect(missing).toEqual([{ shortSha: 'aaaaaaa', subject: '뒤섞인 커밋', stages: ['run', 'contract_check'] }]);
    expect(body).toContain('- `aaaaaaa` 뒤섞인 커밋 — 통과: 기록 없음');
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

  it('주입한 토큰이 있으면 환경 변수가 비어도 그것을 쓴다(studio의 gh CLI 폴백 토큰, 버그 리포트)', async () => {
    const call = fakeFetch([{ status: 200, body: { state: 'open', title: '주입 토큰', html_url: 'https://github.com/acme/orders/issues/9' } }]);
    const result = await fetchIssue(parseRemote('git@github.com:acme/orders.git', {}), 9, { env: {}, fetch: call.fn, token: 'injected' });
    expect(result).toEqual({ state: 'open', title: '주입 토큰', url: 'https://github.com/acme/orders/issues/9' });
    expect(call.calls[0]).toMatchObject({ headers: { authorization: 'Bearer injected' } });
  });
});

describe('listIssues', () => {
  it('GitHub·Gitea 이슈 목록을 저장소 화면 모양으로 바꾸고, PR이 섞여 있으면 뺀다', async () => {
    const github = fakeFetch([
      {
        status: 200,
        body: [
          { number: 12, title: '로그인 오류', user: { login: 'yuna' }, labels: [{ name: 'bug' }, 'p1'], updated_at: '2026-09-20T00:00:00Z', html_url: 'https://github.com/acme/orders/issues/12', state: 'open' },
          { number: 13, title: 'PR인데 이슈 API에 섞여 옴', user: { login: 'bot' }, labels: [], updated_at: '2026-09-21T00:00:00Z', html_url: 'https://github.com/acme/orders/pull/13', state: 'open', pull_request: {} },
        ],
      },
    ]);
    const issues = await listIssues(parseRemote('git@github.com:acme/orders.git', {}), { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: github.fn });

    expect(issues).toEqual([
      { number: 12, title: '로그인 오류', author: 'yuna', labels: ['bug', 'p1'], updatedAt: '2026-09-20T00:00:00Z', url: 'https://github.com/acme/orders/issues/12', state: 'open' },
    ]);
    expect(github.calls[0]?.url).toBe('https://api.github.com/repos/acme/orders/issues?state=open&per_page=50');

    const giteaCall = fakeFetch([
      {
        status: 200,
        body: [{ number: 3, title: '닫힌 이슈', user: { login: 'dev' }, labels: [], updated_at: '2026-09-19T00:00:00Z', html_url: 'https://git.corp.local/dev/orders/issues/3', state: 'closed' }],
      },
    ]);
    const gitea = await listIssues(parseRemote('https://git.corp.local/dev/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitea' }), {
      state: 'closed',
      env: { B_STUDIO_GITEA_TOKEN: 't' },
      fetch: giteaCall.fn,
    });
    expect(gitea).toEqual([{ number: 3, title: '닫힌 이슈', author: 'dev', labels: [], updatedAt: '2026-09-19T00:00:00Z', url: 'https://git.corp.local/dev/orders/issues/3', state: 'closed' }]);
    expect(giteaCall.calls[0]?.url).toBe('https://git.corp.local/api/v1/repos/dev/orders/issues?state=closed&per_page=50');
  });

  it('목록 응답에 이미 들어 있는 본문을 그대로 담아, 이슈를 따로 조회하지 않아도 되게 한다', async () => {
    const { fn } = fakeFetch([
      {
        status: 200,
        body: [
          { number: 9, title: '본문 있음', user: { login: 'yuna' }, labels: [], updated_at: '2026-09-20T00:00:00Z', html_url: 'https://github.com/acme/orders/issues/9', state: 'open', body: '재현 방법...' },
          { number: 10, title: '본문 없음', user: { login: 'yuna' }, labels: [], updated_at: '2026-09-20T00:00:00Z', html_url: 'https://github.com/acme/orders/issues/10', state: 'open', body: null },
        ],
      },
    ]);
    const issues = await listIssues(parseRemote('git@github.com:acme/orders.git', {}), { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: fn });
    expect(issues[0]?.body).toBe('재현 방법...');
    expect(issues[1]?.body).toBeUndefined();
  });

  it('작성자가 없으면 "알 수 없음"으로 채운다', async () => {
    const { fn } = fakeFetch([{ status: 200, body: [{ number: 1, title: '작성자 없음', labels: [], updated_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/acme/orders/issues/1', state: 'open' }] }]);
    const issues = await listIssues(parseRemote('git@github.com:acme/orders.git', {}), { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: fn });
    expect(issues[0]?.author).toBe('알 수 없음');
  });

  it('GitLab이나 사용량 한도, 토큰 없음은 명확한 오류로 알린다', async () => {
    const none = fakeFetch([]);
    await expect(listIssues(parseRemote('/Users/dev/orders', {}), { env: {}, fetch: none.fn })).rejects.toThrow(PullRequestError);
    await expect(listIssues(parseRemote('git@gitlab.corp.local:platform/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitlab' }), { env: { B_STUDIO_GITLAB_TOKEN: 't' }, fetch: none.fn })).rejects.toThrow(
      'GitHub·Gitea만 지원합니다',
    );
    await expect(listIssues(parseRemote('git@github.com:acme/orders.git', {}), { env: {}, fetch: none.fn })).rejects.toThrow('B_STUDIO_GITHUB_TOKEN');
    expect(none.calls).toHaveLength(0);

    const limited = fakeFetch([{ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1780000000' } }]);
    const error = await listIssues(parseRemote('git@github.com:acme/orders.git', {}), { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: limited.fn }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RepositoryRateLimitError);
    expect((error as RepositoryRateLimitError).retryAt).toBe(new Date(1_780_000_000 * 1000).toISOString());
  });
});

describe('listPullRequests', () => {
  const pull = (overrides: Record<string, unknown> = {}) => ({
    number: 21,
    title: '주문 목록 API',
    user: { login: 'yuna' },
    labels: [{ name: 'feature' }],
    updated_at: '2026-09-22T00:00:00Z',
    html_url: 'https://github.com/acme/orders/pull/21',
    state: 'open',
    draft: false,
    head: { ref: 'b-studio/orders-s1', sha: 'abc123' },
    ...overrides,
  });

  it('PR 목록을 저장소 화면 모양으로 바꾸고, 브랜치로 세션 id를 찾아 채운다', async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: [pull()] },
      { status: 200, body: { check_runs: [{ status: 'completed', conclusion: 'success' }] } },
      { status: 200, body: [{ user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-09-22T01:00:00Z' }] },
    ]);
    const pulls = await listPullRequests(parseRemote('git@github.com:acme/orders.git', {}), {
      env: { B_STUDIO_GITHUB_TOKEN: 't' },
      fetch: fn,
      branchSessionId: (branch) => (branch === 'b-studio/orders-s1' ? 's1' : undefined),
    });

    expect(pulls).toEqual([
      {
        number: 21,
        title: '주문 목록 API',
        author: 'yuna',
        labels: ['feature'],
        updatedAt: '2026-09-22T00:00:00Z',
        url: 'https://github.com/acme/orders/pull/21',
        state: 'open',
        draft: false,
        headBranch: 'b-studio/orders-s1',
        headSha: 'abc123',
        sessionId: 's1',
        checkStatus: 'success',
        reviewDecision: 'approved',
      },
    ]);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/orders/pulls?state=open&per_page=50');
    expect(calls[1]?.url).toBe('https://api.github.com/repos/acme/orders/commits/abc123/check-runs?per_page=100');
    expect(calls[2]?.url).toBe('https://api.github.com/repos/acme/orders/pulls/21/reviews?per_page=100');
  });

  it('b-studio가 만든 브랜치가 아니면 세션 id를 채우지 않는다', async () => {
    const { fn } = fakeFetch([
      { status: 200, body: [pull({ head: { ref: 'feature/manual', sha: 'def456' } })] },
      { status: 200, body: { check_runs: [] } },
      { status: 200, body: [] },
    ]);
    const pulls = await listPullRequests(parseRemote('git@github.com:acme/orders.git', {}), {
      env: { B_STUDIO_GITHUB_TOKEN: 't' },
      fetch: fn,
      branchSessionId: () => undefined,
    });
    expect(pulls[0]?.sessionId).toBeUndefined();
    expect(pulls[0]?.checkStatus).toBe('unknown');
    expect(pulls[0]?.reviewDecision).toBe('unknown');
  });

  it('체크가 진행 중이거나 실패했으면 pending·failure로, 변경 요청이 있으면 changes_requested로 판정한다', async () => {
    const pending = fakeFetch([
      { status: 200, body: [pull()] },
      { status: 200, body: { check_runs: [{ status: 'in_progress', conclusion: null }] } },
      { status: 200, body: [] },
    ]);
    const pendingResult = await listPullRequests(parseRemote('git@github.com:acme/orders.git', {}), { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: pending.fn });
    expect(pendingResult[0]?.checkStatus).toBe('pending');

    const failed = fakeFetch([
      { status: 200, body: [pull({ number: 22 })] },
      { status: 200, body: { check_runs: [{ status: 'completed', conclusion: 'failure' }] } },
      { status: 200, body: [{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-22T01:00:00Z' }] },
    ]);
    const failedResult = await listPullRequests(parseRemote('git@github.com:acme/orders.git', {}), { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: failed.fn });
    expect(failedResult[0]?.checkStatus).toBe('failure');
    expect(failedResult[0]?.reviewDecision).toBe('changes_requested');
  });

  it('Gitea는 CI·리뷰 정보를 채우지 않고(추가 요청 없이) 목록만 준다', async () => {
    const { fn, calls } = fakeFetch([
      {
        status: 200,
        body: [
          {
            number: 5,
            title: '기능 추가',
            user: { login: 'dev' },
            labels: [],
            updated_at: '2026-09-18T00:00:00Z',
            html_url: 'https://git.corp.local/dev/orders/pulls/5',
            state: 'open',
            draft: false,
            head: { ref: 'feature/x', sha: 'zzz' },
          },
        ],
      },
    ]);
    const pulls = await listPullRequests(parseRemote('https://git.corp.local/dev/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitea' }), { env: { B_STUDIO_GITEA_TOKEN: 't' }, fetch: fn });
    expect(pulls[0]?.checkStatus).toBeUndefined();
    expect(pulls[0]?.reviewDecision).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('토큰이 없거나 지원하지 않는 호스트면 요청하지 않는다', async () => {
    const none = fakeFetch([]);
    await expect(listPullRequests(parseRemote('git@github.com:acme/orders.git', {}), { env: {}, fetch: none.fn })).rejects.toThrow('B_STUDIO_GITHUB_TOKEN');
    await expect(listPullRequests(parseRemote('/Users/dev/orders', {}), { env: {}, fetch: none.fn })).rejects.toThrow(PullRequestError);
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

describe('parseTaskList', () => {
  it('체크리스트 항목의 총 개수와 완료 개수를 센다', () => {
    const body = ['할 일', '', '- [ ] 첫 번째', '- [x] 두 번째', '- [X] 세 번째(대문자)', '그냥 글', '- 체크박스 아닌 목록'].join('\n');
    expect(parseTaskList(body)).toEqual({
      total: 3,
      checked: 2,
      items: [
        { text: '첫 번째', checked: false },
        { text: '두 번째', checked: true },
        { text: '세 번째(대문자)', checked: true },
      ],
    });
  });

  it('체크리스트가 없거나 본문이 없으면 total 0을 돌려준다', () => {
    expect(parseTaskList(undefined)).toEqual({ total: 0, checked: 0, items: [] });
    expect(parseTaskList('그냥 글')).toEqual({ total: 0, checked: 0, items: [] });
  });
});

describe('parseClosingReferences', () => {
  it('close·fix·resolve 계열 문구에서 번호를 뽑고 중복을 없앤다', () => {
    expect(parseClosingReferences('Closes #12, fixes #7 그리고 Resolved: #12')).toEqual([12, 7]);
    expect(parseClosingReferences('closed #3')).toEqual([3]);
    expect(parseClosingReferences('그냥 #12 언급(닫는 문구 아님)')).toEqual([]);
    expect(parseClosingReferences(undefined)).toEqual([]);
  });
});

describe('fetchIssueDetail', () => {
  it('본문·담당자·최근 댓글·체크리스트·연결된 PR을 담는다', async () => {
    const { fn, calls } = fakeFetch([
      {
        status: 200,
        body: {
          number: 57,
          title: '주문 목록이 느립니다',
          body: '재현 방법\n\n- [ ] 인덱스 추가\n- [x] 쿼리 프로파일링',
          user: { login: 'yuna' },
          labels: [{ name: 'bug' }],
          updated_at: '2026-09-20T00:00:00Z',
          html_url: 'https://github.com/acme/orders/issues/57',
          state: 'open',
          assignees: [{ login: 'kim' }, { login: 'dev' }],
        },
      },
      { status: 200, body: [{ user: { login: 'kim' }, body: '진행 중입니다', created_at: '2026-09-20T01:00:00Z', html_url: 'https://github.com/acme/orders/issues/57#issuecomment-1' }] },
      {
        status: 200,
        body: [
          { number: 60, title: 'fixes #57', body: '', user: { login: 'yuna' }, labels: [], updated_at: '2026-09-21T00:00:00Z', html_url: 'https://github.com/acme/orders/pull/60', state: 'open', draft: false, head: { ref: 'fix/57', sha: 'a' } },
          { number: 61, title: '상관없는 PR', body: '', user: { login: 'yuna' }, labels: [], updated_at: '2026-09-21T00:00:00Z', html_url: 'https://github.com/acme/orders/pull/61', state: 'open', draft: false, head: { ref: 'other', sha: 'b' } },
        ],
      },
    ]);

    const issue = await fetchIssueDetail(parseRemote('git@github.com:acme/orders.git', {}), 57, { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: fn });

    expect(issue.assignees).toEqual(['kim', 'dev']);
    expect(issue.taskList).toEqual({ total: 2, checked: 1, items: [{ text: '인덱스 추가', checked: false }, { text: '쿼리 프로파일링', checked: true }] });
    expect(issue.comments).toEqual([{ author: 'kim', body: '진행 중입니다', createdAt: '2026-09-20T01:00:00Z', url: 'https://github.com/acme/orders/issues/57#issuecomment-1' }]);
    expect(issue.totalComments).toBe(1);
    expect(issue.commentsTruncated).toBe(false);
    expect(issue.linkedPulls).toEqual([{ number: 60, title: 'fixes #57', url: 'https://github.com/acme/orders/pull/60', state: 'open', draft: false }]);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/orders/issues/57');
    expect(calls[1]?.url).toBe('https://api.github.com/repos/acme/orders/issues/57/comments?per_page=100');
    expect(calls[2]?.url).toBe('https://api.github.com/repos/acme/orders/pulls?state=all&per_page=50');
  });

  it('댓글이 20개보다 많으면 최근 20개만 담고 truncated를 켠다', async () => {
    const many = Array.from({ length: 25 }, (_unused, index) => ({ user: { login: `u${index}` }, body: `댓글 ${index}`, created_at: `2026-09-${(index % 28) + 1}T00:00:00Z`, html_url: `#${index}` }));
    const { fn } = fakeFetch([
      { status: 200, body: { number: 1, title: '이슈', user: {}, labels: [], updated_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/acme/orders/issues/1', state: 'open' } },
      { status: 200, body: many },
      { status: 200, body: [] },
    ]);
    const issue = await fetchIssueDetail(parseRemote('git@github.com:acme/orders.git', {}), 1, { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: fn });
    expect(issue.comments).toHaveLength(20);
    expect(issue.comments[0]?.body).toBe('댓글 5');
    expect(issue.totalComments).toBe(25);
    expect(issue.commentsTruncated).toBe(true);
  });

  it('토큰이 없거나 지원하지 않는 호스트면 요청하지 않는다', async () => {
    const none = fakeFetch([]);
    await expect(fetchIssueDetail(parseRemote('git@github.com:acme/orders.git', {}), 1, { env: {}, fetch: none.fn })).rejects.toThrow('B_STUDIO_GITHUB_TOKEN');
    await expect(fetchIssueDetail(parseRemote('/Users/dev/orders', {}), 1, { env: {}, fetch: none.fn })).rejects.toThrow(PullRequestError);
    expect(none.calls).toHaveLength(0);
  });
});

describe('fetchPullRequestDetail', () => {
  it('GitHub는 파일·체크·리뷰·리뷰 댓글을 모두 담는다', async () => {
    const { fn, calls } = fakeFetch([
      {
        status: 200,
        body: {
          number: 21,
          title: '주문 목록 API',
          body: 'closes #10',
          user: { login: 'yuna' },
          labels: [{ name: 'feature' }],
          updated_at: '2026-09-22T00:00:00Z',
          html_url: 'https://github.com/acme/orders/pull/21',
          state: 'open',
          draft: false,
          head: { ref: 'b-studio/orders-s1', sha: 'abc123' },
          base: { ref: 'main' },
          mergeable: true,
          mergeable_state: 'clean',
        },
      },
      { status: 200, body: [{ user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-09-22T01:00:00Z' }] },
      { status: 200, body: { check_runs: [{ name: '빌드', status: 'completed', conclusion: 'success', html_url: 'https://ci/1', started_at: '2026-09-22T00:00:00Z', completed_at: '2026-09-22T00:05:00Z' }] } },
      { status: 200, body: [{ filename: 'src/orders.ts', status: 'modified', additions: 10, deletions: 2, patch: '@@ -1,2 +1,10 @@' }, { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 }] },
      { status: 200, body: [{ user: { login: 'reviewer' }, body: '여기 고쳐주세요', path: 'src/orders.ts', line: 5, html_url: 'https://github.com/acme/orders/pull/21#r1', created_at: '2026-09-22T01:00:00Z' }] },
    ]);

    const pull = await fetchPullRequestDetail(parseRemote('git@github.com:acme/orders.git', {}), 21, {
      env: { B_STUDIO_GITHUB_TOKEN: 't' },
      fetch: fn,
      branchSessionId: (branch) => (branch === 'b-studio/orders-s1' ? 's1' : undefined),
    });

    expect(pull.sessionId).toBe('s1');
    expect(pull.baseBranch).toBe('main');
    expect(pull.mergeable).toBe(true);
    expect(pull.mergeableState).toBe('clean');
    expect(pull.checkStatus).toBe('success');
    expect(pull.reviewDecision).toBe('approved');
    expect(pull.linkedIssues).toEqual([10]);
    expect(pull.filesSupported).toBe(true);
    expect(pull.files).toEqual([
      { path: 'src/orders.ts', status: 'modified', additions: 10, deletions: 2, patch: '@@ -1,2 +1,10 @@', binary: false, truncated: false },
      { path: 'logo.png', status: 'added', additions: 0, deletions: 0, patch: undefined, binary: true, truncated: false },
    ]);
    expect(pull.checksSupported).toBe(true);
    expect(pull.checkRuns).toEqual([{ name: '빌드', status: 'completed', conclusion: 'success', url: 'https://ci/1', durationMs: 300_000 }]);
    expect(pull.reviews).toEqual([{ author: 'reviewer', state: 'approved', submittedAt: '2026-09-22T01:00:00Z' }]);
    expect(pull.reviewCommentsSupported).toBe(true);
    expect(pull.reviewComments).toEqual([{ author: 'reviewer', body: '여기 고쳐주세요', path: 'src/orders.ts', line: 5, url: 'https://github.com/acme/orders/pull/21#r1', createdAt: '2026-09-22T01:00:00Z' }]);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/orders/pulls/21');
    expect(calls[1]?.url).toBe('https://api.github.com/repos/acme/orders/pulls/21/reviews?per_page=100');
    expect(calls[2]?.url).toBe('https://api.github.com/repos/acme/orders/commits/abc123/check-runs?per_page=100');
    expect(calls[3]?.url).toBe('https://api.github.com/repos/acme/orders/pulls/21/files?per_page=100');
    expect(calls[4]?.url).toBe('https://api.github.com/repos/acme/orders/pulls/21/comments?per_page=100');
  });

  it('파일 patch가 한도를 넘으면 자르고 truncated를 켠다', async () => {
    const bigPatch = '+'.repeat(25_000);
    const { fn } = fakeFetch([
      { status: 200, body: { number: 1, title: 'PR', body: '', user: {}, labels: [], updated_at: '2026-09-01T00:00:00Z', html_url: 'https://github.com/acme/orders/pull/1', state: 'open', draft: false, head: { ref: 'x', sha: 's' }, base: { ref: 'main' } } },
      { status: 200, body: [] },
      { status: 200, body: { check_runs: [] } },
      { status: 200, body: [{ filename: 'big.ts', status: 'modified', additions: 1, deletions: 1, patch: bigPatch }] },
      { status: 200, body: [] },
    ]);
    const pull = await fetchPullRequestDetail(parseRemote('git@github.com:acme/orders.git', {}), 1, { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: fn });
    expect(pull.files[0]?.truncated).toBe(true);
    expect(pull.files[0]?.patch?.length).toBeLessThan(bigPatch.length);
  });

  it('Gitea는 리뷰는 지원하지만 파일·체크·리뷰 댓글은 이유와 함께 지원하지 않는다', async () => {
    const { fn, calls } = fakeFetch([
      {
        status: 200,
        body: {
          number: 5,
          title: '기능 추가',
          body: '',
          user: { login: 'dev' },
          labels: [],
          updated_at: '2026-09-18T00:00:00Z',
          html_url: 'https://git.corp.local/dev/orders/pulls/5',
          state: 'open',
          draft: false,
          head: { ref: 'feature/x', sha: 'zzz' },
          base: { ref: 'main' },
        },
      },
      { status: 200, body: [{ user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-09-18T01:00:00Z' }] },
    ]);
    const pull = await fetchPullRequestDetail(parseRemote('https://git.corp.local/dev/orders.git', { B_STUDIO_GIT_PROVIDER: 'gitea' }), 5, { env: { B_STUDIO_GITEA_TOKEN: 't' }, fetch: fn });

    expect(pull.checkStatus).toBeUndefined();
    expect(pull.reviewDecision).toBeUndefined();
    expect(pull.reviews).toEqual([{ author: 'reviewer', state: 'approved', submittedAt: '2026-09-18T01:00:00Z' }]);
    expect(pull.filesSupported).toBe(false);
    expect(pull.filesUnsupportedReason).toContain('지원하지 않습니다');
    expect(pull.checksSupported).toBe(false);
    expect(pull.reviewCommentsSupported).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('토큰이 없거나 지원하지 않는 호스트면 요청하지 않는다', async () => {
    const none = fakeFetch([]);
    await expect(fetchPullRequestDetail(parseRemote('git@github.com:acme/orders.git', {}), 1, { env: {}, fetch: none.fn })).rejects.toThrow('B_STUDIO_GITHUB_TOKEN');
    await expect(fetchPullRequestDetail(parseRemote('/Users/dev/orders', {}), 1, { env: {}, fetch: none.fn })).rejects.toThrow(PullRequestError);
    expect(none.calls).toHaveLength(0);
  });
});

const github = parseRemote('git@github.com:acme/orders.git', {});

describe('updateIssue', () => {
  it('본문·라벨·상태를 PATCH로 고친다', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: {} }]);
    await updateIssue(github, 42, { body: '새 본문', labels: ['b-studio:req'], state: 'closed' }, { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: fn });
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/orders/issues/42',
      method: 'PATCH',
      body: { body: '새 본문', labels: ['b-studio:req'], state: 'closed' },
    });
  });

  it('거절되면 PullRequestError를 던진다', async () => {
    const { fn } = fakeFetch([{ status: 404, body: { message: 'Not Found' } }]);
    await expect(updateIssue(github, 42, { body: 'x' }, { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: fn })).rejects.toThrow(PullRequestError);
  });
});

describe('listIssueComments · updateComment', () => {
  it('댓글 목록을 읽고 하나를 고친다', async () => {
    const list = fakeFetch([{ status: 200, body: [{ id: 1, body: '첫 댓글', html_url: 'https://github.com/acme/orders/issues/1#issuecomment-1' }] }]);
    const comments = await listIssueComments(github, 1, { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: list.fn });
    expect(comments).toEqual([{ id: 1, body: '첫 댓글', url: 'https://github.com/acme/orders/issues/1#issuecomment-1' }]);
    expect(list.calls[0]!.url).toBe('https://api.github.com/repos/acme/orders/issues/1/comments?per_page=100');

    const update = fakeFetch([{ status: 200, body: {} }]);
    await updateComment(github, 1, '갱신된 상태', { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: update.fn });
    expect(update.calls[0]).toMatchObject({ url: 'https://api.github.com/repos/acme/orders/issues/comments/1', method: 'PATCH', body: { body: '갱신된 상태' } });
  });
});

describe('listLabels · createLabel · ensureLabels', () => {
  it('없는 라벨만 만든다', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: [{ name: 'bug' }, { name: 'b-studio:req' }] }, { status: 201, body: { name: 'kind:api' } }]);
    await ensureLabels(github, ['b-studio:req', 'kind:api'], { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: fn });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/repos/acme/orders/labels?per_page=100', method: 'GET' });
    expect(calls[1]).toMatchObject({ url: 'https://api.github.com/repos/acme/orders/labels', method: 'POST', body: { name: 'kind:api' } });
  });

  it('이미 있는 라벨(422)은 조용히 넘어간다', async () => {
    const { fn } = fakeFetch([{ status: 422, body: { message: 'already_exists' } }]);
    await expect(createLabel(github, 'b-studio:req', { env: { B_STUDIO_GITHUB_TOKEN: 't' }, fetch: fn })).resolves.toBeUndefined();
  });
});
