import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { pickStaleTemp, restoreDatabaseName } from './database-branches';
import { legacyNormalizedDumpHashFromStream, legacyRestoreDatabaseName, legacySweepVictims } from './database-branches-legacy';
import { summarizeJsonContent } from './json-summary';
import { legacySummarizeJsonContent } from './json-summary-legacy';
import { appendUserText, formatSteering } from './loop';
import { legacyAppendUserText, legacyFormatSteering } from './loop-legacy';
import { validateTaskGraph, type TaskNode } from './task-graph';
import { legacyValidateGraph } from './task-graph-legacy';

/**
 * 작은 판정 모음(ADR-191 3af)의 벡터. 기대값은 옛 TS가 낸 값이다. 옛 TS와 다르게 정한 것(의도한 차이)은 `old`에 옛 값을 따로 적어
 * 옛 TS가 정말 그 값을 내는지(= 고친 결함이 실제로 있었는지)도 이 시험이 확인한다.
 */
const newHash = (bytes: Buffer, step = 0): string => {
  const normalizer = new native.NativeDumpNormalizer();
  const hash = createHash('sha256');
  const chunks = step > 0 ? Array.from({ length: Math.ceil(bytes.length / step) }, (_, i) => bytes.subarray(i * step, (i + 1) * step)) : [bytes];
  for (const chunk of chunks) hash.update(normalizer.feed(chunk));
  hash.update(normalizer.finish());
  return hash.digest('hex');
};
const oldHash = (bytes: Buffer) => legacyNormalizedDumpHashFromStream(Readable.from([bytes]));
const b = (text: string) => Buffer.from(text, 'utf8');

interface DumpVector {
  name: string;
  a: Buffer;
  c: Buffer;
  /** 새 판정이 두 덤프를 "같다"고 보는가 */
  equal: boolean;
  /** 옛 판정의 값(생략하면 새 값과 같다). 다르면 의도한 차이 */
  old?: boolean;
}

const DUMP_VECTORS: DumpVector[] = [
  { name: '같은 덤프', a: b('SELECT 1;\n'), c: b('SELECT 1;\n'), equal: true },
  { name: '무작위 키만 다른 restrict 줄', a: b('\\restrict AAA\nSELECT 1;\n\\unrestrict AAA\n'), c: b('\\restrict BBB\nSELECT 1;\n\\unrestrict BBB\n'), equal: true },
  { name: 'restrict 줄이 있는 덤프와 없는 덤프', a: b('\\restrict K\nx\n'), c: b('x\n'), equal: true },
  { name: 'restrict 줄 끝이 CRLF', a: b('\\restrict K\r\nx\n'), c: b('x\n'), equal: true },
  { name: 'restrict 줄 끝이 CR', a: b('x\n\\restrict K\ry\n'), c: b('x\ny\n'), equal: true },
  { name: '끝 개행 없는 마지막 restrict 줄', a: b('x\n\\restrict K'), c: b('x\n'), equal: true },
  { name: '공백 없는 \\restrict는 남는다', a: b('\\restrict\nx\n'), c: b('x\n'), equal: false },
  { name: '\\restricted는 남는다', a: b('\\restricted K\nx\n'), c: b('x\n'), equal: false },
  { name: '앞에 공백이 있는 restrict는 남는다', a: b(' \\restrict K\nx\n'), c: b('x\n'), equal: false },
  { name: '대문자 \\Restrict는 남는다', a: b('\\Restrict K\nx\n'), c: b('x\n'), equal: false },
  { name: '\\\\restrict(이스케이프된 역슬래시)는 남는다', a: b('\\\\restrict K\nx\n'), c: b('x\n'), equal: false },
  { name: '\\unrestrict 대문자 U는 남는다', a: b('\\Unrestrict K\nx\n'), c: b('x\n'), equal: false },
  { name: '\\restrict 뒤 NBSP는 빼는 줄', a: b('\\restrict\u00a0K\nx\n'), c: b('x\n'), equal: true },
  { name: '\\restrict 뒤 U+2028은 빼는 줄(readline은 U+2028에서 끊지 않는다)', a: b('\\restrict\u2028K\nx\n'), c: b('x\n'), equal: true },
  { name: '\\restrict 뒤 U+0085는 공백이 아니라 남는다', a: b('\\restrict\u0085K\nx\n'), c: b('x\n'), equal: false },
  { name: '\\restrict 뒤 잘못된 UTF-8 바이트는 남는다', a: Buffer.concat([b('\\restrict'), Buffer.from([0xff]), b('K\nx\n')]), c: b('x\n'), equal: false },
  { name: '데이터 한 글자가 다름', a: b('INSERT 1\n'), c: b('INSERT 2\n'), equal: false },
  { name: '빈 줄이 하나 더 있음', a: b('a\nb\n'), c: b('a\n\nb\n'), equal: false },
  { name: 'restrict 줄 사이로 CR과 LF가 이어져도 빈 줄은 따로 센다(CRLF로 합치지 않는다)', a: b('x\r\n'), c: b('x\r\\restrict k\r\n\n'), equal: false },
  { name: '빈 덤프', a: b(''), c: b(''), equal: true },
  { name: '빈 덤프와 빈 줄 하나', a: b(''), c: b('\n'), equal: false },
  // ── 의도한 차이: 옛 판정은 같다고 봤다(readline이 줄 끝 글자를 버린다). 새 판정은 다르다고 본다(닫는 쪽)
  { name: '의도한 차이: LF와 CRLF', a: b('a\nb\n'), c: b('a\r\nb\n'), equal: false, old: true },
  { name: '의도한 차이: LF와 CR(값 안의 CR을 LF로 바꾼 덤프)', a: b('a\nb\n'), c: b('a\rb\n'), equal: false, old: true },
  { name: '의도한 차이: 마지막 줄 끝 개행 유무', a: b('a\nb\n'), c: b('a\nb'), equal: false, old: true },
  { name: '의도한 차이: 잘못된 UTF-8 바이트 둘(옛 판정은 모두 U+FFFD)', a: Buffer.from([0x61, 0xff, 0x0a]), c: Buffer.from([0x61, 0xfe, 0x0a]), equal: false, old: true },
];

describe('덤프 정규화 벡터', () => {
  for (const vector of DUMP_VECTORS) {
    it(vector.name, async () => {
      expect(newHash(vector.a) === newHash(vector.c)).toBe(vector.equal);
      // 아무 자리에서 끊어 먹여도 같다
      for (const step of [1, 2, 3, 7]) expect(newHash(vector.a, step)).toBe(newHash(vector.a));
      expect((await oldHash(vector.a)) === (await oldHash(vector.c))).toBe(vector.old ?? vector.equal);
    });
  }

  it('의도한 차이는 모두 옛 판정이 같다고 보고 새 판정이 다르다고 보는 쪽이다(옛 TS에서 실패하는 벡터 수)', () => {
    const intended = DUMP_VECTORS.filter((vector) => vector.old !== undefined);
    expect(intended.length).toBe(4);
    expect(intended.every((vector) => vector.old === true && vector.equal === false)).toBe(true);
  });

  it('긴 줄을 조각으로 먹여도 같은 값이고 앞부분만 쥔다', () => {
    const long = Buffer.concat([b('x'.repeat(300_000)), b('\n'), b('y\n')]);
    expect(newHash(long, 65536)).toBe(newHash(long));
    expect(newHash(long, 1)).toBe(newHash(long));
  });
});

// ── 임시 DB 이름 ──────────────────────────────────────────────────────────────────────────────────
describe('임시 DB 이름 벡터', () => {
  const longName = (n: number) => 'x'.repeat(n);
  const cases: Array<[string, string]> = [
    ['', ''],
    ['app', 'app'],
    [longName(44), longName(44)],
    [longName(45), longName(45)],
    [longName(46), longName(45)],
    [longName(63), longName(45)],
    [longName(200), longName(45)],
    ['가'.repeat(46), '가'.repeat(45)],
    [`${longName(43)}😀`, `${longName(43)}😀`],
    [`${longName(44)}😀`, `${longName(44)}\ud83d`],
    [`${longName(45)}😀`, longName(45)],
    [`${longName(44)}\ud83d`, `${longName(44)}\ud83d`],
    [`${longName(44)}\ude00z`, `${longName(44)}\ude00`],
    [`${longName(44)}\ue010`, `${longName(44)}\ue010`],
    [`${longName(44)}\ue011\ue000`, `${longName(44)}\ue011`],
    ['\ud800\udc00', '\ud800\udc00'],
  ];
  for (const [name, kept] of cases) {
    it(`${JSON.stringify(name.slice(0, 20))}(길이 ${name.length})`, () => {
      expect(restoreDatabaseName(name)).toBe(`${kept}__b_studio_restore`);
      expect(legacyRestoreDatabaseName(name)).toBe(`${kept}__b_studio_restore`);
    });
  }
});

// ── 임시 파일 이름(지우는 코드) ────────────────────────────────────────────────────────────────────
describe('임시 파일 이름 벡터(모든 pid가 죽었다고 가정)', () => {
  const dead = () => false;
  const names = {
    지움: ['abcdef0.save.123.1.tmp', 'abcdef0.changed.2147483646.1700000000000.tmp', 'abcdef0.restore.7.1.tmp', '0123456789abcdef0123456789abcdef01234567.save.2147483647.1.tmp'],
    // 옛 판정이 지우던 것 중 지우지 않게 바꾼 것(의도한 차이, 모두 닫는 쪽): pid를 못 읽었거나 Number가 관대하게 읽은 이름
    지우지않음_옛판정은지움: ['x.tmp', 'notes.tmp', 'abcdef0.save.0x10.1.tmp', 'abcdef0.save.1e3.1.tmp', 'abcdef0.save. 12 .1.tmp', 'abcdef0.save.+5.1.tmp', 'abcdef0.save.99999999999999999999.1.tmp', 'abcdef0.save.2147483648.1.tmp', 'abcdef0.save.007.1.tmp', 'abcdef0.other.12.1.tmp', 'abcdef0.save.12.x.tmp', 'abcdef0.save.12..tmp', `${'a'.repeat(41)}.save.12.1.tmp`, 'abcdef0.save.0.1.tmp', 'abcdef0.save.-5.1.tmp', 'abcdef0.save..1.tmp', '\ud800.tmp', 'ABCDEF0.save.12.1.tmp', 'abcdef.save.12.1.tmp', 'a.b.tmp', 'abcdef0.save.12.tmp'],
    // 옛 판정도 지우지 않던 것
    지우지않음_옛판정도: ['abcdef0.save.123.1.TMP', 'abcdef0.save.123.1.tmp ', 'abcdef0.save.123.1.tmp\u200b', 'abcdef0.save.123.1', 'abcdef0.save.123.1.tmp.bak', 'dump.sql'],
  };
  it('지우는 이름', () => {
    expect(pickStaleTemp(names.지움, dead)).toEqual(names.지움);
    expect(legacySweepVictims(names.지움, dead)).toEqual(names.지움);
  });
  it('의도한 차이: 옛 판정은 지우고 새 판정은 지우지 않는 이름(옛 TS에서 실패하는 벡터)', () => {
    expect(pickStaleTemp(names.지우지않음_옛판정은지움, dead)).toEqual([]);
    // 옛 판정은 `.tmp`로 끝나면서 pid가 양의 정수로 읽히거나 pid를 못 읽은 이름을 모두 지운다(`abcdef0.save.12.tmp`는 pid 자리가 'abcdef0'이라 못 읽어 지운다)
    expect(legacySweepVictims(names.지우지않음_옛판정은지움, dead)).toEqual(names.지우지않음_옛판정은지움);
  });
  it('옛 판정도 지우지 않던 이름은 새 판정도 지우지 않는다', () => {
    expect(pickStaleTemp(names.지우지않음_옛판정도, dead)).toEqual([]);
    expect(legacySweepVictims(names.지우지않음_옛판정도, dead)).toEqual([]);
  });
  it('살아 있는 pid의 파일은 남기고, 이 프로세스의 pid는 늘 남긴다', () => {
    expect(pickStaleTemp(['abcdef0.save.123.1.tmp', 'abcdef0.save.124.1.tmp'], (pid) => pid === 123)).toEqual(['abcdef0.save.124.1.tmp']);
    expect(pickStaleTemp([`abcdef0.changed.${process.pid}.1.tmp`])).toEqual([]);
  });
  it('짝 없는 서로게이트가 든 이름은 지우지 않는다(U+FFFD로 합쳐져 다른 이름처럼 읽히지 않게)', () => {
    expect(pickStaleTemp(['abcdef0.save.123.1.tmp\ud800', '\ud800abcdef0.save.123.1.tmp', 'abcdef0.save.123.\udc00.tmp'], dead)).toEqual([]);
  });
});

// ── 작업 그래프 ───────────────────────────────────────────────────────────────────────────────────
describe('작업 그래프 벡터', () => {
  const run = async () => undefined;
  const g = (spec: Array<[string, string[]?]>): TaskNode[] => spec.map(([id, dependsOn]) => ({ id, dependsOn, run }));
  const outcome = (fn: () => void) => {
    try {
      fn();
      return 'ok';
    } catch (error) {
      return (error as Error).message;
    }
  };
  const cases: Array<[string, TaskNode[], string]> = [
    ['빈 그래프', [], 'ok'],
    ['의존 없는 노드', g([['a'], ['b']]), 'ok'],
    ['사슬', g([['a'], ['b', ['a']], ['c', ['b']]]), 'ok'],
    ['선언 순서가 거꾸로인 사슬', g([['c', ['b']], ['b', ['a']], ['a']]), 'ok'],
    ['마름모', g([['a'], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]]), 'ok'],
    ['같은 의존성 두 번', g([['a'], ['b', ['a', 'a']]]), 'ok'],
    ['id 중복', g([['a'], ['a']]), 'task id가 중복됩니다'],
    ['id 중복이 다른 검사보다 먼저', g([['a', ['a']], ['a', ['zz']]]), 'task id가 중복됩니다'],
    ['없는 의존성', g([['a', ['x']]]), "a: 없는 의존성 'x'"],
    ['없는 의존성은 순환보다 먼저', g([['a', ['b']], ['b', ['a', 'zz']]]), "b: 없는 의존성 'zz'"],
    ['없는 의존성은 노드 순서의 처음 것', g([['a', ['q']], ['b', ['r']]]), "a: 없는 의존성 'q'"],
    ['자기 자신', g([['a', ['a']]]), '순환 의존성이 있습니다: a'],
    ['둘이 서로', g([['a', ['b']], ['b', ['a']]]), '순환 의존성이 있습니다: a'],
    ['세 개 순환(앞에 무관한 노드)', g([['x'], ['b', ['c']], ['c', ['d']], ['d', ['b']]]), '순환 의존성이 있습니다: b'],
    ['빈 id', g([['', ['']]]), '순환 의존성이 있습니다: '],
    ['id가 따옴표를 품음', g([['it\'s', ["it's"]]]), "순환 의존성이 있습니다: it's"],
  ];
  for (const [name, nodes, expected] of cases) {
    it(name, () => {
      expect(outcome(() => validateTaskGraph(nodes))).toBe(expected);
      expect(outcome(() => legacyValidateGraph(nodes))).toBe(expected);
    });
  }

  it('짝 없는 서로게이트 id: 서로 다른 id가 합쳐져 중복으로 보이지 않고, 메시지에 글자 그대로 나온다', () => {
    expect(outcome(() => validateTaskGraph(g([['\ud800'], ['\udc00']])))).toBe('ok');
    expect(outcome(() => validateTaskGraph(g([['\ud800'], ['\ud800']])))).toBe('task id가 중복됩니다');
    expect(outcome(() => validateTaskGraph(g([['a', ['\ud800']]])))).toBe("a: 없는 의존성 '\ud800'");
    expect(outcome(() => validateTaskGraph(g([['\udc00', ['\udc00']]])))).toBe('순환 의존성이 있습니다: \udc00');
    // \ud800은 있고 \udc00만 없는 의존성: 합쳐지면 "있다"로 읽혀 통과한다(열린 쪽)
    expect(outcome(() => validateTaskGraph(g([['\ud800'], ['b', ['\udc00']]])))).toBe("b: 없는 의존성 '\udc00'");
    expect(outcome(() => validateTaskGraph(g([['\ue010'], ['\ue011']])))).toBe('ok');
  });

  it('성질 시험: 인코딩 없이 보내면 서로 다른 서로게이트 id가 합쳐지고, 껍데기는 합치지 않는다', () => {
    const raw = JSON.stringify([{ id: '\ud800' }, { id: '\udc00' }]);
    // JSON.stringify는 짝 없는 서로게이트를 \ud800 이스케이프로 쓰므로 Rust가 U+FFFD로 읽는다
    expect(native.agentTaskGraphError(raw)).toBe('task id가 중복됩니다');
    expect(outcome(() => validateTaskGraph(g([['\ud800'], ['\udc00']])))).toBe('ok');
  });

  it('모양이 어긋난 입력은 던진다', () => {
    expect(() => native.agentTaskGraphError('{}')).toThrow();
    expect(() => native.agentTaskGraphError('[{"id":1}]')).toThrow();
    expect(() => native.agentTaskGraphError('[{"id":"a","dependsOn":[1]}]')).toThrow();
    expect(() => native.agentTaskGraphError('[{"id":"a","dependsOn":"a"}]')).toThrow();
    expect(() => native.agentTaskGraphError('not json')).toThrow();
  });
});

// ── 진행 중 지시 ──────────────────────────────────────────────────────────────────────────────────
describe('진행 중 지시 벡터', () => {
  const cases: Array<[string[], string]> = [
    [['a'], '[진행 중 지시] a'],
    [['a', 'b'], '[진행 중 지시] a\nb'],
    [[], '[진행 중 지시] '],
    [['', ''], '[진행 중 지시] \n'],
    [['\ud800', '\udc00'], '[진행 중 지시] \ud800\n\udc00'],
    [['\ue010\ue008\ue003\ue00d'], '[진행 중 지시] \ue010\ue008\ue003\ue00d'],
    [['x\ny'], '[진행 중 지시] x\ny'],
  ];
  for (const [texts, expected] of cases) {
    it(JSON.stringify(texts), () => {
      expect(formatSteering(texts)).toBe(expected);
      expect(legacyFormatSteering(texts)).toBe(expected);
    });
  }

  it('appendUserText: 마지막 메시지의 종류별', () => {
    type M = Parameters<typeof appendUserText>[0];
    const apply = (messages: M, text: string, fn: typeof appendUserText) => {
      fn(messages, text);
      return JSON.stringify(messages);
    };
    const inputs: Array<[string, () => M, string]> = [
      ['빈 배열', () => [], '[{"role":"user","content":"t"}]'],
      ['마지막이 assistant(글)', () => [{ role: 'assistant', content: 'a' }], '[{"role":"assistant","content":"a"},{"role":"user","content":"t"}]'],
      ['마지막이 assistant(배열)', () => [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }], '[{"role":"assistant","content":[{"type":"text","text":"a"}]},{"role":"user","content":"t"}]'],
      ['마지막이 user(글)', () => [{ role: 'user', content: 'a' }], '[{"role":"user","content":"a\\n\\nt"}]'],
      ['마지막이 user(빈 글)', () => [{ role: 'user', content: '' }], '[{"role":"user","content":"\\n\\nt"}]'],
      ['마지막이 user(도구 결과 배열)', () => [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] }], '[{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"r"},{"type":"text","text":"t"}]}]'],
      ['마지막이 user(빈 배열)', () => [{ role: 'user', content: [] }], '[{"role":"user","content":[{"type":"text","text":"t"}]}]'],
      ['마지막이 user(내용 없음)', () => [{ role: 'user', content: undefined as unknown as string }], '[{"role":"user"},{"role":"user","content":"t"}]'],
      ['마지막이 user(null)', () => [{ role: 'user', content: null as unknown as string }], '[{"role":"user","content":null},{"role":"user","content":"t"}]'],
    ];
    for (const [name, make, expected] of inputs) {
      expect(apply(make(), 't', appendUserText), name).toBe(expected);
      expect(apply(make(), 't', legacyAppendUserText), name).toBe(expected);
    }
  });

  it('native 계획 값', () => {
    expect(native.agentAppendUserPlan('user', 'string')).toBe('concat');
    expect(native.agentAppendUserPlan('user', 'array')).toBe('push');
    expect(native.agentAppendUserPlan('user', 'other')).toBe('new');
    expect(native.agentAppendUserPlan('assistant', 'string')).toBe('new');
    expect(native.agentAppendUserPlan(undefined, 'string')).toBe('new');
    expect(native.agentAppendUserPlan('User', 'string')).toBe('new');
  });
});

// ── JSON 요약 ─────────────────────────────────────────────────────────────────────────────────────
describe('JSON 요약 벡터', () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['배열', '[1,2,3]', '배열, 3개 항목'],
    ['빈 배열', '[]', '배열, 0개 항목'],
    ['첫 항목이 빈 객체', '[{}]', '배열, 1개 항목'],
    ['첫 항목이 배열', '[[1],[2]]', '배열, 2개 항목'],
    ['첫 항목 필드', '[{"id":1,"name":"a","tags":[1,2],"on":true,"d":null,"o":{}},2]', '배열, 2개 항목 · 첫 항목 필드: id: number, name: string, tags: 배열(2), on: boolean, d: null, o: object'],
    ['객체의 배열 값', '{"posts":[1],"meta":{},"c":[]}', 'posts 1개, meta, c 0개'],
    ['정수 꼴 키가 먼저', '{"b":1,"2":1,"1":[1],"a":1}', '1 1개, 2, b, a'],
    ['같은 키는 값만 바뀌고 자리는 처음 것', '{"a":1,"b":2,"a":[1,2]}', 'a 2개, b'],
    ['__proto__ 키', '{"__proto__":[1],"a":1}', '__proto__ 1개, a'],
    ['빈 객체', '{}', '(빈 객체)'],
    ['천 단위 쉼표', `[${new Array(2076).fill('0').join(',')}]`, '배열, 2,076개 항목'],
    ['최상위 수', '12', '12'],
    ['최상위 큰 수', '1e999', 'Infinity'],
    ['최상위 -0', '-0', '0'],
    ['최상위 지수 표기', '1e21', '1e+21'],
    ['최상위 작은 수', '1e-7', '1e-7'],
    ['최상위 null', 'null', 'null'],
    ['최상위 true', 'true', 'true'],
    ['최상위 글', '"x y"', 'x y'],
    ['앞뒤 공백', ' \t\r\n[1]\n', '배열, 1개 항목'],
    ['JSON이 아님', '그냥 텍스트', undefined],
    ['빈 글', '', undefined],
    ['끝 쉼표', '[1,]', undefined],
    ['작은따옴표', "{'a':1}", undefined],
    ['앞에 BOM', '\ufeff[1]', undefined],
    ['앞에 NBSP', '\u00a0[1]', undefined],
    ['0으로 시작하는 수', '[01]', undefined],
    ['뒤에 글자', '[1] x', undefined],
    ['NaN', 'NaN', undefined],
    ['주석', '// c\n[1]', undefined],
  ];
  for (const [name, text, expected] of cases) {
    it(name, () => {
      expect(summarizeJsonContent(text)).toBe(expected);
      expect(legacySummarizeJsonContent(text)).toBe(expected);
    });
  }

  it('짝 없는 서로게이트 이스케이프는 U+FFFD로 합치지 않고 글자 그대로 요약에 나온다', () => {
    expect(summarizeJsonContent('{"\\ud800":[1],"\\udc00":2}')).toBe('\ud800 1개, \udc00');
    expect(summarizeJsonContent('{"\\ud83d\\ude00":1}')).toBe('😀');
    expect(summarizeJsonContent('"\\ud800"')).toBe('\ud800');
    expect(summarizeJsonContent('{"\ue010":1,"\\ue011":2}')).toBe('\ue010, \ue011');
    // 글 안의 짝 없는 서로게이트 글자 그대로(이스케이프가 아니라)도 같다
    expect(summarizeJsonContent('{"\ud800":1,"\udc00":2}')).toBe('\ud800, \udc00');
    expect(legacySummarizeJsonContent('{"\ud800":1,"\udc00":2}')).toBe('\ud800, \udc00');
    expect(legacySummarizeJsonContent('{"\\ud800":[1],"\\udc00":2}')).toBe('\ud800 1개, \udc00');
  });

  it('성질 시험: 인코딩 없이 보내면 서로 다른 서로게이트 키가 한 키로 합쳐진다(U+FFFD)', () => {
    expect(native.agentSummarizeJsonContent('{"\ud800":1,"\udc00":2}')).toBe('\ufffd');
    expect(summarizeJsonContent('{"\ud800":1,"\udc00":2}')).toBe('\ud800, \udc00');
  });

  it('의도한 차이: 너무 깊은 중첩은 요약하지 않는다(옛 TS는 읽는다)', () => {
    const deep = `${'['.repeat(2500)}${']'.repeat(2500)}`;
    expect(legacySummarizeJsonContent(deep)).toBe('배열, 1개 항목');
    expect(summarizeJsonContent(deep)).toBeUndefined();
    const ok = `${'['.repeat(1500)}${']'.repeat(1500)}`;
    expect(summarizeJsonContent(ok)).toBe('배열, 1개 항목');
  });
});
