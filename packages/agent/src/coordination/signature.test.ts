import { describe, expect, it } from 'vitest';
import type { VerificationReport } from '../verify';
import type { WorkflowCheck } from '../workflow';
import { failureNotesFromEvents, failureNotesFromReport, signatureFromCheck, signatureKey, signaturesFromReport } from './signature';

function report(over: Partial<VerificationReport>): VerificationReport {
  return { ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], ...over };
}

describe('signatureKey', () => {
  it('단계·서비스·메시지·파일을 하나의 키로 합친다', () => {
    expect(signatureKey({ stage: 'run', service: 'api', message: 'boom' })).toBe('run|api|boom|');
    expect(signatureKey({ stage: 'secret_leak', message: 'x', files: ['a.ts'] })).toBe('secret_leak||x|a.ts');
  });
});

describe('signaturesFromReport', () => {
  it('준비 못 한 서비스·계약·반영·시크릿만 서명으로 만든다', () => {
    const signatures = signaturesFromReport(
      report({
        restarted: [
          { service: 'api', ready: false, error: 'cannot find symbol at line 42' },
          { service: 'web', ready: true },
        ],
        contracts: [{ service: 'api', changes: [{ kind: 'property-removed', target: 'OrderResponse.memo', breaking: true }] }],
        sync: { error: '파일 반영 실패' },
        secretLeaks: [{ file: 'api/app.yaml', secrets: ['DATABASE_PASSWORD'] }],
      }),
    );

    expect(signatures).toEqual([
      { stage: 'run', service: 'api', message: 'cannot find symbol at line N' },
      { stage: 'contract_check', service: 'api', message: 'property-removed OrderResponse.memo' },
      { stage: 'sync', message: '파일 반영 실패' },
      // 시크릿 값이 아니라 파일 경로와 시크릿 이름만 남긴다
      { stage: 'secret_leak', message: 'api/app.yaml: DATABASE_PASSWORD', files: ['api/app.yaml'] },
    ]);
  });

  it('통과한 계약 확인은 서명을 만들지 않는다', () => {
    expect(signaturesFromReport(report({ contracts: [{ service: 'web', changes: [] }] }))).toEqual([]);
  });
});

describe('signatureFromCheck', () => {
  it('실패한 워크플로 확인을 서명으로 만든다', () => {
    expect(signatureFromCheck({ stage: 'test', name: 'web-lint', ok: false, attempts: 1, detail: 'eslint found 3 problems' })).toEqual({
      stage: 'test',
      message: 'eslint found N problems',
    });
    // detail이 없으면 이름을 쓴다
    expect(signatureFromCheck({ stage: 'review', name: 'review', ok: false, attempts: 1 })).toEqual({ stage: 'review', message: 'review' });
  });

  it('api 값 확인 실패도 browser_check 서명으로 나타나고, 확인 종류별로 구분된다', () => {
    const check = (detail: string): WorkflowCheck => ({ stage: 'browser_check', name: 'api /orders', ok: false, attempts: 1, detail });

    const apiError = signatureFromCheck(check('api GET /api/orders가 HTTP 500을 돌려줬습니다'));
    const notOnScreen = signatureFromCheck(check("api의 $[0].customerName 값 '홍길동'이 /orders 화면에 없습니다 — 화면이 다른 필드 이름을 읽고 있을 수 있습니다"));
    const textMissing = signatureFromCheck(check("렌더링된 화면에 '주문 목록'가 없습니다"));

    expect(apiError.stage).toBe('browser_check');
    // 숫자열은 N으로 정규화된다
    expect(apiError.message).toBe('api GET /api/orders가 HTTP N을 돌려줬습니다');
    // api 상태 오류·화면에 값 없음·기대 문구 없음은 서로 다른 서명이다(S5가 원인을 가릴 수 있게)
    expect(new Set([apiError, notOnScreen, textMissing].map(signatureKey)).size).toBe(3);
  });
});

describe('failureNotesFromReport', () => {
  it('검증 보고서와 실패한 확인만 failure 메모 입력으로 만든다', () => {
    const checks: WorkflowCheck[] = [
      { stage: 'test', name: 'web-lint', ok: false, attempts: 1, detail: 'eslint found 3 problems' },
      { stage: 'review', name: 'review', ok: true, attempts: 1 },
    ];
    expect(failureNotesFromReport(report({ restarted: [{ service: 'api', ready: false, error: 'boom 42' }] }), checks)).toEqual([
      { kind: 'failure', body: '[run api] boom N', refs: [] },
      { kind: 'failure', body: '[test] eslint found N problems', refs: [] },
    ]);
  });

  it('시크릿 검출은 파일 경로를 refs로 남긴다', () => {
    expect(failureNotesFromReport(report({ secretLeaks: [{ file: 'api/app.yaml', secrets: ['DATABASE_PASSWORD'] }] }))).toEqual([
      { kind: 'failure', body: '[secret_leak] api/app.yaml: DATABASE_PASSWORD', refs: ['api/app.yaml'] },
    ]);
  });

  it('실패가 없으면 빈 목록이다', () => {
    expect(failureNotesFromReport(report({}))).toEqual([]);
  });
});

describe('failureNotesFromEvents', () => {
  it('세션 기록의 검증 결과와 실패한 워크플로 확인만 서명으로 만든다', () => {
    const notes = failureNotesFromEvents([
      { type: 'log' },
      { type: 'agent', event: { type: 'verify_result', report: report({ restarted: [{ service: 'api', ready: false, error: 'boom 42' }] }) } },
      { type: 'agent', event: { type: 'workflow_check', check: { stage: 'test', name: 'web-lint', ok: false, attempts: 1, detail: 'eslint found 3 problems' } } },
      // 통과한 확인도, 검증 결과가 아닌 이벤트도 서명이 되지 않는다
      { type: 'agent', event: { type: 'workflow_check', check: { stage: 'review', name: 'review', ok: true, attempts: 1 } } },
      { type: 'agent', event: { type: 'text' } },
      // event가 없는 이벤트도 무시한다
      { type: 'snapshot' },
    ]);

    expect(notes).toEqual([
      { kind: 'failure', body: '[run api] boom N', refs: [] },
      { kind: 'failure', body: '[test] eslint found N problems', refs: [] },
    ]);
  });
});
