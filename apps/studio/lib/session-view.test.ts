import type { VerificationReport } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { createView, LOG_LIMIT, reduceSession, type SessionView } from './session-view';
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

const report = { ok: true, sync: { elapsedMs: 700 }, restarted: [], contracts: [], unverifiedFiles: [] } satisfies VerificationReport;

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

  it('검증 게이트는 확인 중으로 나타났다가 결과로 채워진다', () => {
    const pending = fold([{ type: 'agent', runId: 'r1', event: { type: 'verify_start', files: ['api/Order.java'] } }]);
    expect(pending.chat).toEqual([{ kind: 'gate', runId: 'r1', files: ['api/Order.java'] }]);

    const done = fold([{ type: 'agent', runId: 'r1', event: { type: 'verify_result', report, text: '검증 통과' } }], pending);
    expect(done.chat).toEqual([{ kind: 'gate', runId: 'r1', files: ['api/Order.java'], report }]);
  });

  it('요청이 끝나면 실행 중 표시를 끄고 다음 데모 요청을 갱신한다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '주문 목록 API와 화면을 만들어줘' },
      { type: 'run_finished', runId: 'r1', status: 'done', summary: '완료', turns: 4, nextDemoRequest: '주문에 배송 메모 필드 추가해줘' },
    ]);
    expect(view.snapshot).toMatchObject({ running: false, nextDemoRequest: '주문에 배송 메모 필드 추가해줘' });
    expect(view.completedRuns).toBe(1);
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
      [{ type: 'restored', checkpoint: first, files: ['api/Order.java'], restarted: [{ service: 'api', ready: true }], checkpoints: [first] }],
      pending,
    );
    expect(done.snapshot).toMatchObject({ running: false, checkpoints: [first] });
    expect(done.chat.at(-1)).toMatchObject({ kind: 'restore', result: { ok: true, files: ['api/Order.java'] } });
    expect(done.completedRuns).toBe(1);
  });

  it('로그는 최근 항목만 남긴다', () => {
    const events: StudioEvent[] = Array.from({ length: LOG_LIMIT + 5 }, (_, i) => ({ type: 'log', service: 'api', text: `line ${i}`, at: '' }));
    const view = fold(events);
    expect(view.logs).toHaveLength(LOG_LIMIT);
    expect(view.logs.at(-1)?.text).toBe(`line ${LOG_LIMIT + 4}`);
  });
});
