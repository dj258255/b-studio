import type { VerificationReport } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { activeRun, createView, latestWrite, LOG_LIMIT, outcomeText, reduceSession, runHasChanges, runsWithChanges, type ChatItem, type SessionView } from './session-view';
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

const report = { ok: true, sync: { elapsedMs: 700 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] } satisfies VerificationReport;

function fold(events: StudioEvent[], start: SessionView = createView(snapshot)): SessionView {
  return events.reduce(reduceSession, start);
}

describe('reduceSession', () => {
  it('러너 경고(warning)를 대화에 안내 한 줄로 남긴다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '이어서 해줘' },
      { type: 'agent', runId: 'r1', event: { type: 'warning', message: '이 실행은 이전 대화를 이어받지 못합니다: 상태 폴더 없음' } },
    ]);

    expect(view.chat.map((item) => item.kind)).toEqual(['request', 'warning']);
    expect(view.chat[1]).toMatchObject({ runId: 'r1', text: '이 실행은 이전 대화를 이어받지 못합니다: 상태 폴더 없음' });
    // 경고는 실행을 멈추지 않는다(안내만 남긴다)
    expect(view.snapshot.running).toBe(true);
  });

  it('모델 라우팅 결정과 후보 점수를 대화 기록에 남긴다', () => {
    const initial = createView(snapshot);
    const view = reduceSession(initial, {
      type: 'agent',
      runId: 'r1',
      event: {
        type: 'route',
        selectedId: 'fast',
        reason: '단순 요청은 비용 가중치를 높임',
        complexity: 'simple',
        risk: 'normal',
        candidates: [
          { id: 'fast', label: '빠른 모델', eligible: true, score: 0.8, estimatedCostUsd: 0.01 },
          { id: 'strong', label: '강한 모델', eligible: true, score: 0.7, estimatedCostUsd: 0.08 },
        ],
      },
    });

    expect(view.chat[0]).toMatchObject({ kind: 'route', selectedId: 'fast', complexity: 'simple' });
  });

  it('claude-code 자동 모델 선택(ADR-091)은 같은 route 이벤트에 auto:true로 남는다', () => {
    const initial = createView(snapshot);
    const view = reduceSession(initial, {
      type: 'agent',
      runId: 'r1',
      event: {
        type: 'route',
        selectedId: 'sonnet',
        reason: '단순한 만들기 요청이라 Sonnet 5을 선택합니다',
        complexity: 'simple',
        risk: 'normal',
        candidates: [
          { id: 'haiku', label: 'Haiku', eligible: false, score: 0 },
          { id: 'sonnet', label: 'Sonnet 5', eligible: true, score: 0 },
          { id: 'opus', label: 'Opus', eligible: false, score: 0 },
        ],
        auto: true,
      },
    });

    expect(view.chat[0]).toMatchObject({ kind: 'route', selectedId: 'sonnet', auto: true });
  });

  it('계획-실행 분리(ADR-075)의 계획을 "계획(모델명)" 접기 블록으로 대화에 남긴다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '주문 목록 화면을 만들어줘' },
      { type: 'plan_brief', runId: 'r1', model: 'opus', text: '1. web/orders 목록 화면을 만든다', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 1200 },
    ]);

    expect(view.chat.map((item) => item.kind)).toEqual(['request', 'planBrief']);
    expect(view.chat[1]).toMatchObject({ kind: 'planBrief', runId: 'r1', model: 'opus', text: '1. web/orders 목록 화면을 만든다' });
  });

  it('되묻기 질문을 스냅샷에 남기고, 다음 요청을 보내면 지운다', () => {
    const asked = fold([
      { type: 'question', runId: 'r1', question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: true },
      { type: 'run_finished', runId: 'r1', status: 'awaiting_input', summary: '어떤 형태로 만들까요?' },
    ]);
    expect(asked.snapshot.pendingQuestion).toEqual({ runId: 'r1', question: '어떤 형태로 만들까요?', options: ['표', '카드'], allowOther: true });
    expect(asked.chat.at(-1)).toMatchObject({ kind: 'outcome', status: 'awaiting_input' });

    const answered = reduceSession(asked, { type: 'run_started', runId: 'r2', request: '[질문] 어떤 형태로 만들까요?\n[답] 표' });
    expect(answered.snapshot.pendingQuestion).toBeUndefined();
  });

  it('제안이 붙은 질문을 남기고, 넘기면 카드를 치우고 넘긴 곳을 대화에 남긴다', () => {
    const proposal = { mode: 'split' as const, request: '주문 API와 화면' };
    const asked = fold([
      { type: 'question', runId: 'r1', question: '나눠서 할까요?', options: ['나눠서 병렬로 하기', '한 명으로 계속'], allowOther: false, proposal },
      { type: 'run_finished', runId: 'r1', status: 'awaiting_input', summary: '나눠서 할까요?' },
    ]);
    expect(asked.snapshot.pendingQuestion).toMatchObject({ runId: 'r1', proposal });

    const handed = reduceSession(asked, { type: 'question_dismissed', runId: 'r1', to: 'split', href: '/task-plans?id=p1' });
    expect(handed.snapshot.pendingQuestion).toBeUndefined();
    expect(handed.chat.at(-1)).toEqual({ kind: 'handoff', runId: 'r1', to: 'split', href: '/task-plans?id=p1' });

    // 다른 질문의 늦은 치우기는 지금 질문을 지우지 않는다
    const stale = reduceSession(asked, { type: 'question_dismissed', runId: 'old', to: 'split', href: '/task-plans?id=p0' });
    expect(stale.snapshot.pendingQuestion).toMatchObject({ runId: 'r1' });
  });

  it('끝나거나 실패한 실행이 남긴 질문은 남기지 않는다', () => {
    const failed = fold([
      { type: 'question', runId: 'r1', question: 'q', options: ['a', 'b'], allowOther: false },
      { type: 'run_finished', runId: 'r1', status: 'failed', summary: '실패' },
    ]);
    expect(failed.snapshot.pendingQuestion).toBeUndefined();
  });

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

  it('배포 진행 줄은 스냅샷에 모으고, 끝나면 대화에 결과를 남기며 배포 탭이 다시 불러오게 한다', () => {
    const started: StudioEvent = { type: 'deploy_started', action: 'deploy', target: 'abc1234', at: '2026-09-12T00:00:00Z', by: 'alice' };
    const running = fold([started, { type: 'deploy_log', line: '[api] api 빌드 완료 (8.9초)' }]);
    expect(running.snapshot.deploying).toEqual({ action: 'deploy', target: 'abc1234', startedAt: '2026-09-12T00:00:00Z', by: 'alice', lines: ['[api] api 빌드 완료 (8.9초)'] });

    const done = fold([{ type: 'deploy_finished', action: 'deploy', release: 'r1', label: '체크포인트 abc1234', urls: { web: 'http://127.0.0.1:8300' } }], running);
    expect(done.snapshot.deploying).toBeUndefined();
    expect(done.deployRevision).toBe(1);
    expect(done.chat).toEqual([
      {
        kind: 'deploy',
        action: 'deploy',
        target: 'abc1234',
        by: 'alice',
        result: { ok: true, release: 'r1', label: '체크포인트 abc1234', urls: { web: 'http://127.0.0.1:8300' } },
      },
    ]);

    // 시작 이벤트 없이 줄만 오면 무시한다
    expect(fold([{ type: 'deploy_log', line: 'x' }]).snapshot.deploying).toBeUndefined();
    const failed = fold([started, { type: 'deploy_failed', action: 'deploy', target: 'abc1234', error: 'api 운영 이미지를 빌드하지 못했습니다' }]);
    expect(failed.chat[0]).toMatchObject({ kind: 'deploy', result: { ok: false, error: 'api 운영 이미지를 빌드하지 못했습니다' } });
  });

  it('질문 요청의 결과에 질문 표시를 남기고 데모 질문을 갱신한다', () => {
    const view = fold([
      { type: 'run_started', runId: 'q1', request: '어떻게 바꿔?', intent: 'ask' },
      {
        type: 'run_finished',
        runId: 'q1',
        status: 'done',
        summary: '계획',
        turns: 2,
        nextDemoRequest: '주문 목록 API와 화면을 만들어줘',
        nextDemoQuestion: '주문 목록 화면을 만들려면 무엇을 바꿔야 해?',
      },
    ]);

    expect(view.chat).toEqual([
      { kind: 'request', runId: 'q1', text: '어떻게 바꿔?', intent: 'ask' },
      { kind: 'outcome', runId: 'q1', status: 'done', summary: '계획', turns: 2, intent: 'ask' },
    ]);
    expect(view.snapshot.nextDemoQuestion).toBe('주문 목록 화면을 만들려면 무엇을 바꿔야 해?');
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

  it('실행 환경 알림에 노력 단계가 실려 있으면 함께 남긴다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '주문 수 API 추가' },
      { type: 'agent', runId: 'r1', event: { type: 'session', backend: 'Anthropic API', model: 'claude-sonnet-5', effort: 'max' } },
    ]);
    expect(view.chat.at(-1)).toMatchObject({ kind: 'backend', model: 'claude-sonnet-5', effort: 'max' });
  });

  it('model 이벤트는 모델과 노력 단계를 함께 스냅샷에 반영한다', () => {
    const view = fold([{ type: 'model', modelId: 'opus', effort: 'low' }]);
    expect(view.snapshot.modelId).toBe('opus');
    expect(view.snapshot.effort).toBe('low');
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

  it('기동 중 받은 네트워크 바이트를 스냅샷과 기동 줄에 남긴다', () => {
    const network = [
      { service: 'api', rxBytes: 1_200_000, txBytes: 3_400 },
      { service: 'web', rxBytes: 500_000, txBytes: 2_000 },
    ];
    const view = fold([{ type: 'boot_network', at: '2026-09-12T00:00:00Z', network }]);

    expect(view.snapshot.bootNetwork).toEqual(network);
    expect(view.chat).toEqual([{ kind: 'boot', network }]);
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

  it('진행 중 지시를 대기로 넣고, 반영되면 반영됨, 끝까지 남으면 적용 실패로 표시한다', () => {
    const view = fold([
      { type: 'run_started', runId: 'r1', request: '요청' },
      { type: 'steer_queued', runId: 'r1', text: '지시1' },
      { type: 'steer_queued', runId: 'r1', text: '지시2' },
      { type: 'agent', runId: 'r1', event: { type: 'steer_applied', count: 1 } },
    ]);

    expect(view.chat.filter((item) => item.kind === 'steer')).toEqual([
      { kind: 'steer', runId: 'r1', text: '지시1', status: 'applied' },
      { kind: 'steer', runId: 'r1', text: '지시2', status: 'queued' },
    ]);

    const dropped = fold([{ type: 'steer_dropped', runId: 'r1', texts: ['지시2'] }], view);
    expect(dropped.chat.filter((item) => item.kind === 'steer')).toEqual([
      { kind: 'steer', runId: 'r1', text: '지시1', status: 'applied' },
      { kind: 'steer', runId: 'r1', text: '지시2', status: 'dropped' },
    ]);
  });
});

describe('실행 결과 표시 (입력이 하나로 합쳐진 뒤)', () => {
  const outcome = (over: Partial<Extract<ChatItem, { kind: 'outcome' }>> = {}): Extract<ChatItem, { kind: 'outcome' }> => ({
    kind: 'outcome',
    runId: 'r1',
    status: 'done',
    summary: '이 함수는 …',
    turns: 1,
    ...over,
  });

  it('게이트를 돌았거나 체크포인트가 남은 실행만 파일을 바꾼 실행으로 본다', () => {
    const changed = fold([
      { type: 'run_started', runId: 'r1', request: '고쳐줘' },
      { type: 'agent', runId: 'r1', event: { type: 'verify_start', files: ['web/app/page.tsx'] } },
      { type: 'run_finished', runId: 'r1', status: 'done', summary: '고쳤습니다', turns: 2 },
    ]);
    expect(runHasChanges(changed.chat, 'r1')).toBe(true);
    expect([...runsWithChanges(changed.chat)]).toEqual(['r1']);

    // 바뀐 파일이 없으면 게이트가 검증 없이 통과하므로 게이트 줄도 체크포인트도 없다
    const answered = fold([
      { type: 'run_started', runId: 'r2', request: '이 함수는 어떻게 동작해?' },
      { type: 'run_finished', runId: 'r2', status: 'done', summary: '이렇게 동작합니다', turns: 1 },
    ]);
    expect(runHasChanges(answered.chat, 'r2')).toBe(false);
    expect(runsWithChanges(answered.chat).size).toBe(0);
  });

  it('결과 한 줄은 바꾼 파일이 없으면 "답만 했습니다"로 알린다', () => {
    expect(outcomeText(outcome(), true)).toBe('완료, 1턴');
    expect(outcomeText(outcome({ turns: 3 }), false)).toBe('답만 했습니다(바꾼 파일 없음), 3턴');
    // 답을 기다리거나 취소·실패한 실행의 문구는 그대로다
    expect(outcomeText(outcome({ status: 'awaiting_input', summary: '어떤 형태로 만들까요?' }), false)).toBe('답을 기다립니다');
    expect(outcomeText(outcome({ status: 'cancelled', summary: '요청을 취소했습니다' }), true)).toBe('요청을 취소했습니다');
    expect(outcomeText(outcome({ status: 'failed', summary: '게이트 실패' }), true)).toBe('완료하지 못함: 게이트 실패');
    expect(outcomeText(outcome({ status: 'error', summary: '연결 끊김' }), true)).toBe('오류: 연결 끊김');
  });
});
