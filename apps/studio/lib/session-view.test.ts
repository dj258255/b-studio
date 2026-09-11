import type { VerificationReport } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { activeRun, createView, latestWrite, LOG_LIMIT, reduceSession, type SessionView } from './session-view';
import type { SessionSnapshot, StudioEvent } from './studio-events';

const snapshot: SessionSnapshot = {
  id: 's1',
  projectId: 'orders',
  projectName: 'orders',
  workDir: '/tmp/orders-s1',
  status: 'starting',
  mode: 'demo',
  running: false,
  checkpoints: [],
  services: [
    { name: 'web', template: 'nextjs', preview: 'browser', state: 'starting', hasContract: false },
    { name: 'api', template: 'spring-boot', preview: 'openapi', state: 'starting', hasContract: true },
  ],
};

const report = { ok: true, sync: { elapsedMs: 700 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [] } satisfies VerificationReport;

function fold(events: StudioEvent[], start: SessionView = createView(snapshot)): SessionView {
  return events.reduce(reduceSession, start);
}

describe('reduceSession', () => {
  it('재시작으로 바뀐 서비스 주소를 반영한다', () => {
    const view = fold([
      { type: 'service', service: 'api', state: 'ready', url: 'http://127.0.0.1:32769' },
      { type: 'service', service: 'api', state: 'probing', detail: 'TIMEOUT' },
      { type: 'service', service: 'api', state: 'ready', url: 'http://127.0.0.1:32801' },
    ]);
    expect(view.snapshot.services[1]).toMatchObject({ state: 'ready', url: 'http://127.0.0.1:32801' });
  });

  it('로컬 폴더에서 바꾼 파일을 남긴 체크포인트는 기록을 다시 재생해도 한 번만 쌓는다', () => {
    const saved = { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', message: '직접 수정: 파일 1개', createdAt: '2026-09-11T00:00:00Z', files: ['NOTE.md'] };
    const event: StudioEvent = { type: 'local_edits_saved', checkpoint: saved, reason: 'request' };

    const view = fold([event]);
    expect(view.snapshot.checkpoints).toEqual([saved]);
    expect(view.chat).toEqual([{ kind: 'localEdits', checkpoint: saved, reason: 'request' }]);
    expect(fold([event], createView({ ...snapshot, checkpoints: [saved] })).snapshot.checkpoints).toEqual([saved]);
  });

  it('중지된 서비스는 이전 주소를 지워 사라진 미리보기를 띄우지 않는다', () => {
    const view = fold([
      { type: 'service', service: 'web', state: 'ready', url: 'http://127.0.0.1:32769' },
      { type: 'service', service: 'web', state: 'stopped' },
    ]);
    expect(view.snapshot.services[0]).toMatchObject({ state: 'stopped', url: undefined });
  });

  it('연속된 도구 호출을 한 묶음으로 모으고 결과를 순서대로 붙인다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '메모 필드 추가' },
      { type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'write_file', input: { path: 'api/V2.sql' } } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'edit_file', input: { path: 'api/Order.java' } } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_result', name: 'write_file', ok: true, content: 'wrote api/V2.sql' } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_result', name: 'edit_file', ok: false, content: '찾지 못했습니다' } },
    ]);

    expect(view.snapshot.running).toBe(true);
    expect(view.chat.map((item) => item.kind)).toEqual(['request', 'tools']);
    expect(view.chat[1]).toMatchObject({
      calls: [
        { summary: '작성 api/V2.sql', ok: true },
        { summary: '수정 api/Order.java', ok: false, output: '찾지 못했습니다' },
      ],
    });
  });

  it('코드 화면이 따라갈 수 있게 성공한 쓰기 도구의 경로와 횟수를 모은다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '메모' },
      { type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'read_file', input: { path: 'api/Order.java' } } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_result', name: 'read_file', ok: true, content: '...' } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'write_file', input: { path: './api/V2.sql' } } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_result', name: 'write_file', ok: true, content: 'wrote' } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'edit_file', input: { path: 'web/page.tsx' } } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_result', name: 'edit_file', ok: false, content: '찾지 못했습니다' } },
    ]);
    expect(latestWrite(view.chat)).toEqual({ path: 'api/V2.sql', count: 1 });
  });

  it('실행 환경을 알리는 이벤트는 대화에 한 줄로 남긴다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '주문 수 API 추가' },
      { type: 'agent', runId: 'r1', event: { type: 'session', backend: '로컬 Claude Agent (CLI 2.1.267)', model: 'claude-opus-5', auth: 'Claude Max 구독' } },
    ]);
    expect(view.chat.at(-1)).toEqual({
      kind: 'backend',
      runId: 'r1',
      backend: '로컬 Claude Agent (CLI 2.1.267)',
      model: 'claude-opus-5',
      auth: 'Claude Max 구독',
    });
  });

  it('검증 게이트는 확인 중으로 나타났다가 결과로 채워진다', () => {
    const pending = fold([{ type: 'agent', runId: 'r1', event: { type: 'verify_start', files: ['api/Order.java'] } }]);
    expect(pending.chat).toEqual([{ kind: 'gate', runId: 'r1', files: ['api/Order.java'] }]);

    const done = fold([{ type: 'agent', runId: 'r1', event: { type: 'verify_result', report, text: '검증 통과' } }], pending);
    expect(done.chat).toEqual([{ kind: 'gate', runId: 'r1', files: ['api/Order.java'], report }]);
  });

  it('요청이 끝났는데 결과가 오지 않은 게이트와 도구 호출은 중단으로 표시한다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '메모 필드 추가' },
      { type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'write_file', input: { path: 'api/V2.sql' } } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_result', name: 'write_file', ok: true, content: 'wrote' } },
      { type: 'agent', runId: 'r1', event: { type: 'tool_call', name: 'restart_service', input: { service: 'api' } } },
      { type: 'agent', runId: 'r1', event: { type: 'verify_start', files: ['api/V2.sql'] } },
      { type: 'run_finished', runId: 'r1', status: 'error', summary: '스튜디오 서버가 멈춰 끝내지 못했습니다' },
    ]);

    expect(view.chat).toMatchObject([
      { kind: 'request' },
      { kind: 'tools', calls: [{ ok: true }, { interrupted: true }] },
      { kind: 'gate', interrupted: true },
      { kind: 'outcome', status: 'error' },
    ]);
    expect((view.chat[1] as { calls: Array<{ interrupted?: boolean }> }).calls[0]?.interrupted).toBeUndefined();
  });

  it('요청이 끝나면 실행 중 표시를 끄고 다음 데모 요청을 갱신한다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '주문 목록 API와 화면을 만들어줘' },
      { type: 'run_finished', runId: 'r1', status: 'done', summary: '완료', turns: 4, nextDemoRequest: '주문에 배송 메모 필드 추가해줘' },
    ]);
    expect(view.snapshot).toMatchObject({ running: false, nextDemoRequest: '주문에 배송 메모 필드 추가해줘' });
    expect(view.completedRuns).toBe(1);
  });

  it('요청 취소는 취소 중으로 표시했다가 되돌린 결과와 그때까지 쓴 토큰으로 끝낸다', () => {
    const usage = { inputTokens: 1_200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const running = fold([
      { type: 'snapshot', snapshot: { ...snapshot, status: 'ready' } },
      { type: 'run_started', runId: 'r1', request: '메모 필드 추가' },
      { type: 'agent', runId: 'r1', event: { type: 'verify_start', files: ['api/V2.sql'] } },
      { type: 'tokens', runId: 'r1', usage, sessionTokens: usage },
      { type: 'run_cancelling', runId: 'r1' },
    ]);
    expect(activeRun(running)).toBe('r1');
    expect(running.snapshot).toMatchObject({ running: true, cancelling: 'user', tokens: usage });
    expect(running.runTokens).toEqual({ runId: 'r1', usage });

    const done = fold(
      [
        { type: 'reverted', runId: 'r1', cancelled: true, files: ['api/V2.sql'], patch: '', restarted: [{ service: 'api', ready: true }], databases: [] },
        { type: 'run_finished', runId: 'r1', status: 'cancelled', summary: '요청을 취소하고 바뀐 파일 1개를 되돌렸습니다', usage, sessionTokens: usage },
      ],
      running,
    );
    expect(activeRun(done)).toBeUndefined();
    expect(done.snapshot.cancelling).toBeUndefined();
    expect(done.snapshot.tokens).toEqual(usage);
    expect(done.runTokens).toBeUndefined();
    expect(done.chat).toMatchObject([
      { kind: 'request' },
      { kind: 'gate', interrupted: true },
      { kind: 'reverted', cancelled: true },
      { kind: 'outcome', status: 'cancelled', usage },
    ]);
  });

  it('세션 토큰 한도에 도달해 멈추는 요청은 멈춘 이유를 함께 표시한다', () => {
    const stopping = fold([
      { type: 'run_started', runId: 'r1', request: '메모 필드 추가' },
      { type: 'run_cancelling', runId: 'r1', reason: 'budget' },
    ]);
    expect(stopping.snapshot.cancelling).toBe('budget');

    const done = fold([{ type: 'run_finished', runId: 'r1', status: 'cancelled', summary: '세션 토큰 한도(2만)에 도달해 요청을 멈췄습니다. 바뀐 파일은 없었습니다' }], stopping);
    expect(done.snapshot.cancelling).toBeUndefined();
    expect(done.chat.at(-1)).toMatchObject({ kind: 'outcome', status: 'cancelled' });
  });

  it('체크포인트 복원 중에는 취소할 요청이 없다', () => {
    const first = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: '세션 시작', createdAt: '', files: [] };
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '메모' },
      { type: 'run_finished', runId: 'r1', status: 'done', summary: '완료' },
      { type: 'restore_started', checkpoint: first },
    ]);
    expect(view.snapshot.running).toBe(true);
    expect(activeRun(view)).toBeUndefined();
  });

  it('다시 연결해 기록을 재생해도 세션 토큰 합계를 두 번 더하지 않는다', () => {
    const tokens = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const history: StudioEvent[] = [
      { type: 'run_started', runId: 'r1', request: '첫 요청' },
      { type: 'tokens', runId: 'r1', usage: tokens(100), sessionTokens: tokens(100) },
      { type: 'run_finished', runId: 'r1', status: 'done', summary: '완료', usage: tokens(100), sessionTokens: tokens(100) },
      { type: 'run_started', runId: 'r2', request: '두 번째 요청' },
      { type: 'tokens', runId: 'r2', usage: tokens(200), sessionTokens: tokens(300) },
      { type: 'run_finished', runId: 'r2', status: 'failed', summary: '실패', usage: tokens(200), sessionTokens: tokens(300) },
    ];
    const view = fold([{ type: 'snapshot', snapshot: { ...snapshot, tokens: tokens(300) } }, ...history]);
    expect(view.snapshot.tokens).toEqual(tokens(300));
    expect(view.chat.filter((item) => item.kind === 'outcome').map((item) => item.kind === 'outcome' && item.usage?.inputTokens)).toEqual([100, 200]);
  });

  it('다시 연결되면 snapshot에서 초기화해 기록이 중복되지 않는다', () => {
    const history: StudioEvent[] = [{ type: 'run_started', runId: 'r1', request: '요청' }];
    const once = fold([{ type: 'snapshot', snapshot }, ...history]);
    const twice = fold([{ type: 'snapshot', snapshot }, ...history], once);
    expect(twice.chat).toHaveLength(1);
  });

  it('체크포인트를 최신순으로 쌓고 대화에 남긴다', () => {
    const first = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: '세션 시작', createdAt: '', files: [] };
    const second = { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', message: '요청: 메모', createdAt: '', files: ['api/Order.java'] };
    const view = fold([
      { type: 'snapshot', snapshot: { ...snapshot, checkpoints: [first] } },
      { type: 'checkpoint', runId: 'r1', checkpoint: second },
    ]);
    expect(view.snapshot.checkpoints.map((c) => c.shortSha)).toEqual(['bbbbbbb', 'aaaaaaa']);
    expect(view.chat).toEqual([{ kind: 'checkpoint', runId: 'r1', checkpoint: second }]);
  });

  it('다시 연결해 기록을 재생해도 스냅샷에 이미 있는 체크포인트를 중복으로 쌓지 않는다', () => {
    const first = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: '세션 시작', createdAt: '', files: [] };
    const second = { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', message: '요청: 메모', createdAt: '', files: ['api/Order.java'] };
    // 서버 스냅샷에는 이미 second가 반영돼 있고, 재생되는 기록에도 second의 checkpoint 이벤트가 있다
    const view = fold([
      { type: 'snapshot', snapshot: { ...snapshot, checkpoints: [second, first] } },
      { type: 'checkpoint', runId: 'r1', checkpoint: second },
    ]);
    expect(view.snapshot.checkpoints.map((c) => c.shortSha)).toEqual(['bbbbbbb', 'aaaaaaa']);
    expect(view.chat).toHaveLength(1);
  });

  it('복원은 진행 중으로 표시했다가 결과와 새 기록으로 채운다', () => {
    const first = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: '세션 시작', createdAt: '', files: [] };
    const second = { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', message: '요청: 메모', createdAt: '', files: ['api/Order.java'] };
    const pending = fold([
      { type: 'snapshot', snapshot: { ...snapshot, checkpoints: [second, first] } },
      { type: 'restore_started', checkpoint: first },
    ]);
    expect(pending.snapshot.running).toBe(true);

    const done = fold(
      [
        {
          type: 'restored',
          checkpoint: first,
          files: ['api/Order.java'],
          restarted: [{ service: 'api', ready: true }],
          databases: [{ service: 'db', action: 'restored' }],
          checkpoints: [first],
        },
      ],
      pending,
    );
    expect(done.snapshot).toMatchObject({ running: false, checkpoints: [first] });
    expect(done.chat.at(-1)).toMatchObject({
      kind: 'restore',
      result: { ok: true, files: ['api/Order.java'], databases: [{ service: 'db', action: 'restored' }] },
    });
    expect(done.completedRuns).toBe(1);
  });

  it('이어서 작업하면 대화에 남기고 새 샌드박스 주소로 미리보기를 다시 불러오게 한다', () => {
    const head = { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', message: '요청: 메모', createdAt: '', files: ['api/Order.java'] };
    const resumed = {
      checkpoint: head,
      discarded: ['web/app/page.tsx'],
      databases: [{ service: 'db', action: 'restored' }],
      restarted: [{ service: 'api', ready: true }],
    } as const;
    const view = fold([
      { type: 'snapshot', snapshot: { ...snapshot, status: 'stopped', checkpoints: [head] } },
      { type: 'run_started', runId: 'r1', request: '요청' },
      { type: 'run_finished', runId: 'r1', status: 'error', summary: '스튜디오 서버가 멈춰 끝내지 못했습니다' },
      { type: 'resumed', ...resumed, discarded: [...resumed.discarded], databases: [...resumed.databases], restarted: [...resumed.restarted] },
    ]);

    expect(view.snapshot.running).toBe(false);
    expect(view.chat.map((item) => item.kind)).toEqual(['request', 'outcome', 'resumed']);
    expect(view.chat.at(-1)).toEqual({ kind: 'resumed', ...resumed });
    expect(view.completedRuns).toBe(2);
  });

  it('원격 변경 가져오기는 진행 중으로 표시했다가 결과와 새 기록으로 채운다', () => {
    const merged = { sha: 'c'.repeat(40), shortSha: 'ccccccc', message: '원격 커밋 1개 가져오기', createdAt: '', files: ['NOTE.md'] };
    const repository = {
      remote: 'github.com/acme/orders',
      kind: 'github',
      base: 'main',
      branch: 'b-studio/orders-s1',
      sourceDirtyFiles: 0,
      canCreatePullRequest: true,
    } as const;
    const commits = [{ shortSha: 'ddddddd', subject: 'review note', author: 'reviewer' }];

    const pending = fold([{ type: 'remote_sync_started' }]);
    expect(pending.snapshot.running).toBe(true);
    expect(pending.chat).toEqual([{ kind: 'remoteSync' }]);

    const done = fold(
      [{ type: 'remote_synced', status: 'merged', commits, files: ['NOTE.md'], checkpoint: merged, report, checkpoints: [merged], repository }],
      pending,
    );
    expect(done.snapshot).toMatchObject({ running: false, checkpoints: [merged], repository });
    expect(done.chat).toEqual([{ kind: 'remoteSync', result: { ok: true, status: 'merged', commits, files: ['NOTE.md'], checkpoint: merged, report } }]);
    expect(done.completedRuns).toBe(1);

    const conflict = fold([
      { type: 'remote_sync_started' },
      { type: 'remote_sync_failed', error: '충돌했습니다', conflicts: ['api/src/Order.java'] },
    ]);
    expect(conflict.snapshot.running).toBe(false);
    expect(conflict.chat).toEqual([{ kind: 'remoteSync', result: { ok: false, error: '충돌했습니다', conflicts: ['api/src/Order.java'] } }]);
    expect(conflict.completedRuns).toBe(0);
  });

  it('올린 결과로 원격 상태를 바꾸고 대화에 남긴다', () => {
    const repository = {
      remote: 'github.com/acme/orders',
      kind: 'github',
      base: 'main',
      branch: 'b-studio/orders-s1',
      sourceDirtyFiles: 0,
      canCreatePullRequest: true,
    } as const;
    const pushed = { ...repository, pushedSha: 'c'.repeat(40), pullRequestUrl: 'https://github.com/acme/orders/pull/1' };
    const exported: StudioEvent = {
      type: 'exported',
      repository: pushed,
      sha: 'c'.repeat(40),
      commits: 2,
      forced: false,
      pullRequest: { url: 'https://github.com/acme/orders/pull/1', created: true },
    };

    const view = fold([{ type: 'snapshot', snapshot: { ...snapshot, repository } }, exported]);
    // 다시 연결하면 이미 반영된 스냅샷 위에 같은 이벤트가 재생된다
    const replayed = fold([{ type: 'snapshot', snapshot: { ...snapshot, repository: pushed } }, exported]);

    expect(view.snapshot.repository).toEqual(pushed);
    expect(replayed.snapshot.repository).toEqual(pushed);
    expect(view.chat).toEqual([
      {
        kind: 'exported',
        branch: 'b-studio/orders-s1',
        hostKind: 'github',
        commits: 2,
        forced: false,
        pullRequest: { url: 'https://github.com/acme/orders/pull/1', created: true },
      },
    ]);
  });

  it('파일 변경 알림은 대화에 남기지 않고 코드 화면이 다시 불러올 기준 번호만 바꾼다', () => {
    const view = fold([
      { type: 'files_changed', revision: 1 },
      { type: 'files_changed', revision: 2 },
    ]);
    expect(view.snapshot.fileRevision).toBe(2);
    expect(view.chat).toEqual([]);
  });

  it('로그는 최근 항목만 남긴다', () => {
    const events: StudioEvent[] = Array.from({ length: LOG_LIMIT + 5 }, (_, i) => ({ type: 'log', service: 'api', text: `line ${i}`, at: '' }));
    const view = fold(events);
    expect(view.logs).toHaveLength(LOG_LIMIT);
    expect(view.logs.at(-1)?.text).toBe(`line ${LOG_LIMIT + 4}`);
  });
});
