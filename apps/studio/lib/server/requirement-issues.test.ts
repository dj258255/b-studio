import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  createIssue: vi.fn<(...args: unknown[]) => Promise<{ number: number; url: string }>>(),
  updateIssue: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  addSubIssue: vi.fn<(...args: unknown[]) => Promise<{ supported: boolean }>>(async () => ({ supported: true })),
  listIssues: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
  listIssueComments: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
  updateComment: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  postComment: vi.fn<(...args: unknown[]) => Promise<{ url?: string }>>(async () => ({})),
  ensureLabels: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return {
    ...actual,
    createIssue: spies.createIssue,
    updateIssue: spies.updateIssue,
    addSubIssue: spies.addSubIssue,
    listIssues: spies.listIssues,
    listIssueComments: spies.listIssueComments,
    updateComment: spies.updateComment,
    postComment: spies.postComment,
    ensureLabels: spies.ensureLabels,
  };
});

import { parseRemote, type Requirement } from '@b-studio/agent';
import {
  planRequirementIssuePublish,
  publishedTrackingIssue,
  publishRequirementIssues,
  refreshTrackingIssueBody,
  resolveRequirementConflict,
  syncRequirementIssueStatus,
  type RequirementIssuesContext,
} from './requirement-issues';

const remote = parseRemote('git@github.com:acme/orders.git', {});

function req(overrides: Partial<Requirement> = {}): Requirement {
  return { id: 'R1', title: '로그인 API', kind: 'api', priority: 'must', acceptance: ['이메일·비밀번호로 로그인한다'], ...overrides };
}

let root: string;
let ctx: RequirementIssuesContext;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-req-issues-'));
  ctx = { root, remote, token: 'ghp_test', projectName: 'orders' };
  spies.createIssue.mockReset().mockResolvedValue({ number: 100, url: 'https://github.com/acme/orders/issues/100' });
  spies.updateIssue.mockReset().mockResolvedValue(undefined);
  spies.addSubIssue.mockReset().mockResolvedValue({ supported: true });
  spies.listIssues.mockReset().mockResolvedValue([]);
  spies.listIssueComments.mockReset().mockResolvedValue([]);
  spies.updateComment.mockReset().mockResolvedValue(undefined);
  spies.postComment.mockReset().mockResolvedValue({});
  spies.ensureLabels.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('planRequirementIssuePublish', () => {
  it('처음 보는 요구사항은 create로 계획한다(아직 아무것도 쓰지 않는다)', async () => {
    const { plan, summary } = await planRequirementIssuePublish(ctx, [req()], { R1: '미착수' });
    expect(plan).toEqual([expect.objectContaining({ id: 'R1', action: 'create' })]);
    expect(summary.create).toBe(1);
    expect(spies.createIssue).not.toHaveBeenCalled();
    expect(spies.updateIssue).not.toHaveBeenCalled();
  });

  it('미리보기가 대상 저장소와 추적 이슈 처리(새로 만들기/갱신)를 함께 알려준다', async () => {
    const fresh = await planRequirementIssuePublish(ctx, [req()], { R1: '미착수' });
    expect(fresh.repository).toBe('github.com/acme/orders');
    expect(fresh.tracking).toEqual({ action: 'create' });

    // 다른 세션에서 이미 발행한 추적 이슈가 저장소에 있으면(이 세션엔 발행 기록이 없어도) 갱신으로 본다
    spies.listIssues.mockResolvedValue([{ number: 19, title: '요구사항: orders', state: 'open', labels: ['b-studio:req'], body: '표' }]);
    const existing = await planRequirementIssuePublish(ctx, [req()], { R1: '미착수' });
    expect(existing.tracking).toEqual({ action: 'update', issue: 19 });
  });
});

describe('publishRequirementIssues', () => {
  it('하위 이슈와 추적 이슈를 만들고, GitHub이면 서로 연결하고, 발행 기록을 사이드카 파일에 남긴다(재발행하면 unchanged가 된다)', async () => {
    spies.createIssue
      .mockResolvedValueOnce({ number: 201, url: 'https://github.com/acme/orders/issues/201' }) // 하위 이슈
      .mockResolvedValueOnce({ number: 1, url: 'https://github.com/acme/orders/issues/1' }); // 추적 이슈

    const result = await publishRequirementIssues(ctx, [req()], { R1: '작업 중' });

    expect(result.errors).toEqual([]);
    expect(result.tracking).toEqual({ issue: 1, url: 'https://github.com/acme/orders/issues/1' });
    expect(spies.ensureLabels).toHaveBeenCalledOnce();
    expect(spies.createIssue).toHaveBeenCalledTimes(2);
    expect(spies.createIssue.mock.calls[0]![1]).toMatchObject({ title: '[R1] 로그인 API' });
    expect(spies.addSubIssue).toHaveBeenCalledWith(remote, 1, 201, expect.anything());

    // 재발행: 원격 이슈 목록이 이제 그 하위 이슈를 돌려준다고 가정하면(아직 아무도 고치지 않았으므로) unchanged다
    const subIssueBody = (spies.createIssue.mock.calls[0]![1] as { body: string }).body;
    spies.listIssues.mockResolvedValue([{ number: 201, state: 'open', labels: ['b-studio:req'], body: subIssueBody }]);

    const { plan } = await planRequirementIssuePublish(ctx, [req()], { R1: '작업 중' });
    expect(plan[0]).toMatchObject({ action: 'unchanged', issue: 201 });
  });

  it('하위 이슈 연결이 실패해도 나머지는 계속 진행하고 오류만 남긴다', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 300, url: 'x' }).mockResolvedValueOnce({ number: 2, url: 'y' });
    spies.addSubIssue.mockRejectedValueOnce(new Error('연결 실패'));

    const result = await publishRequirementIssues(ctx, [req()], { R1: '미착수' });
    expect(result.tracking).toEqual({ issue: 2, url: 'y' });
    expect(result.errors).toEqual([{ id: 'R1', message: expect.stringContaining('연결 실패') }]);
  });

  it('발행 기록이 없는 세션이어도 저장소의 기존 추적 이슈를 이어 써서 중복으로 만들지 않는다', async () => {
    spies.listIssues.mockResolvedValue([{ number: 19, title: '요구사항: orders', state: 'open', labels: ['b-studio:req'], body: '옛 표', url: 'https://github.com/acme/orders/issues/19' }]);
    spies.createIssue.mockResolvedValueOnce({ number: 201, url: 'https://github.com/acme/orders/issues/201' }); // 하위 이슈만

    const result = await publishRequirementIssues(ctx, [req()], { R1: '미착수' });

    expect(spies.createIssue).toHaveBeenCalledTimes(1);
    expect(spies.createIssue.mock.calls[0]![1]).toMatchObject({ title: '[R1] 로그인 API' });
    expect(spies.updateIssue).toHaveBeenCalledWith(remote, 19, expect.objectContaining({ labels: ['b-studio:req'] }), expect.anything());
    expect(result.tracking).toEqual({ issue: 19, url: 'https://github.com/acme/orders/issues/19' });
    expect(spies.addSubIssue).toHaveBeenCalledWith(remote, 19, 201, expect.anything());
  });

  it('could 우선순위는 하위 이슈를 만들지 않고 추적 이슈 체크리스트에만 넣는다', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 5, url: 'y' }); // 추적 이슈만
    const result = await publishRequirementIssues(ctx, [req({ priority: 'could' })], { R1: '미착수' });
    expect(spies.createIssue).toHaveBeenCalledTimes(1);
    expect(spies.createIssue.mock.calls[0]![1]).toMatchObject({ title: '요구사항: orders' });
    expect(result.tracking).toEqual({ issue: 5, url: 'y' });
  });

  it('이슈 헤더의 rev=는 발행 횟수가 아니라 파일의 개정 번호를 그대로 쓴다(버그 리포트 47 — 발행 2번째라고 rev=2가 되지 않는다)', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 201, url: 'x' }).mockResolvedValueOnce({ number: 1, url: 'y' });
    await publishRequirementIssues(ctx, [req({ rev: 4 })], { R1: '작업 중' });
    const body = (spies.createIssue.mock.calls[0]![1] as { body: string }).body;
    expect(body).toContain('rev=4');
  });

  it('다시 발행해도(두 번째 발행) rev=는 1씩 늘지 않고 파일의 지금 개정 번호를 그대로 따라간다', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 201, url: 'x1' }).mockResolvedValueOnce({ number: 1, url: 'y1' });
    await publishRequirementIssues(ctx, [req({ rev: 4 })], { R1: '작업 중' });
    const firstBody = (spies.createIssue.mock.calls[0]![1] as { body: string }).body;
    expect(firstBody).toContain('rev=4');

    // 원격에 그 하위 이슈가 있다고 보이게 하고, 파일 쪽은 내용이 바뀌어(인수 조건 추가) 개정이 7로 올랐다고 가정한다
    spies.listIssues.mockResolvedValue([{ number: 201, state: 'open', labels: ['b-studio:req'], body: firstBody }]);
    await publishRequirementIssues(ctx, [req({ rev: 7, acceptance: ['이메일·비밀번호로 로그인한다', '2단계 인증을 지원한다'] })], { R1: '작업 중' });

    // 발행은 이번이 두 번째지만(옛 방식이면 record.rev+1=5), 헤더는 파일의 지금 개정 번호(7)를 그대로 쓴다
    const updatedBody = (spies.updateIssue.mock.calls[0]![2] as { body: string }).body;
    expect(updatedBody).toContain('rev=7');
    expect(updatedBody).not.toContain('rev=5');
  });
});

describe('refreshTrackingIssueBody(PR을 만들 때 추적 이슈 본문을 지금 상태로 다시 쓴다)', () => {
  it('한 번도 "이슈로 발행"을 한 적이 없으면(추적 이슈가 없으면) 아무것도 쓰지 않는다', async () => {
    const result = await refreshTrackingIssueBody(ctx, [req()], { R1: '검증됨' });
    expect(result).toEqual({ updated: false });
    expect(spies.updateIssue).not.toHaveBeenCalled();
  });

  it('발행한 뒤에는 추적 이슈 본문 표를 지금 요구사항 상태로 다시 쓴다', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 10, url: 'https://github.com/acme/orders/issues/10' }).mockResolvedValueOnce({ number: 1, url: 'https://github.com/acme/orders/issues/1' });
    await publishRequirementIssues(ctx, [req()], { R1: '미착수' }); // 발행 당시에는 "미착수"였다

    spies.updateIssue.mockClear();
    const result = await refreshTrackingIssueBody(ctx, [req()], { R1: '검증됨' }); // PR을 만들 때는 "검증됨"

    expect(result).toEqual({ updated: true, issue: 1 });
    expect(spies.updateIssue).toHaveBeenCalledOnce();
    const [remoteArg, issueNumber, input] = spies.updateIssue.mock.calls[0]!;
    expect(remoteArg).toBe(remote);
    expect(issueNumber).toBe(1);
    expect((input as { body: string }).body).toContain('검증됨');
    expect((input as { body: string }).body).toContain('#10'); // 하위 이슈 링크도 그대로 들어간다
  });

  it('추적 이슈가 닫혀 있어도 본문만 고치고 다시 열지 않는다(state를 주지 않는다)', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 10, url: 'https://github.com/acme/orders/issues/10' }).mockResolvedValueOnce({ number: 1, url: 'https://github.com/acme/orders/issues/1' });
    await publishRequirementIssues(ctx, [req()], { R1: '검증됨' });

    spies.updateIssue.mockClear();
    await refreshTrackingIssueBody(ctx, [req()], { R1: '검증됨' });

    const input = spies.updateIssue.mock.calls[0]![2] as Record<string, unknown>;
    expect(input).not.toHaveProperty('state');
  });

  it('본문 첫 줄이 "주기적으로 갱신"이 아니라 발행·PR 만들기 때 갱신한다는 사실과 마지막 갱신 시각을 말한다', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 10, url: 'a' }).mockResolvedValueOnce({ number: 1, url: 'b' });
    await publishRequirementIssues(ctx, [req()], { R1: '미착수' });

    spies.updateIssue.mockClear();
    await refreshTrackingIssueBody(ctx, [req()], { R1: '검증됨' });

    const body = (spies.updateIssue.mock.calls[0]![2] as { body: string }).body;
    expect(body).not.toContain('주기적으로');
    expect(body).toContain('이슈를 발행하거나 PR을 만들 때 상태를 다시 씁니다');
    expect(body).toMatch(/마지막 갱신: \d{4}-\d{2}-\d{2}T/);
  });
});

describe('publishedTrackingIssue(56번 버그: PR 본문에서 추적 이슈를 가리킨다)', () => {
  it('발행하지 않았으면 undefined다', async () => {
    expect(await publishedTrackingIssue(root)).toBeUndefined();
  });

  it('발행한 뒤에는 사이드카에 남긴 추적 이슈를 돌려준다', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 201, url: 'https://github.com/acme/orders/issues/201' }).mockResolvedValueOnce({ number: 1, url: 'https://github.com/acme/orders/issues/1' });
    await publishRequirementIssues(ctx, [req()], { R1: '작업 중' });

    expect(await publishedTrackingIssue(root)).toEqual({ issue: 1, url: 'https://github.com/acme/orders/issues/1' });
  });
});

describe('resolveRequirementConflict', () => {
  async function publishOne() {
    spies.createIssue.mockResolvedValueOnce({ number: 10, url: 'a' }).mockResolvedValueOnce({ number: 1, url: 'b' });
    await publishRequirementIssues(ctx, [req()], { R1: '작업 중' });
    return (spies.createIssue.mock.calls[0]![1] as { body: string }).body;
  }

  it('덮어쓰기는 로컬 내용으로 이슈를 다시 쓰고 발행 기록을 갱신한다', async () => {
    const originalBody = await publishOne();
    spies.listIssues.mockResolvedValue([{ number: 10, state: 'open', labels: ['b-studio:req'], body: originalBody.replace('이메일·비밀번호로 로그인한다', '고쳐진 내용') }]);

    const result = await resolveRequirementConflict(ctx, req(), '작업 중', 'overwrite');
    expect(result).toEqual({ action: 'overwrite' });
    expect(spies.updateIssue).toHaveBeenCalledWith(remote, 10, expect.objectContaining({ body: expect.stringContaining('이메일·비밀번호로 로그인한다') }), expect.anything());
  });

  it('덮어쓰기도 이슈 헤더의 rev=를 파일의 개정 번호로 쓴다(버그 리포트 47 — record.rev+1이 아니다)', async () => {
    const originalBody = await publishOne(); // req()는 rev가 없으니 1로 발행됐다
    expect(originalBody).toContain('rev=1');
    spies.listIssues.mockResolvedValue([{ number: 10, state: 'open', labels: ['b-studio:req'], body: originalBody.replace('이메일·비밀번호로 로그인한다', '고쳐진 내용') }]);

    // 파일은 그동안 개정 9까지 올랐다(이 충돌 해결과 무관하게) — 덮어쓰면 그 번호를 그대로 써야 한다(옛 방식이면 record.rev+1=2)
    await resolveRequirementConflict(ctx, req({ rev: 9 }), '작업 중', 'overwrite');
    const rewrittenBody = (spies.updateIssue.mock.calls[0]![2] as { body: string }).body;
    expect(rewrittenBody).toContain('rev=9');
    expect(rewrittenBody).not.toContain('rev=2');
  });

  it('무시는 아무것도 쓰지 않고 원격을 새 기준선으로 받아들인다(다음 계획은 update로 본다)', async () => {
    const originalBody = await publishOne();
    const editedBody = originalBody.replace('이메일·비밀번호로 로그인한다', '고쳐진 내용');
    spies.listIssues.mockResolvedValue([{ number: 10, state: 'open', labels: ['b-studio:req'], body: editedBody }]);

    const result = await resolveRequirementConflict(ctx, req(), '작업 중', 'ignore');
    expect(result).toEqual({ action: 'ignore' });
    expect(spies.updateIssue).not.toHaveBeenCalledWith(remote, 10, expect.anything(), expect.anything());

    const { plan } = await planRequirementIssuePublish(ctx, [req()], { R1: '작업 중' });
    expect(plan[0]!.action).toBe('update'); // 로컬 내용은 그대로인데 기준선이 편집된 내용으로 바뀌었으니 다시 맞춰야 한다
  });

  it('가져오기는 이슈 본문을 요구사항 초안으로 파싱해 돌려준다', async () => {
    const originalBody = await publishOne();
    const editedBody = originalBody.replace('이메일·비밀번호로 로그인한다', '소셜 로그인을 지원한다');
    spies.listIssues.mockResolvedValue([{ number: 10, state: 'open', labels: ['b-studio:req'], body: editedBody }]);

    const result = await resolveRequirementConflict(ctx, req(), '작업 중', 'import');
    expect(result.action).toBe('import');
    expect(result.draft?.acceptance).toContain('소셜 로그인을 지원한다');
  });

  it('아직 발행되지 않은 요구사항은 오류를 던진다', async () => {
    await expect(resolveRequirementConflict(ctx, req({ id: 'R9' }), '미착수', 'ignore')).rejects.toThrow('R9');
  });
});

describe('syncRequirementIssueStatus', () => {
  it('고정 댓글이 없으면 새로 달고, 있으면 편집만 한다(새 댓글을 남기지 않는다)', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 10, url: 'a' }).mockResolvedValueOnce({ number: 1, url: 'b' });
    await publishRequirementIssues(ctx, [req()], { R1: '작업 중' });

    const evidence = { id: 'R1', kind: 'api', priority: 'must', status: '검증됨' as const, checkpoints: [{ shortSha: 'abc1234' }], tests: [{ file: 'a.test.ts', name: 'it R1 로그인' }], gateChecks: [{ name: 'test', ok: true }] };

    spies.listIssueComments.mockResolvedValueOnce([]);
    const first = await syncRequirementIssueStatus(ctx, [evidence]);
    expect(first.updated).toEqual(['R1']);
    expect(spies.postComment).toHaveBeenCalledOnce();
    const posted = spies.postComment.mock.calls[0]![2] as string;
    expect(posted).toContain('it R1 로그인');

    spies.listIssueComments.mockResolvedValueOnce([{ id: 55, body: posted }]);
    const second = await syncRequirementIssueStatus(ctx, [evidence]);
    expect(second.updated).toEqual(['R1']);
    expect(spies.updateComment).not.toHaveBeenCalled(); // 내용이 그대로면 편집도 하지 않는다
    expect(spies.postComment).toHaveBeenCalledOnce(); // 여전히 처음 한 번만
  });

  it('prMerged면 검증됨 요구사항의 이슈를 닫는다', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 10, url: 'a' }).mockResolvedValueOnce({ number: 1, url: 'b' });
    await publishRequirementIssues(ctx, [req()], { R1: '검증됨' });

    const evidence = { id: 'R1', kind: 'api', priority: 'must', status: '검증됨' as const, checkpoints: [], tests: [], gateChecks: [] };
    await syncRequirementIssueStatus(ctx, [evidence], { prMerged: true });
    expect(spies.updateIssue).toHaveBeenCalledWith(remote, 10, { state: 'closed' }, expect.anything());
  });

  it('prMerged가 아니면 닫지 않는다', async () => {
    spies.createIssue.mockResolvedValueOnce({ number: 10, url: 'a' }).mockResolvedValueOnce({ number: 1, url: 'b' });
    await publishRequirementIssues(ctx, [req()], { R1: '검증됨' });
    spies.updateIssue.mockClear();

    const evidence = { id: 'R1', kind: 'api', priority: 'must', status: '검증됨' as const, checkpoints: [], tests: [], gateChecks: [] };
    await syncRequirementIssueStatus(ctx, [evidence]);
    expect(spies.updateIssue).not.toHaveBeenCalledWith(remote, 10, { state: 'closed' }, expect.anything());
  });

  it('발행되지 않은 요구사항은 건너뛴다', async () => {
    const evidence = { id: 'R9', kind: 'api', priority: 'must', status: '미착수' as const, checkpoints: [], tests: [], gateChecks: [] };
    const result = await syncRequirementIssueStatus(ctx, [evidence]);
    expect(result).toEqual({ updated: [], errors: [] });
  });
});
