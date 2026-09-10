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

  it('로그는 최근 항목만 남긴다', () => {
    const events: StudioEvent[] = Array.from({ length: LOG_LIMIT + 5 }, (_, i) => ({ type: 'log', service: 'api', text: `line ${i}`, at: '' }));
    const view = fold(events);
    expect(view.logs).toHaveLength(LOG_LIMIT);
    expect(view.logs.at(-1)?.text).toBe(`line ${LOG_LIMIT + 4}`);
  });
});
