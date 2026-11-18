import type { AgentResult, AgentUsage, VerificationReport, WorkflowCheck } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import * as legacy from './session-text-legacy';
import * as now from './session-text';

/**
 * 세션 조율 함수가 만드는 글(ADR-195 4f C1-6a/6b)의 차등 시험. 같은 입력을 옛 TS(`session-text-legacy.ts`)와
 * 새 껍데기(Rust, `crates/bstudio-session/src/terminal_text.rs`)에 넣어 글자와 객체를 견준다.
 * 트레일러는 게이트 통과의 근거라 `Workflow-Passed`·`Workflow-Verify`·`Workflow-Incomplete`의 경계를 함께 본다.
 */

const THROWS = Symbol('throws');
function observe<T>(fn: () => T): T | typeof THROWS {
  try {
    return fn();
  } catch {
    return THROWS;
  }
}

const ZERO: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('checkpointBody: 본문 조립이 바이트까지 같다', () => {
  const REPORTS: unknown[] = [
    undefined,
    null,
    {},
    { ok: true },
    { ok: false, reason: '실패' },
    { ok: true, restarted: [{ service: 'api', ok: true }], sync: { elapsedMs: 1250 } },
    { ok: 'yes' },
    { ok: true, nested: { a: [1, null, 'x'] } },
  ];
  const CHECK_SETS: unknown[] = [
    undefined,
    [],
    [{ stage: 'test', name: 't1', ok: true }],
    [{ stage: 'test', name: 't1', ok: false, detail: '실패' }, { stage: 'review', name: 'r', ok: true, detail: null }],
    [{ stage: 'run', name: 'coverage-gap:web', ok: false, detail: '근거 없음' }],
    [{ name: 'x', ok: 1 }, { name: 'y' }],
  ];
  const SUMMARIES = [
    '',
    ' ',
    '\n\t ',
    '\ufeff앞뒤\ufeff',
    '한 줄',
    '첫 줄\n둘째 줄\n',
    Array.from({ length: 30 }, (_, i) => `줄${i}`).join('\n'),
    Array.from({ length: 31 }, (_, i) => `줄${i}`).join('\n'),
    '\n\n앞 빈 줄\n\n',
    '😀 이모지\n끝',
  ];

  it('보고서·검사·요약·재시도 횟수의 경계값', () => {
    let compared = 0;
    for (const report of REPORTS) {
      for (const checks of CHECK_SETS) {
        for (const summary of SUMMARIES) {
          for (const verifyAttempts of [0, 1, 3, -1, 2.5, NaN]) {
            for (const unguardedWrites of [false, true]) {
              const result = { report, checks, summary, verifyAttempts } as unknown as AgentResult;
              const got = observe(() => now.checkpointBody(result, false, { unguardedWrites }));
              const old = observe(() => legacy.checkpointBody(result, false, { unguardedWrites }));
              expect(got, JSON.stringify({ report, checks, summary: summary.slice(0, 20), verifyAttempts, unguardedWrites })).toEqual(old);
              compared += 1;
            }
          }
        }
      }
    }
    expect(compared).toBe(REPORTS.length * CHECK_SETS.length * SUMMARIES.length * 6 * 2);
  });

  it('allowBreaking이 보고서 글에 반영된다', () => {
    const report = { ok: false, contract: { breaking: [{ service: 'api', change: 'x' }] } } as unknown as VerificationReport;
    const result = { report, checks: [], summary: '', verifyAttempts: 0 } as unknown as AgentResult;
    expect(now.checkpointBody(result, true)).toBe(legacy.checkpointBody(result, true));
    expect(now.checkpointBody(result, false)).toBe(legacy.checkpointBody(result, false));
  });

  it('보고서를 JSON으로 만들 수 없으면(순환) 옛 실패 글과 같다', () => {
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    const result = { report: cyclic, checks: [], summary: '', verifyAttempts: 0 } as unknown as AgentResult;
    expect(now.checkpointBody(result, false)).toBe(legacy.checkpointBody(result, false));
    expect(now.checkpointBody(result, false)).toBe('검증 실패\n- 검증 보고서를 글로 만들 수 없습니다');
  });
});

describe('checkpointTrailers: 트레일러가 바이트까지 같다', () => {
  it('통과 단계·가벼운 확인·턴 상한의 경계', () => {
    for (const passedStages of [undefined, [], ['run'], ['implement', 'run'], ['run', 'review', 'checkpoint']] as const) {
      for (const verify of [undefined, null, 'light', 'docs', 'unverified', 'LIGHT', 'light '] as const) {
        for (const incomplete of [undefined, null, 'max_turns', 'other', 'MAX_TURNS'] as const) {
          const result = { passedStages, verify, incomplete } as unknown as AgentResult;
          expect(now.checkpointTrailers(result), JSON.stringify({ passedStages, verify, incomplete })).toEqual(legacy.checkpointTrailers(result));
        }
      }
    }
  });

  it('빈 통과 트레일러와 문서 검증 트레일러가 섞이지 않는다', () => {
    const empty = now.checkpointTrailers({ passedStages: [] } as unknown as AgentResult);
    expect(empty).toEqual(['Workflow-Passed: none']);
    expect(empty).not.toContain('Workflow-Verify: docs');
    const light = now.checkpointTrailers({ passedStages: [], verify: 'light' } as unknown as AgentResult);
    expect(light).toEqual(['Workflow-Passed: none', 'Workflow-Verify: light']);
    const maxTurns = now.checkpointTrailers({ passedStages: ['run'], incomplete: 'max_turns' } as unknown as AgentResult);
    expect(maxTurns).toEqual(['Workflow-Passed: run', 'Workflow-Incomplete: max_turns']);
  });
});

describe('terminalResult: 결과 객체가 키 순서까지 같다', () => {
  const CASES = [
    { status: 'done', summary: '', usage: undefined, usageByModel: undefined, report: undefined, checks: [], passedStages: [], attempts: 0, gateMs: 0 },
    { status: 'done', summary: '끝', usage: { ...ZERO, inputTokens: 1 }, usageByModel: undefined, report: undefined, checks: [], passedStages: ['run'], attempts: 2, gateMs: 12 },
    {
      status: 'failed',
      summary: '실패',
      usage: { ...ZERO, outputTokens: 3 },
      usageByModel: { m: { ...ZERO, inputTokens: 7 } },
      report: { ok: false },
      checks: [{ stage: 'test', name: 't', ok: false }] as WorkflowCheck[],
      passedStages: [],
      attempts: 3,
      gateMs: 99,
    },
    { status: 'failed', summary: '', usage: undefined, usageByModel: undefined, report: null, checks: [], passedStages: [], attempts: 0, gateMs: NaN },
  ] as const;

  it('보고서·사용량·모델별 사용량의 유무', () => {
    for (const item of CASES) {
      const run = item.usage === undefined ? {} : { terminalUsage: { usage: item.usage, usageByModel: item.usageByModel ?? {}, modelCalls: 2 } };
      const verification = {
        workspace: { changedFiles: () => ['a.txt', 'b/c.txt'] },
        gate: { ...(item.report === undefined ? {} : { report: item.report }), checks: item.checks, passedStages: item.passedStages, attempts: item.attempts },
      };
      const got = now.assembleTerminalResult({
        status: item.status,
        summary: item.summary,
        changedFiles: verification.workspace.changedFiles(),
        report: item.report,
        checks: item.checks,
        gateOutcome: item.status === 'done' ? 'pass' : 'exhausted',
        passedStages: item.passedStages,
        verifyAttempts: item.attempts,
        usage: item.usage ?? ZERO,
        modelCalls: run.terminalUsage?.modelCalls ?? 0,
        usageByModel: run.terminalUsage?.usageByModel,
        gateMs: item.gateMs,
      });
      const old = legacy.terminalResult(run as never, verification as never, item.status, item.summary, item.status === 'done' ? 'pass' : 'exhausted', item.gateMs);
      expect(got, JSON.stringify(item)).toEqual(old);
      expect(JSON.stringify(got), JSON.stringify(item)).toBe(JSON.stringify(old));
      expect(Object.keys(got)).toEqual(Object.keys(old));
      expect(Object.keys(got.metrics!)).toEqual(Object.keys(old.metrics!));
    }
  });
});

describe('거절 글·한 줄 알림·피드백', () => {
  it('글 상수가 같다', () => {
    expect(now.TERMINAL_TEXTS).toEqual(legacy.LEGACY_TERMINAL_TEXTS);
    expect(Object.keys(now.TERMINAL_TEXTS)).toEqual(Object.keys(legacy.LEGACY_TERMINAL_TEXTS));
  });

  it('pretoolDenyText: 알려진 갈래·모르는 갈래·본문 유무', () => {
    const kinds: string[] = ['read_only', 'closed', 'budget', 'busy', 'max_turns', 'run_budget', 'unknown', 'out_of_scope', '그 밖'];
    const textSets = [
      {},
      { budget: '[b-studio] 한도' },
      { busy: '[b-studio] 바쁨', unknown: '' },
      { out_of_scope: '[b-studio] 범위 밖\n둘째 줄' },
    ];
    for (const kind of kinds) {
      for (const texts of textSets) {
        expect(now.pretoolDenyText(kind as never, texts as never), JSON.stringify({ kind, texts })).toBe(legacy.pretoolDenyText(kind as never, texts as never));
      }
    }
  });

  it('hookMessage: 개행·접두사·유니코드', () => {
    for (const summary of ['', 'a', 'a\nb', 'a\n\nb', 'a\r\nb', '\n\n', '[b-studio] x', '[b-studio]', ' [b-studio] x', '한글 😀\n\n끝']) {
      expect(now.hookMessage(summary), JSON.stringify(summary)).toBe(legacy.hookMessage(summary));
    }
  });

  it('doneTestsFeedback: 빈 목록·여러 건·이름과 자세히의 글자', () => {
    const cases: Array<Array<{ name: string; detail: string }>> = [
      [],
      [{ name: 't1', detail: '실패' }],
      [
        { name: '단위', detail: '첫 줄\n둘째 줄' },
        { name: "t'2", detail: '😀' },
      ],
    ];
    for (const failures of cases) expect(now.doneTestsFeedback(failures)).toBe(legacy.doneTestsFeedback(failures));
  });

  it('정체·한도·오류 종류', () => {
    for (const stallMs of [0, 1000, 59000, 60000, 61000, 90000, 120000, 3600000, 1500]) {
      expect(now.terminalStallMessage(stallMs), String(stallMs)).toBe(legacy.terminalStallMessage(stallMs));
    }
    for (const kind of ['session', 'user', 'usage_unreadable'] as const) expect(now.limitAbortMessage(kind)).toBe(legacy.limitAbortMessage(kind));
    const raws = [undefined, '', ' ', 'rate_limit', ' OVERLOADED ', 'a-b_c.d', 'a'.repeat(40), 'a'.repeat(41), '한글', 'a\nb', 'a b', 'connect_error', 'x/../y'];
    for (const raw of raws) expect(now.apiErrorKind(raw), JSON.stringify(raw)).toBe(legacy.apiErrorKind(raw));
  });
});

describe('한도·CLI 종료·시간 상한 글', () => {
  it('attemptsExhaustedSummary: 횟수와 잘린 피드백', () => {
    const feedbacks = ['', '이유', 'a'.repeat(799) + 'xy', '😀'.repeat(500)];
    for (const gate of [0, 1, 3, -1]) {
      for (const unsettled of [0, 2]) {
        for (const feedback of feedbacks) {
          const clipped = legacy.clipText(feedback, 800);
          // 이모지를 자르는 경계는 아래 "의도한 차이"에서 따로 본다
          if (clipped.includes('\ud83d') || clipped.includes('\ude00')) continue;
          expect(now.attemptsExhaustedSummary(gate, unsettled, clipped, 3)).toBe(legacy.attemptsExhaustedSummary(gate, unsettled, feedback, 3));
        }
      }
    }
  });

  it('cliEndedReason: 잘린 피드백', () => {
    for (const feedback of ['', '이유', 'x'.repeat(4000), '한글'.repeat(3000)]) {
      const clipped = legacy.clipText(feedback, 4000);
      expect(now.cliEndedReason(clipped)).toBe(legacy.cliEndedReason(feedback));
    }
  });

  it('deadlineReason: 초 표기', () => {
    const cases = [
      [600_000, 600, 1_000_000, 997_000],
      [570_000, 600, 1_000_000, 1_000_000],
      [570_500, 600, 1_000_000, 999_400],
      [1_000, 600, 2_000, 0],
    ] as const;
    for (const [deadlineMs, hook, nowMs, arrivedMs] of cases) {
      expect(now.deadlineReasonOf(Math.round(deadlineMs / 1000), hook, Math.round((nowMs - arrivedMs) / 1000))).toBe(legacy.deadlineReason(deadlineMs, hook, nowMs, arrivedMs));
    }
  });
});

describe('Git 되돌리기 글', () => {
  it('되돌리지 못함·되돌림·알림·보관본', () => {
    const whichs = ['branch_changed', 'detached', 'foreign_commits', 'rewound', 'moved_during_action', "a'b", '한글\n줄'];
    const errors = ['', '오류', 'a\nb'];
    for (const which of whichs) {
      for (const error of errors) {
        expect(now.gitRealignUnrestorableMessage(which, error)).toBe(legacy.gitRealignUnrestorableMessage(which, error));
        expect(now.gitRealignFailureReason(which, error)).toBe(legacy.gitRealignFailureReason(which, error));
      }
      for (const filesLen of [0, 1, 5]) {
        for (const backupId of [undefined, 'b1', '한글-id']) {
          expect(now.gitRealignNotice(which, filesLen, backupId)).toBe(legacy.gitRealignNotice(which, filesLen, backupId));
          expect(now.gitRealignRestoredReason(which, filesLen, backupId)).toBe(legacy.gitRealignRestoredReason(which, filesLen, backupId));
        }
      }
    }
  });
});

describe('landedPlan: 남은 체크포인트 판정', () => {
  it('커밋 없음·목록 읽기 실패·HEAD 일치·불일치', () => {
    for (const committed of [undefined, 'a', 'b']) {
      for (const listed of [true, false]) {
        for (const latest of [undefined, 'a', 'b']) {
          expect(now.landedPlan(committed, listed, latest), JSON.stringify({ committed, listed, latest })).toEqual(legacy.landedPlan(committed, listed, latest));
        }
      }
    }
  });
});

describe('의도한 차이', () => {
  it('글자 자체에 든 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(옛 TS는 그대로 들고 있었다)', () => {
    const result = { report: undefined, checks: [], summary: '😀\n\ud83d', verifyAttempts: 0 } as unknown as AgentResult;
    const replaced = { ...result, summary: '😀\n\ufffd' } as unknown as AgentResult;
    expect(now.checkpointBody(result, false)).toBe(legacy.checkpointBody(replaced, false));
    expect(now.hookMessage('a\ude00b')).toBe(legacy.hookMessage('a\ufffdb'));
  });

  it('UTF-16으로 자른 자리가 서로게이트 짝을 가르면 napi 경계에서 U+FFFD가 된다(옛 TS는 짝 없는 단위를 그대로 들고 있었다)', () => {
    const feedback = 'a'.repeat(799) + '😀' + '꼬리';
    const clipped = legacy.clipText(feedback, 800);
    expect(clipped.includes('\ud83d')).toBe(true); // 짝의 앞 단위만 남는다
    const got = now.attemptsExhaustedSummary(1, 0, clipped, 3);
    const old = legacy.attemptsExhaustedSummary(1, 0, feedback, 3);
    expect(got).not.toBe(old);
    expect(got).toBe(old.replace('\ud83d', '\ufffd'));
  });
});
