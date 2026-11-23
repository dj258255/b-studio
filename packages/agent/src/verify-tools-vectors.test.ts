import { readFileSync } from 'node:fs';
import { native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { asRecord, boolean, clamp, createMismatchLog, httpOriginError, httpPathError, integer, optionalStringArray, serviceName, serviceOrAddonName, string, stringArray, summarizeApproval } from './tools';
import { formatVerificationReport, mentionsDeletedFile, platformFailureOf } from './verify';

/**
 * 벡터(ADR-191 3u). 기대값은 옛 TS(verify-tools-legacy.ts, #1347에서 지움)가 낸 값이다. 옛 TS와 달랐던 곳은 "의도한 차이" 시험뿐이다.
 * 옛 TS가 같은 입력에 낸 값을 견주던 자리(입력 검사의 반환값, clamp, 승인 요약, 보고서 글)는 `verify-tools-vectors-frozen.json`에 얼렸다
 * (`enc`: -0·NaN을 가리는 글자, 던지면 `threw:` 글). 입력 목록과 같은 순서다.
 * 허용·인식하는 자리마다 거의 같은 거부 입력(접두·덧붙임·대소문자·빈 글자·다른 구분자)을 넣는다.
 */
const FROZEN = JSON.parse(readFileSync(new URL('./verify-tools-vectors-frozen.json', import.meta.url), 'utf8')) as {
  input: string[];
  inputEmpty: string[];
  clamp: string[];
  summ: string[];
  report: string[];
  dir: boolean;
};
const enc = (v: unknown): string => (Object.is(v, -0) ? '-0' : typeof v === 'undefined' ? 'undefined' : typeof v === 'number' ? String(v) : typeof v === 'string' ? `s:${v}` : `j:${JSON.stringify(v)}`);
type Report = Record<string, unknown>;
const ok = (fn: () => unknown) => {
  try {
    return fn();
  } catch (error) {
    return `threw:${(error as Error).message}`;
  }
};

describe('입력 검사 경계', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['integer', 0, true],
    ['integer', -0, true],
    ['integer', 2 ** 53, true],
    ['integer', 2 ** 53 + 2, true],
    ['integer', 1e21, true],
    ['integer', 1e300, true],
    ['integer', -1, true],
    ['integer', 0.5, false],
    ['integer', 5e-324, false],
    ['integer', NaN, false],
    ['integer', Infinity, false],
    ['integer', -Infinity, false],
    ['integer', '5', false],
    ['integer', '', false],
    ['integer', true, false],
    ['integer', null, false],
    ['integer', [1], false],
    ['string', '', true],
    ['string', ' ', true],
    ['string', 1, false],
    ['string', ['a'], false],
    ['boolean', false, true],
    ['boolean', 0, false],
    ['boolean', 'true', false],
    ['stringArray', ['a'], true],
    ['stringArray', [''], true],
    ['stringArray', [], false],
    ['stringArray', ['a', 1], false],
    ['stringArray', ['a', null], false],
    ['stringArray', 'a', false],
    ['optionalStringArray', undefined, true],
    ['optionalStringArray', [], true],
    ['optionalStringArray', ['a'], true],
    ['optionalStringArray', null, false],
    ['optionalStringArray', 'a', false],
    ['optionalStringArray', [1], false],
  ];
  const impls = { integer, string, boolean, stringArray, optionalStringArray } as const;

  it.each(cases.map((row, index) => [...row, index] as const))('%s(%j)는 받음=%s이고 옛 구현이 낸 값과 같다', (kind, value, accepted, index) => {
    const now = impls[kind as keyof typeof impls];
    const args = { k: value };
    expect(String(ok(() => now(args, 'k'))).startsWith('threw:')).toBe(!accepted);
    expect(enc(ok(() => now(args, 'k')))).toBe(FROZEN.input[index]);
  });

  it('값이 없으면(undefined) optionalStringArray만 받는다', () => {
    [string, integer, boolean, stringArray].forEach((now, index) => {
      expect(enc(ok(() => now({}, 'k')))).toBe(FROZEN.inputEmpty[index]);
      expect(String(ok(() => now({}, 'k')))).toContain('threw');
    });
    expect(optionalStringArray({}, 'k')).toEqual([]);
  });

  it('입력은 객체여야 한다(배열·null·문자열·수는 거부)', () => {
    for (const bad of [[], null, 'a', 1, true, undefined]) expect(() => asRecord(bad)).toThrow('Tool input must be an object');
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord({})).toEqual({});
  });

  it('clamp 경계: 같음과 ±1', () => {
    const rows: Array<[number, number, number]> = [[0, 1, 6], [1, 1, 6], [6, 1, 6], [7, 1, 6], [3, 1, 6], [-1, 1, 6], [200, 1, 200], [201, 1, 200], [NaN, 1, 6], [Infinity, 1, 6], [-0, 0, 6], [-0, -0, 6]];
    rows.forEach(([value, min, max], index) => expect(enc(clamp(value, min, max)), `${value} ${min} ${max}`).toBe(FROZEN.clamp[index]));
    expect(clamp(0, 1, 6)).toBe(1);
    expect(clamp(7, 1, 6)).toBe(6);
  });
});

describe('서비스 허용 목록: 거의 같은 거부 입력', () => {
  const project = { managed: [['api', {}], ['web-app', {}]] as const, composeServices: ['api', 'web-app', 'db'] } as never;
  const cases: Array<[string, boolean, boolean]> = [
    ['api', true, true],
    ['web-app', true, true],
    ['db', false, true],
    ['ap', false, false],
    ['apis', false, false],
    ['API', false, false],
    ['Api', false, false],
    ['api ', false, false],
    [' api', false, false],
    ['web_app', false, false],
    ['web-ap', false, false],
    ['web/app', false, false],
    ['', false, false],
    ['d', false, false],
    ['db\u0000', false, false],
    ['a�', false, false],
  ];
  it.each(cases)('%j: managed=%s, managed·부가=%s', (name, managed, withAddon) => {
    const args = { service: name };
    expect(String(ok(() => serviceName({ project } as never, args))).startsWith('threw:')).toBe(!managed);
    expect(String(ok(() => serviceOrAddonName({ project } as never, args))).startsWith('threw:')).toBe(!withAddon);
  });

  it('compose 목록이 없으면 managed만, 빈 목록이면 아무것도 받지 않는다', () => {
    const noCompose = { managed: [['api', {}]] } as never;
    expect(serviceOrAddonName({ project: noCompose } as never, { service: 'api' })).toBe('api');
    expect(() => serviceOrAddonName({ project: noCompose } as never, { service: 'db' })).toThrow('Unknown service: db');
    const empty = { managed: [['api', {}]], composeServices: [] } as never;
    expect(() => serviceOrAddonName({ project: empty } as never, { service: 'api' })).toThrow('Unknown service: api');
  });
});

describe('어긋남 기록: 상한과 같은 기록', () => {
  const m = (requestValue: string, checkValue: string, followed: 'request' | 'check' | 'neither' = 'request') => ({ requestValue, checkValue, followed, note: 'n' });
  it('다섯 번째까지 받고 여섯 번째는 버린다(경계 ±1)', () => {
    const log = createMismatchLog();
    const results = [1, 2, 3, 4, 5, 6].map((n) => log.add(m(`r${n}`, 'c')));
    expect(results).toEqual([true, true, true, true, true, false]);
    expect(log.list).toHaveLength(5);
  });
  it('세 값이 모두 같을 때만 같은 기록이다(하나만 달라도 새 기록)', () => {
    const log = createMismatchLog();
    expect(log.add(m('a', 'b'))).toBe(true);
    expect(log.add(m('a', 'b'))).toBe(false);
    expect(log.add(m('a', 'b', 'check'))).toBe(true);
    expect(log.add(m('a2', 'b'))).toBe(true);
    expect(log.add(m('a', 'b2'))).toBe(true);
    expect(log.add(m('A', 'b'))).toBe(true);
    expect(log.add(m('a ', 'b'))).toBe(false); // 상한 5 도달
  });
  it('상한 앞에서도 같은 기록 판정은 정확하다(prefix·대소문자·빈 글자)', () => {
    const log = createMismatchLog();
    expect(log.add(m('abc', 'x'))).toBe(true);
    expect(log.add(m('ab', 'x'))).toBe(true);
    expect(log.add(m('ABC', 'x'))).toBe(true);
    expect(log.add(m('', 'x'))).toBe(true);
    expect(log.add(m('', 'x'))).toBe(false);
  });
});

describe('http 경로·origin', () => {
  const endpoint = 'http://127.0.0.1:8080/svc/';
  const rows: Array<[string, string | undefined]> = [
    ['/a', undefined],
    ['/a?b=c', undefined],
    ['/', undefined],
    ['//evil.com/x', 'path must stay on the service host'],
    ['/\\evil.com', 'path must stay on the service host'],
    ['//127.0.0.1:8080/x', undefined],
    ['//127.0.0.1:8081/x', 'path must stay on the service host'],
    ['//127.0.0.1/x', 'path must stay on the service host'],
    ['/@evil.com', undefined],
  ];
  it.each(rows)('%j → %s', (requestPath, expected) => {
    expect(httpPathError(requestPath)).toBeUndefined();
    expect(httpOriginError(new URL(requestPath, endpoint), endpoint)).toBe(expected);
  });
  it('경로는 /로 시작해야 한다', () => {
    for (const bad of ['', 'a', ' /a', 'http://x/a', '.']) expect(httpPathError(bad)).toBe('path must start with "/"');
    expect(httpPathError('/')).toBeUndefined();
  });
  it('호스트·포트·스킴·대소문자가 다르면 다른 origin이다', () => {
    for (const other of ['http://127.0.0.1:8081', 'https://127.0.0.1:8080', 'http://127.0.0.2:8080', 'http://localhost:8080']) {
      expect(httpOriginError(new URL('/a', other), endpoint)).toBe('path must stay on the service host');
    }
    expect(httpOriginError(new URL('/a', 'HTTP://127.0.0.1:8080'), endpoint)).toBeUndefined();
  });
});

describe('origin 같음 판정의 거의 같은 거부 입력(껍데기가 보내는 글자로 직접)', () => {
  const same = (a: string, b: string) => native.toolSameOrigin(a, b);
  it('글자가 정확히 같을 때만 같다(접두·덧붙임·대소문자·빈 글자)', () => {
    expect(same('http://a:1', 'http://a:1')).toBe(true);
    for (const other of ['http://a:12', 'http://a:', 'http://a', 'http://a:1 ', ' http://a:1', 'HTTP://A:1', 'http://A:1', 'https://a:1', 'http://a:1/', '']) {
      expect(same(other, 'http://a:1'), other).toBe(false);
      expect(same('http://a:1', other), other).toBe(false);
    }
    expect(same('', '')).toBe(true);
    expect(same('null', 'null')).toBe(false);
  });
});

describe('승인 요약', () => {
  const rows: Array<[string, unknown]> = [
    ['run_in_service', { service: 'api', command: ['ls', '-la'] }],
    ['run_in_service', { service: 'api', command: ['ls', 1, null, 'x'] }],
    ['run_in_service', { service: 5, command: 'ls' }],
    ['run_in_service', {}],
    ['run_in_service', []],
    ['run_in_service', null],
    ['run_in_service', 'x'],
    ['write_file', { path: 'a/b.txt' }],
    ['edit_file', { path: 5 }],
    ['delete_file', {}],
    ['delete_file', null],
    ['read_file', { path: 'a' }],
    ['Run_In_Service', { service: 'api' }],
    ['run_in_service ', { service: 'api' }],
  ];
  it.each(rows.map((row, index) => [...row, index] as const))('%s %j', (name, input, index) => {
    expect(summarizeApproval(name, input)).toBe(FROZEN.summ[index]);
  });
  it('값', () => {
    expect(summarizeApproval('run_in_service', { service: 'api', command: ['ls', 1, 'x'] })).toBe('run ls x in api');
    expect(summarizeApproval('delete_file', {})).toBe('delete_file a file');
    expect(summarizeApproval('Run_In_Service', { service: 'api' })).toBe('Run_In_Service');
  });
});

describe('지운 파일 로그: 거의 같은 거부 입력', () => {
  const deleted = ['db/migration/V2__memo.sql'];
  const rows: Array<[string, boolean]> = [
    ['java.nio.file.NoSuchFileException: /app/V2__memo.sql', true],
    ["can't stat 'V2__memo.sql': No such file or directory", true],
    ['V2__memo.sql: no such file', true],
    ['V2__memo.sql: NO SUCH FILE', true],
    ['V2__memo.sql: nosuchfile', true],
    ['V2__memo.sql NoSuchFile', true],
    ['Flyway migrated V2__memo.sql', false],
    ['NoSuchFileException: /app/other.sql', false],
    ['v2__memo.sql: no such file', false],
    ['V2__memo.sq: no such file', false],
    ['V2__memo.sql: no such\tfile', false],
    ['V2__memo.sql: no  such file', false],
    ['V2__memo.sql: nosuch file', false],
    ['V2__memo.sql: no suchfile', false],
    ['V2__memo.sql: ſo such file', false],
    ['', false],
  ];
  it.each(rows)('%j → %s', (line, expected) => {
    expect(mentionsDeletedFile([line], deleted)).toBe(expected);
  });
  it('여러 파일·빈 목록·빈 이름', () => {
    expect(mentionsDeletedFile([], deleted)).toBe(false);
    expect(mentionsDeletedFile(['No such file'], [])).toBe(false);
    expect(mentionsDeletedFile(['No such file'], ['dir/'])).toBe(FROZEN.dir);
    expect(mentionsDeletedFile(['x No such file'], ['a.sql', 'x'])).toBe(true);
    expect(mentionsDeletedFile(['x'], ['a.sql', 'x'])).toBe(false);
  });
});

describe('ok 계산: 한 조건씩 어긋나면 실패', () => {
  const ready = [{ service: 's', ready: true }];
  const clean = [{ service: 'c', changes: [{ kind: 'operation-added' as const, target: 't', breaking: false }] }];
  const call = (restarted: Array<{ service: string; ready: boolean }>, contracts: Array<{ service: string; changes: Array<{ kind: 'operation-added'; target: string; breaking: boolean }>; error?: string }>, allow: boolean, leaks: number, spec: string | undefined) => ({
    now: native.verifyOk(
      restarted.map((c) => c.ready),
      contracts.map((c) => c.error !== undefined),
      contracts.flatMap((c) => c.changes.map((x) => x.breaking)),
      allow,
      leaks,
      spec !== undefined,
    ),
  });
  const breaking = [{ service: 'c', changes: [{ kind: 'operation-added' as const, target: 't', breaking: true }] }];
  it.each([
    ['모두 맞음', ready, clean, false, 0, undefined, true],
    ['준비 안 됨', [{ service: 's', ready: false }], clean, false, 0, undefined, false],
    ['하나만 준비 안 됨', [...ready, { service: 't', ready: false }], clean, false, 0, undefined, false],
    ['계약 추출 실패', ready, [{ ...clean[0]!, error: 'HTTP 500' }], false, 0, undefined, false],
    ['breaking', ready, breaking, false, 0, undefined, false],
    ['breaking 허용', ready, breaking, true, 0, undefined, true],
    ['시크릿 1개', ready, clean, false, 1, undefined, false],
    ['studio.yaml 오류', ready, clean, false, 0, 'bad', false],
    ['재시작한 서비스 없음', [], [], false, 0, undefined, true],
  ] as const)('%s → %s', (_name, restarted, contracts, allow, leaks, spec, expected) => {
    const result = call([...restarted], contracts.map((c) => ({ ...c, changes: [...c.changes] })), allow, leaks, spec);
    expect(result.now).toBe(expected);
  });
});

describe('platformFailureOf', () => {
  it('샌드박스 쪽 실패의 첫 줄', () => {
    expect(platformFailureOf({ error: 'a\nb', platform: true }, [])).toBe('a');
    expect(platformFailureOf({ error: 'a\nb' }, [])).toBeUndefined();
    expect(platformFailureOf({ elapsedMs: 1 }, [{ service: 'api', ready: false, platform: true, error: 'x\ny' }])).toBe('api: x');
    expect(platformFailureOf({ elapsedMs: 1 }, [{ service: 'api', ready: true, platform: true }])).toBeUndefined();
    expect(platformFailureOf({ elapsedMs: 1 }, [{ service: 'api', ready: false }])).toBeUndefined();
    expect(platformFailureOf({ elapsedMs: 1 }, [{ service: 'api', ready: false, platform: true }])).toBe('api: ');
  });
});

describe('보고서 글', () => {
  const base: Report = { ok: true, sync: { elapsedMs: 1200 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] };
  it('첫 줄과 반영 시간', () => {
    expect(formatVerificationReport(base as never, { allowBreaking: false })).toBe('검증 통과\n- 샌드박스 파일 반영 확인: 1.2초\n- 재시작한 서비스 없음');
    expect(formatVerificationReport({ ...base, ok: false } as never, { allowBreaking: false })).toBe(FROZEN.report[0]);
    expect(formatVerificationReport({ ...base, sync: { elapsedMs: 1250 } } as never, { allowBreaking: false })).toContain('1.3초');
    expect(formatVerificationReport({ ...base, sync: { elapsedMs: 1249 } } as never, { allowBreaking: false })).toContain('1.2초');
  });
  it('이어 붙는 줄들이 옛 글과 같다', () => {
    const full: Report = {
      ok: false,
      sync: { elapsedMs: 3 },
      platformFailure: 'db: 죽음',
      specError: 'a\nb',
      restarted: [
        { service: 'api', ready: false, error: 'e', retried: true, logTail: ['l1', 'l2'], blockedEgress: ['GET x:443 (deny)'] },
        { service: 'web', ready: true },
      ],
      contracts: [
        { service: 'api', changes: [{ kind: 'property-removed', target: 'T.a', breaking: true, detail: 'd' }] },
        { service: 'web', changes: [], error: 'HTTP 500' },
      ],
      unverifiedFiles: ['u1', 'u2'],
      skippedOff: ['cache'],
      addedAddons: ['mediamtx'],
      addonError: 'nope',
      secretLeaks: [{ file: '.env', secrets: ['A', 'B'] }],
    };
    [false, true].forEach((allow, index) => expect(formatVerificationReport(full as never, { allowBreaking: allow })).toBe(FROZEN.report[1 + index]));
    expect(formatVerificationReport({ ...full, sync: { error: 'x' } } as never, { allowBreaking: false })).toBe(FROZEN.report[3]);
  });
});

describe('의도한 차이(옛 구현에서는 통과 쪽이었던 것)', () => {
  it('계약 추출 실패의 이유가 빈 글자여도 실패다(트러블슈팅 171)', () => {
    const contracts = [{ service: 'c', changes: [], error: '' }];
    expect(native.verifyOk([], [true], [], false, 0, false)).toBe(false);
    const report = { ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts, unverifiedFiles: [], secretLeaks: [], skippedOff: [] };
    expect(formatVerificationReport(report as never, { allowBreaking: false })).toContain('- c 계약 추출 실패: ');
  });
  it('studio.yaml 오류가 빈 글자여도 보고서가 알린다', () => {
    const report = { ok: false, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [], specError: '' };
    expect(formatVerificationReport(report as never, { allowBreaking: false })).toContain('studio.yaml 형식이 올바르지 않아');
  });
  it('ok가 참 같은 값이면 통과 글이 나오지 않는다', () => {
    const report = { ok: 1, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] };
    expect(formatVerificationReport(report as never, { allowBreaking: false }).startsWith('검증 실패')).toBe(true);
  });
  it('모양이 어긋난 보고서는 던지지 않고 실패 글이다', () => {
    const broken = { ok: true, sync: { elapsedMs: 1 }, restarted: 'x', contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] };
    const text = formatVerificationReport(broken as never, { allowBreaking: false });
    expect(text.startsWith('검증 실패')).toBe(true);
    expect(formatVerificationReport({ ok: true } as never, { allowBreaking: false }).startsWith('검증 실패')).toBe(true);
    expect(formatVerificationReport(null as never, { allowBreaking: false }).startsWith('검증 실패')).toBe(true);
  });
  it('구멍 난 배열은 거부한다', () => {
    expect(() => stringArray({ k: [, 'a'] }, 'k')).toThrow('non-empty array of strings');
    expect(() => stringArray({ k: new Array(2) }, 'k')).toThrow('non-empty array of strings');
    expect(() => optionalStringArray({ k: [, 'a'] }, 'k')).toThrow('array of strings');
  });
  it('toJSON·Date·BigInt·클래스 인스턴스는 문자열·객체로 읽히지 않는다', () => {
    expect(() => string({ k: { toJSON: () => 'x' } }, 'k')).toThrow('must be a string');
    expect(() => string({ k: new Date(0) }, 'k')).toThrow('must be a string');
    expect(() => integer({ k: { toJSON: () => 1 } }, 'k')).toThrow('must be an integer');
    expect(() => boolean({ k: { toJSON: () => true } }, 'k')).toThrow('must be a boolean');
    expect(() => stringArray({ k: { toJSON: () => ['a'] } }, 'k')).toThrow('non-empty array of strings');
    expect(() => asRecord(5n)).toThrow('Tool input must be an object');
    expect(() => asRecord(new Date(0))).toThrow('Tool input must be an object');
    expect(() => asRecord({ a: 5n })).toThrow('Tool input must be an object');
    expect(() => asRecord(JSON.parse('{"\\u0000x":1}'))).toThrow('Tool input must be an object');
  });
  it('__proto__ 키는 그냥 키다', () => {
    const record = asRecord(JSON.parse('{"__proto__":{"service":"x"}}'));
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(() => string(record, 'service')).toThrow('must be a string');
  });
  it('불투명 origin(null)은 같다고 보지 않는다', () => {
    expect(httpOriginError(new URL('/a', 'foo://bar'), 'foo://bar')).toBe('path must stay on the service host');
  });
});
