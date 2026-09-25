import type { VerificationReport } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../lib/studio-events';
import { normalizeMessage, signatureKey, traceFromEvents } from './trace';

const agent = (event: unknown): StudioEvent => ({ type: 'agent', runId: 'run-1', event }) as StudioEvent;
const toolCall = (name: string, input: unknown): StudioEvent => agent({ type: 'tool_call', name, input });

function report(over: Partial<VerificationReport>): VerificationReport {
  return { ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], ...over };
}

describe('traceFromEvents', () => {
  it('도구 호출 수를 세고, 읽은 파일은 정규화·중복 제거·정렬한다', () => {
    const trace = traceFromEvents('s1', [
      toolCall('read_file', { path: './web/app/page.tsx' }),
      toolCall('read_file', { path: 'web/app/page.tsx' }),
      toolCall('read_file', { path: 'api\\src\\Order.java' }),
      toolCall('write_file', { path: 'web/app/page.tsx', content: 'x' }),
      toolCall('list_files', {}),
      toolCall('list_files', { path: 'web' }),
      { type: 'log', service: 'api', text: '무시', at: '' } as StudioEvent,
    ]);

    expect(trace.sessionId).toBe('s1');
    expect(trace.toolCalls).toEqual({ read_file: 3, write_file: 1, list_files: 2 });
    expect(trace.filesRead).toEqual(['api/src/Order.java', 'web/app/page.tsx']);
    expect(trace.dirsListed).toEqual(['.', 'web']);
    expect(trace.failureSignatures).toEqual([]);
    expect(trace.repeatedFailures).toBe(0);
  });

  it('검증기가 낸 실패만 서명으로 만든다 (줄 번호가 달라도 같은 서명)', () => {
    const trace = traceFromEvents('s1', [
      agent({ type: 'verify_result', text: '무시되는 모델 텍스트', report: report({ restarted: [{ service: 'api', ready: false, error: 'cannot find symbol at line 42' }] }) }),
      agent({ type: 'verify_result', text: '무시', report: report({ restarted: [{ service: 'api', ready: false, error: 'cannot find symbol at line 57' }] }) }),
      agent({ type: 'workflow_check', check: { stage: 'test', name: 'web-lint', ok: false, attempts: 1, detail: 'eslint found 3 problems' } }),
      agent({ type: 'workflow_check', check: { stage: 'review', name: 'review', ok: true, attempts: 1 } }),
    ]);

    expect(trace.failureSignatures).toHaveLength(3);
    expect(trace.failureSignatures[0]).toMatchObject({ stage: 'run', service: 'api', message: 'cannot find symbol at line N' });
    // 줄 번호만 다른 실패는 같은 서명이다
    expect(signatureKey(trace.failureSignatures[0]!)).toBe(signatureKey(trace.failureSignatures[1]!));
    expect(trace.repeatedFailures).toBe(1);
    // 통과한 확인은 서명을 만들지 않는다
    expect(trace.failureSignatures[2]).toMatchObject({ stage: 'test', message: 'eslint found N problems' });
  });

  it('계약 확인 실패도 서명이 되고, 통과한 계약은 아니다', () => {
    const trace = traceFromEvents('s1', [
      agent({
        type: 'verify_result',
        text: '',
        report: report({
          contracts: [
            { service: 'api', changes: [{ kind: 'property-removed', target: 'OrderResponse.memo', breaking: true }] },
            { service: 'web', changes: [] },
          ],
        }),
      }),
    ]);

    expect(trace.failureSignatures).toEqual([{ stage: 'contract_check', service: 'api', message: 'property-removed OrderResponse.memo' }]);
  });

  it('준비하지 못한 서비스가 여럿이면 각각 서명이 된다', () => {
    const trace = traceFromEvents('s1', [
      agent({ type: 'verify_result', text: '', report: report({ restarted: [{ service: 'api', ready: false }, { service: 'web', ready: true }] }) }),
    ]);
    expect(trace.failureSignatures).toEqual([{ stage: 'run', service: 'api', message: '서비스를 준비하지 못했습니다' }]);
  });

  it('반영 확인 실패와 시크릿 검출도 서명이 된다 (시크릿 값은 넣지 않는다)', () => {
    const trace = traceFromEvents('s1', [
      agent({ type: 'verify_result', text: '', report: report({ sync: { error: '파일 반영을 확인하지 못했습니다' } }) }),
      agent({
        type: 'verify_result',
        text: '',
        report: report({ secretLeaks: [{ file: 'api/src/main/resources/application.yaml', secrets: ['DATABASE_PASSWORD'] }] }),
      }),
    ]);

    expect(trace.failureSignatures).toEqual([
      { stage: 'sync', message: '파일 반영을 확인하지 못했습니다' },
      // SecretLeak.secrets는 값이 아니라 시크릿 이름이다. 서명에는 파일 경로와 이름만 남는다
      { stage: 'secret_leak', message: 'api/src/main/resources/application.yaml: DATABASE_PASSWORD', files: ['api/src/main/resources/application.yaml'] },
    ]);
  });

  it('__proto__·constructor 이름의 도구 호출도 센다', () => {
    const trace = traceFromEvents('s1', [toolCall('__proto__', {}), toolCall('__proto__', {}), toolCall('constructor', {})]);

    expect(trace.toolCalls['__proto__']).toBe(2);
    expect(trace.toolCalls['constructor']).toBe(1);
    expect(Object.keys(trace.toolCalls).sort()).toEqual(['__proto__', 'constructor']);
  });
});

describe('normalizeMessage', () => {
  it('첫 줄만 쓰고 앞뒤 공백을 지운다', () => {
    expect(normalizeMessage('  line 42\nextra  ')).toBe('line N');
  });

  it('16진 해시는 H, 숫자열은 N으로 바꾸고 200자로 자른다', () => {
    expect(normalizeMessage('checkpoint 351872d is bad')).toBe('checkpoint H is bad');
    expect(normalizeMessage('z'.repeat(300))).toHaveLength(200);
  });

  it('단어 안의 글자를 해시로 잘못 줄이지 않는다', () => {
    expect(normalizeMessage('feedback loop')).toBe('feedback loop');
  });
});
