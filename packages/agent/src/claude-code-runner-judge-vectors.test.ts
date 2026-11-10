import { describe, expect, it } from 'vitest';
import { ClaudeCodeUsageTracker, describeResultFailure, isTransientNetworkFailure, mcpSetupFailure, noResultMessage, resolveCompactWindow } from './claude-code-runner';
import * as legacy from './claude-code-runner-legacy';
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';

/**
 * 러너 판정·사용량 벡터(ADR-191 3ac). 기대값은 옛 TS(`claude-code-runner-legacy.ts`)가 낸 값이다. 옛 TS에서 다른 것은 `intended`로 표시한 의도한 차이뿐이고,
 * 모두 옛 TS가 던지거나 열린 쪽(실패를 성공으로)으로 틀린 곳이다(트러블슈팅 179).
 * 결과 메시지는 "성공이 확실할 때만 undefined"이고, 도구 서버는 "connected이고 오류가 없을 때만 undefined"이다. 각 통과 조건마다 거의 같은 거부 입력을 둔다.
 */

type Ran = { threw: true } | { threw: false; value: unknown };
const ran = (fn: () => unknown): Ran => {
  try {
    return { threw: false, value: fn() };
  } catch {
    return { threw: true };
  }
};

interface Case<T> {
  label: string;
  input: T;
  /** 새 구현의 기대 */
  expected: unknown;
  /** 옛 구현이 다르게 읽는 의도한 차이: 옛 구현의 결과(던지면 'THROW') */
  intended?: unknown;
}

function check<T>(name: string, cases: Array<Case<T>>, now: (input: T) => unknown, before: (input: T) => unknown): void {
  describe(name, () => {
    for (const { label, input, expected, intended } of cases) {
      it(`새 구현: ${label}`, () => {
        expect(JSON.stringify(now(input))).toBe(JSON.stringify(expected));
      });
      it(`옛 구현: ${label}`, () => {
        const old = ran(() => before(input));
        if (intended !== undefined) {
          // 'THROW': 옛 구현이 던진다. 'SUCCESS': 옛 구현이 성공(undefined)으로 읽는다
          expect(old.threw ? 'THROW' : old.value === undefined ? 'SUCCESS' : JSON.stringify(old.value)).toBe(intended === 'THROW' || intended === 'SUCCESS' ? intended : JSON.stringify(intended));
        } else {
          expect(old.threw).toBe(false);
          expect(JSON.stringify((old as { value: unknown }).value)).toBe(JSON.stringify(expected));
        }
      });
    }
  });
}

type Msg = never;
const result = (value: unknown): Msg => value as Msg;

check(
  'describeResultFailure',
  [
    { label: '성공', input: result({ subtype: 'success', is_error: false, result: 'ok' }), expected: undefined },
    { label: '성공(is_error 없음)', input: result({ subtype: 'success' }), expected: undefined },
    { label: 'is_error true', input: result({ subtype: 'success', is_error: true, result: 'x' }), expected: '모델 호출이 실패했습니다: x' },
    { label: 'is_error true, result 없음', input: result({ subtype: 'success', is_error: true }), expected: '모델 호출이 실패했습니다: ' },
    { label: 'is_error 1(참 같은 값)', input: result({ subtype: 'success', is_error: 1, result: 'x' }), expected: '모델 호출이 실패했습니다: x' },
    { label: 'is_error "false"(문자열은 참)', input: result({ subtype: 'success', is_error: 'false' }), expected: '모델 호출이 실패했습니다: ' },
    { label: 'is_error 0', input: result({ subtype: 'success', is_error: 0 }), expected: undefined },
    { label: 'is_error null', input: result({ subtype: 'success', is_error: null }), expected: undefined },
    { label: 'is_error ""', input: result({ subtype: 'success', is_error: '' }), expected: undefined },
    { label: 'is_error {}(객체는 참)', input: result({ subtype: 'success', is_error: {} }), expected: '모델 호출이 실패했습니다: ' },
    { label: 'result가 숫자', input: result({ subtype: 'success', is_error: true, result: 5 }), expected: '모델 호출이 실패했습니다: 5' },
    { label: 'result가 null(빈 글자)', input: result({ subtype: 'success', is_error: true, result: null }), expected: '모델 호출이 실패했습니다: ' },
    { label: '거절', input: result({ subtype: 'success', stop_reason: 'refusal' }), expected: '모델이 요청을 거절했습니다' },
    { label: '거절 대소문자', input: result({ subtype: 'success', stop_reason: 'Refusal' }), expected: undefined },
    { label: '거절 뒤 공백', input: result({ subtype: 'success', stop_reason: 'refusal ' }), expected: undefined },
    { label: 'end_turn', input: result({ subtype: 'success', stop_reason: 'end_turn' }), expected: undefined },
    { label: '최대 턴', input: result({ subtype: 'error_max_turns' }), expected: 'Claude Code의 최대 턴 수를 넘었습니다' },
    { label: '비용 한도', input: result({ subtype: 'error_max_budget_usd' }), expected: 'Claude Code의 비용 한도를 넘었습니다' },
    { label: 'subtype 대소문자(Success)', input: result({ subtype: 'Success' }), expected: 'Claude Code 실행 중 오류가 났습니다' },
    { label: 'subtype 앞 공백', input: result({ subtype: ' success' }), expected: 'Claude Code 실행 중 오류가 났습니다' },
    { label: 'subtype 뒤 글자', input: result({ subtype: 'success2' }), expected: 'Claude Code 실행 중 오류가 났습니다' },
    { label: '모르는 subtype(other)', input: result({ subtype: 'other' }), expected: 'Claude Code 실행 중 오류가 났습니다' },
    { label: 'subtype 없음', input: result({}), expected: 'Claude Code 실행 중 오류가 났습니다' },
    { label: 'subtype null', input: result({ subtype: null }), expected: 'Claude Code 실행 중 오류가 났습니다' },
    { label: 'subtype 숫자', input: result({ subtype: 1 }), expected: 'Claude Code 실행 중 오류가 났습니다' },
    { label: '실행 중 오류 + errors', input: result({ subtype: 'error_during_execution', errors: ['a', 'b'] }), expected: 'Claude Code 실행 중 오류가 났습니다: a; b' },
    { label: '빈 errors', input: result({ subtype: 'error_during_execution', errors: [] }), expected: 'Claude Code 실행 중 오류가 났습니다' },
    { label: 'errors 안의 null·숫자', input: result({ subtype: 'x', errors: [null, 3, 'z'] }), expected: 'Claude Code 실행 중 오류가 났습니다: ; 3; z' },
    { label: 'errors가 문자열(옛 TS는 던졌다)', input: result({ subtype: 'x', errors: 'abc' }), expected: 'Claude Code 실행 중 오류가 났습니다', intended: 'THROW' },
    { label: 'errors가 객체', input: result({ subtype: 'x', errors: { a: 1 } }), expected: 'Claude Code 실행 중 오류가 났습니다' },
  ],
  (message) => describeResultFailure(message),
  (message) => legacy.describeResultFailure(message),
);

const init = (servers: unknown, errors?: unknown): never => ({ mcp_servers: servers, ...(errors === undefined ? {} : { mcp_server_errors: errors }) }) as never;
const ok = { name: 'b-studio', status: 'connected' };
check(
  'mcpSetupFailure',
  [
    { label: '연결됨', input: init([ok]), expected: undefined },
    { label: '연결됨 + 빈 오류', input: init([ok], []), expected: undefined },
    { label: '연결됨 + 다른 서버 오류', input: init([ok], [{ name: 'other', message: 'x' }]), expected: undefined },
    { label: '연결됨 + 이 서버 오류', input: init([ok], [{ name: 'b-studio', message: 'boom' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: boom' },
    { label: '연결됨 + 이름 없는 오류', input: init([ok], [{ message: 'boom' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: boom' },
    { label: '연결됨 + 오류 type만', input: init([ok], [{ type: 'timeout' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: timeout' },
    { label: '연결됨 + 오류 빈 message', input: init([ok], [{ message: '' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다' },
    { label: '연결됨 + 오류에 내용 없음', input: init([ok], [{}]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: connected' },
    { label: '연결됨 + 이름이 null인 오류(옛 TS는 다른 서버로 보고 버렸다)', input: init([ok], [{ name: null, message: 'boom' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: boom', intended: 'SUCCESS' },
    { label: '연결됨 + 이름이 숫자인 오류(옛 TS는 버렸다)', input: init([ok], [{ name: 5, message: 'boom' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: boom', intended: 'SUCCESS' },
    { label: '오류 이름 대소문자(B-Studio는 다른 서버)', input: init([ok], [{ name: 'B-Studio', message: 'x' }]), expected: undefined },
    { label: '오류 이름 뒤 공백(다른 서버)', input: init([ok], [{ name: 'b-studio ', message: 'x' }]), expected: undefined },
    { label: '상태 pending', input: init([{ name: 'b-studio', status: 'pending' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: pending' },
    { label: '상태 failed', input: init([{ name: 'b-studio', status: 'failed' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: failed' },
    { label: '상태 needs-auth', input: init([{ name: 'b-studio', status: 'needs-auth' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: needs-auth' },
    { label: '상태 Connected(대소문자)', input: init([{ name: 'b-studio', status: 'Connected' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: Connected' },
    { label: '상태 "connected "(뒤 공백)', input: init([{ name: 'b-studio', status: 'connected ' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: connected ' },
    { label: '상태 없음', input: init([{ name: 'b-studio' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 목록에 없음' },
    { label: '서버 이름 대소문자(B-Studio)', input: init([{ name: 'B-Studio', status: 'connected' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 목록에 없음' },
    { label: '서버 이름 접두(b-studio-x)', input: init([{ name: 'b-studio-x', status: 'connected' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 목록에 없음' },
    { label: '목록에 없음', input: init([{ name: 'other', status: 'connected' }]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 목록에 없음' },
    { label: '목록 자체가 없음', input: {} as never, expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 목록에 없음' },
    { label: '목록이 빈 배열', input: init([]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 목록에 없음' },
    { label: '중복 항목은 첫 번째', input: init([{ name: 'b-studio', status: 'failed' }, ok]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: failed' },
    { label: '숫자 항목은 건너뛴다', input: init([5, ok]), expected: undefined },
    { label: '항목이 null(옛 TS는 던졌다)', input: init([null, ok]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 도구 서버 목록의 형식을 읽지 못했습니다', intended: 'THROW' },
    { label: '오류 항목이 null(옛 TS는 던졌다)', input: init([ok], [null]), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 도구 서버 목록의 형식을 읽지 못했습니다', intended: 'THROW' },
    { label: '목록이 문자열(옛 TS는 던졌다)', input: init('b-studio'), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 도구 서버 목록의 형식을 읽지 못했습니다', intended: 'THROW' },
    { label: '오류 목록이 객체(옛 TS는 던졌다)', input: init([ok], { name: 'x' }), expected: 'Claude Code가 b-studio 도구 서버에 연결하지 못했습니다: 도구 서버 목록의 형식을 읽지 못했습니다', intended: 'THROW' },
  ],
  (message) => mcpSetupFailure(message),
  (message) => legacy.mcpSetupFailure(message),
);

describe('resolveCompactWindow', () => {
  const raws: Array<string | undefined> = [undefined, '', '  ', '0', 'off', 'OFF', 'Off', ' off ', 'of', 'offf', '49999', '50000', '50001', '200000', '9007199254740991', '9007199254740992', '99999999999999999999999999999999999999999', '0050000', '00', '000', '1e5', '5e4', '+50000', '-50000', '50000.0', '5０000', '５００００', '50_000', '0x10000', 'ſ', '\u0085 60000 \u0085', '﻿60000', 'abc', '١٢٣٤٥٦'];
  for (const raw of raws) {
    it(`${JSON.stringify(raw)}`, () => {
      expect(JSON.stringify(resolveCompactWindow(raw))).toBe(JSON.stringify(legacy.resolveCompactWindow(raw)));
    });
  }
});

describe('isTransientNetworkFailure', () => {
  const messages = ['getaddrinfo ENOTFOUND api.anthropic.com', 'read ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', "Can't reach the API server", "can't reach the api server", 'Can’t reach the API server', 'overloaded_error', 'API is overloaded', 'overloaded', 'Overloaded.', 'overloadedx', 'xoverloaded', '_overloaded', 'overloaded_', 'overloaded1', '1overloaded', 'enotfound', 'ENOTFOUNDx', 'ENOT FOUND', 'enotfounD', 'ſ', 'ENOTFOUND'.replace('O', 'Ο'), 'K', '401 invalid x-api-key', 'rate_limit_error', '', 'overloadedoverloaded', 'overloaded overloaded', 'xoverloaded overloaded'];
  for (const message of messages) {
    it(JSON.stringify(message), () => {
      expect(isTransientNetworkFailure(message)).toBe(legacy.isTransientNetworkFailure(message));
    });
  }
});

describe('noResultMessage', () => {
  const exits: Array<Parameters<typeof legacy.noResultMessage>[0]> = [
    undefined,
    { code: 0, signal: null, stderr: '' },
    { code: 1, signal: null, stderr: 'a\nb\nc\nd\n' },
    { code: null, signal: null, stderr: '  boom  ' },
    { code: null, signal: 'SIGTERM', stderr: '' },
    { code: 2, signal: 'SIGKILL', stderr: 'x' },
    { code: -1, signal: null, stderr: 'a\r\nb' },
    { code: 1.5, signal: null, stderr: '\u0085trim\u0085' },
    { code: null, signal: null, error: new Error('spawn x ENOENT'), stderr: 'tail' },
    { code: null, signal: null, error: Object.assign(new Error(''), { code: 'EACCES' }), stderr: '' },
  ];
  exits.forEach((exit, index) => {
    it(`입력 ${index}`, () => {
      expect(noResultMessage(exit)).toBe(legacy.noResultMessage(exit));
    });
  });
});

describe('사용량', () => {
  const usages: unknown[] = [
    {},
    { modelUsage: {} },
    { modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } } },
    { modelUsage: { a: { inputTokens: 0.1, outputTokens: 0.2 }, b: { inputTokens: 0.2 } } },
    { modelUsage: { a: { inputTokens: 1e300 }, b: { inputTokens: 1e300 } } },
    { modelUsage: { a: { inputTokens: null, outputTokens: null } } },
    { modelUsage: { a: {} } },
    { modelUsage: { b: { inputTokens: 5 }, a: { inputTokens: 7 }, 2: { inputTokens: 1 }, 1: { inputTokens: 2 } } },
    { modelUsage: [{ inputTokens: 1 }, { inputTokens: 2 }] },
    { modelUsage: null },
    { modelUsage: 5 },
    { modelUsage: { a: 5 } },
    { modelUsage: { a: { inputTokens: -1 } } },
    { modelUsage: { a: { inputTokens: Number.NaN } } },
    { modelUsage: { a: { inputTokens: Number.POSITIVE_INFINITY } } },
    { modelUsage: { a: { inputTokens: -0 } } },
  ];
  usages.forEach((message, index) => {
    it(`결과 ${index}: 합·모델별·합산`, () => {
      const tracker = new ClaudeCodeUsageTracker();
      const old = new legacy.ClaudeCodeUsageTracker();
      tracker.observeResult(message as never);
      old.observeResult(message as never);
      expect(JSON.stringify(tracker.usage)).toBe(JSON.stringify(old.usage));
      expect(JSON.stringify(tracker.usageByModel)).toBe(JSON.stringify(old.usageByModel));
      expect(Object.is(tracker.usage.inputTokens, old.usage.inputTokens)).toBe(true);
    });
  });

  it('null 항목은 옛 구현도 던진다(같은 자리에서 던진다)', () => {
    const message = { modelUsage: { a: null } } as never;
    expect(() => new legacy.ClaudeCodeUsageTracker().observeResult(message)).toThrow();
    expect(() => new ClaudeCodeUsageTracker().observeResult(message)).toThrow();
  });

  it('observeResult는 누적값이라 더하지 않고 바꾼다', () => {
    const tracker = new ClaudeCodeUsageTracker();
    tracker.observeResult({ modelUsage: { a: { inputTokens: 10 } } } as never);
    tracker.observeResult({ modelUsage: { a: { inputTokens: 3 } } } as never);
    expect(tracker.usage.inputTokens).toBe(3);
    tracker.observeResult({} as never);
    expect(tracker.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('API 시간', () => {
    for (const value of [undefined, 0, -0, 1.4, 1.5, 2.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, 1e21, 0.49999999999999994, 4503599627370495.5]) {
      const now = native.runnerApiDurationOf(encodeNative(value ?? null));
      const old = legacy.apiDurationOf({ duration_api_ms: value } as never);
      expect(Object.is(now ?? undefined, old), String(value)).toBe(true);
    }
  });

  it('모델별 합치기', () => {
    const base = { a: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, b: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const query = { b: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 }, c: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9 } };
    const now = decodeNative(native.runnerMergeUsageByModel(encodeNative(base), encodeNative(query)));
    expect(JSON.stringify(now)).toBe(JSON.stringify(legacy.mergeUsageByModel(base, query)));
    expect(JSON.stringify(decodeNative(native.runnerMergeUsageByModel(encodeNative({}), encodeNative(query))))).toBe(JSON.stringify(legacy.mergeUsageByModel({}, query)));
    const target = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
    const old = { ...target };
    legacy.addUsageInto(old, query.b);
    expect(decodeNative(native.runnerAddUsage(encodeNative(target), encodeNative(query.b)))).toEqual(old);
  });

  it('의도한 차이: 문자열 토큰 수·문자열 modelUsage·__proto__ 모델', () => {
    const asString = { modelUsage: { a: { inputTokens: '5' } } } as never;
    const old = new legacy.ClaudeCodeUsageTracker();
    old.observeResult(asString);
    expect(old.usage.inputTokens).toBe('05'); // 옛 구현은 문자열을 이어 붙였다
    const now = new ClaudeCodeUsageTracker();
    now.observeResult(asString);
    expect(now.usage.inputTokens).toBe(5);
    const text = new ClaudeCodeUsageTracker();
    text.observeResult({ modelUsage: 'ab' } as never);
    expect(text.usageByModel).toEqual({});
    expect(Object.keys(new legacy.ClaudeCodeUsageTracker().usageByModel)).toEqual([]);
    const proto = JSON.parse('{"modelUsage":{"__proto__":{"inputTokens":4}}}') as never;
    const protoNow = new ClaudeCodeUsageTracker();
    protoNow.observeResult(proto);
    expect(Object.keys(protoNow.usageByModel)).toEqual(['__proto__']);
    const protoOld = new legacy.ClaudeCodeUsageTracker();
    protoOld.observeResult(proto);
    expect(Object.keys(protoOld.usageByModel)).toEqual([]);
  });
});
