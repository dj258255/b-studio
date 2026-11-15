import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { Gen, readEnvNumber } from './differential-kit';

/**
 * 러너 코어(Rust)는 CLI가 낸 줄을 `bstudio_guard::js_json::parse_lone_encoded`로 읽는다(ADR-202). 옛 구현은 `JSON.parse`였다.
 * 러너가 읽는 값이 같은지 본다: 숫자(경계·`-0`·큰 정수·지수), 서로게이트 이스케이프(짝 없는 것 포함), 중복 키(뒤 값이 이기고 자리는 처음 것), `__proto__`·`constructor` 같은 키, 키 순서(정수 꼴 키가 먼저).
 * 양쪽을 꼬리표 붙은 트리(`["num", "<글자>", 음의0]`)로 바꿔 견준다. 글자는 `encodeLoneSurrogates`한 꼴이다.
 */

type Tagged = ['null'] | ['bool', boolean] | ['num', string, boolean] | ['str', string] | ['arr', Tagged[]] | ['obj', Array<[string, Tagged]>];

/** `JSON.parse` 값을 Rust가 돌려주는 것과 같은 꼬리표 트리로 바꾼다(`Object.entries` 순서) */
function tag(value: unknown): Tagged {
  if (value === null) return ['null'];
  if (typeof value === 'boolean') return ['bool', value];
  if (typeof value === 'number') return ['num', String(value), Object.is(value, -0)];
  if (typeof value === 'string') return ['str', encodeLoneSurrogates(value)];
  if (Array.isArray(value)) return ['arr', value.map(tag)];
  return ['obj', Object.entries(value as Record<string, unknown>).map(([key, item]) => [encodeLoneSurrogates(key), tag(item)])];
}

function viaJs(line: string): Tagged | null | 'deep' {
  try {
    return tag(JSON.parse(line));
  } catch {
    return null;
  }
}

function viaRust(line: string): Tagged | null | 'deep' {
  const text = native.runnerParseLine(line);
  return text === null || text === undefined ? null : (JSON.parse(text) as Tagged | 'deep');
}

describe('러너가 읽는 줄: Rust(js_json)와 JSON.parse의 차등', () => {
  const FIXED = [
    // 숫자
    '0', '-0', '-0.0', '0.0', '1', '-1', '1e3', '1E3', '1e-3', '1.5e+2', '123456789012345678901234567890', '9007199254740993', '-9007199254740993', '0.1', '1e999', '-1e999', '1e-999', '5e-324', '2.2250738585072014e-308', '1.7976931348623157e308',
    '4.35', '4.349999999999999', '100', '1e21', '1e-7', '0.000001',
    // 문법 밖
    '01', '+1', '.5', '1.', '1e', 'NaN', 'Infinity', '-', '', ' ', '{', '[1,]', '{"a":1,}', "{'a':1}", '{"a":}', 'nul', 'tru', '"\\x"', '"\\u12"', '"a\nb"', '"\t"', '[1 2]', '{"a" 1}',
    // 공백
    ' [ 1 , 2 ] ', '\t{\n"a"\r:\t1}\n', '\u00a0 1', '\ufeff1',
    // 문자열과 이스케이프
    '"abc"', '"한글 😀"', '"\\ud83d\\ude00"', '"\\ud800"', '"\\udc00"', '"\\ud800\\ud800"', '"\\udc00\\ud800"', '"a\\ud800b"', '"\\ud83d"', '"\\u0000"', '"\\u2028\\u2029"', '"\\/\\b\\f\\n\\r\\t\\\\\\""', '"\\uE010\\uE000\\uE000\\uE000"', '"\\uE011"', '"\uE010"', '"\uE011\uE000"',
    // 키
    '{"a":1,"a":2}', '{"a":1,"b":2,"a":3}', '{"__proto__":1}', '{"__proto__":{"type":"result"}}', '{"constructor":{"x":1}}', '{"toString":"x"}', '{"2":1,"1":2,"b":3,"01":4}', '{"4294967294":1,"4294967295":2,"-1":3,"1e3":4}', '{"":1}', '{"\\u0000a":1}', '{"\\ud800":1}',
    // 중첩
    '[[[[]]]]', '{"a":{"b":{"c":[1,{"d":null}]}}}', '[null,true,false,0,"",[],{}]',
    // 러너가 읽는 모양
    '{"type":"system","subtype":"init","session_id":"s","mcp_servers":[{"name":"b-studio","status":"connected"}]}',
    '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t","name":"mcp__b-studio__read_file","input":{"path":"a"}}],"usage":{"input_tokens":1,"cache_read_input_tokens":2.5}},"parent_tool_use_id":null}',
    '{"type":"result","subtype":"success","is_error":false,"result":"x","modelUsage":{"m":{"inputTokens":3,"outputTokens":-0,"cacheReadInputTokens":1e2,"cacheCreationInputTokens":0}},"duration_api_ms":1234.5}',
    '{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":9007199254740993,"post_tokens":-0}}',
  ];

  for (const line of FIXED) {
    it(`고정 입력 ${JSON.stringify(line).slice(0, 70)}`, () => {
      expect(viaRust(line)).toEqual(viaJs(line));
    });
  }

  it('시드 있는 무작위 줄(문법 안과 문법을 깬 것을 섞는다)', () => {
    const count = readEnvNumber('B_STUDIO_RUNNER_JSON_CASES', 3_000);
    const g = new Gen(20_261_116);
    const digits = '0123456789';
    const number = (): string =>
      g.weighted<() => string>([
        [4, () => String(g.int(1_000))],
        [2, () => `-${g.int(1_000)}`],
        [2, () => `${g.int(100)}.${g.text([...digits], 1 + g.int(8))}`],
        [2, () => `${g.int(10)}e${g.pick(['', '+', '-'])}${g.int(330)}`],
        [1, () => g.text([...digits], 15 + g.int(15))],
        [1, () => '-0'],
        [1, () => `${g.int(9)}.${g.text([...digits], 17)}e${g.int(40)}`],
      ])();
    const str = () => `"${g.text(['a', 'b', '한', '😀', '\\n', '\\"', '\\\\', '\\u0041', '\\ud800', '\\udc00', '\\ud83d\\ude00', ' ', '\\uE010', '\uE010', '\uE011', '\u2028'], g.int(7))}"`;
    const value = (depth: number): string =>
      g.weighted<() => string>([
        [3, number],
        [3, str],
        [1, () => 'null'],
        [1, () => g.pick(['true', 'false'])],
        [depth > 0 ? 2 : 0, () => `[${g.list(0, 3, () => value(depth - 1)).join(',')}]`],
        [depth > 0 ? 2 : 0, () => `{${g.list(0, 4, () => `${g.pick(['"a"', '"b"', '"__proto__"', '"constructor"', '"1"', '"0"', '"x"', '"\\ud800"', '"é"'])}:${value(depth - 1)}`).join(',')}}`],
      ])();
    const break_ = (text: string): string => {
      if (text.length === 0 || !g.chance(0.25)) return text;
      const at = g.int(text.length);
      return g.pick([text.slice(0, at), text.slice(0, at) + text.slice(at + 1), `${text.slice(0, at)}${g.pick([',', '}', ']', '"', '\\', ' ', '\u0000'])}${text.slice(at)}`]);
    };
    for (let i = 0; i < count; i++) {
      // CLI가 낸 줄은 UTF-8 바이트를 푼 글이라 짝 없는 서로게이트가 없다(글자 가운데를 자른 줄은 U+FFFD로 바꾼다)
      const line = break_(g.chance(0.7) ? `{"v":${value(3)},"k":${value(2)}}` : value(3)).toWellFormed();
      expect(viaRust(line), line).toEqual(viaJs(line));
    }
  });

  it('너무 깊게 중첩된 줄은 읽지 않았다고 알린다(JS는 읽는다: 러너는 이 줄을 건너뛰지 않고 실행을 실패로 끝낸다)', () => {
    const deep = `{"a":${'['.repeat(3_000)}1${']'.repeat(3_000)}}`;
    expect(viaRust(deep)).toBe('deep');
    expect(() => JSON.parse(deep)).not.toThrow();
  });
});
