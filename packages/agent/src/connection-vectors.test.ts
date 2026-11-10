import { describe, expect, it } from 'vitest';
import { Board } from './coordination/board';
import { LegacyBoard } from './coordination/board-legacy';
import { externalBoardAccess, runBoardMcpTool } from './board-mcp';
import { describeStep, isAllowedRequest, isAutomaticFavicon } from './browser-check';
import { rejectedChangeFeedback } from './change-tracker';
import * as legacy from './connection-legacy';
import { authorize, hostAllowed, tokenMatches } from './mcp-http-server';

/**
 * 연결·인증·조율 판정(ADR-191 3t)의 벡터. 기대값은 옛 TS(`connection-legacy.ts`, `coordination/board-legacy.ts`)가 낸 값이다.
 * `CONN_VECTORS_AGAINST=legacy`로 돌리면 옛 구현에 같은 벡터를 넣는다 — 이름이 "의도한 차이:"로 시작하는 벡터만 실패해야 한다.
 * 허용·인식 패턴마다 거의 같은 거부 입력(접두·덧붙임·대소문자·빈 글자·다른 구분자)을 둔다.
 */
const AGAINST_LEGACY = process.env['CONN_VECTORS_AGAINST'] === 'legacy';
const subject = AGAINST_LEGACY
  ? { hostAllowed: legacy.hostAllowed, tokenMatches: legacy.tokenMatches, authorize: legacy.authorize, isAllowedRequest: legacy.isAllowedRequest, isAutomaticFavicon: legacy.isAutomaticFavicon, describeStep: legacy.describeStep as (step: never) => string, rejectedChangeFeedback: legacy.rejectedChangeFeedback, runBoardMcpTool: legacy.runBoardMcpTool, Board: LegacyBoard as unknown as typeof Board }
  : { hostAllowed, tokenMatches, authorize, isAllowedRequest, isAutomaticFavicon, describeStep: describeStep as (step: never) => string, rejectedChangeFeedback, runBoardMcpTool, Board };

const DOCKER = ['host.docker.internal'];

describe('호스트(여는 쪽)', () => {
  const cases: Array<[string, string | undefined, readonly string[], boolean]> = [
    ['localhost', 'localhost', [], true],
    ['포트 붙음', 'LOCALHOST:3000', [], true],
    ['127.0.0.1:80', '127.0.0.1:80', [], true],
    ['IPv6 대괄호 포트', '[::1]:80', [], true],
    ['IPv6 그대로', '::1', [], true],
    ['끝 콜론', 'localhost:', [], true],
    ['앞뒤 공백', ' localhost ', [], true],
    ['BOM은 trim이 걷는다', '﻿localhost', [], true],
    ['NBSP는 trim이 걷는다', ' localhost ', [], true],
    ['닫는 대괄호 뒤 덧붙임은 무시한다(옛 slice)', '[::1]x', [], true],
    ['끝에 점', 'localhost.', [], false],
    ['앞 덧붙임', 'xlocalhost', [], false],
    ['뒤 덧붙임', 'localhostx', [], false],
    ['하위 도메인 뒤', 'localhost.evil.com', [], false],
    ['하위 도메인 앞', 'evil.localhost', [], false],
    ['IP 끝에 점', '127.0.0.1.', [], false],
    ['다른 루프백 IP', '127.0.0.2', [], false],
    ['0.0.0.0', '0.0.0.0', [], false],
    ['빈 값', '', [], false],
    ['undefined', undefined, [], false],
    ['여는 대괄호만', '[::1', [], false],
    ['대괄호 두 겹', '[[::1]]', [], false],
    ['콜론이 둘(포트 없는 IPv6로 읽는다)', 'localhost:80:90', [], false],
    ['U+0085는 trim이 걷지 않는다', '\u0085localhost', [], false],
    ['폭 없는 공백은 trim이 걷지 않는다', '​localhost', [], false],
    ['전각', 'ＬＯＣＡＬＨＯＳＴ', [], false],
    ['NUL 덧붙임', 'localhost\u0000', [], false],
    ['허용 이름', 'host.docker.internal:3000', DOCKER, true],
    ['허용하지 않았으면 거부', 'host.docker.internal:3000', [], false],
    ['허용 이름은 대소문자를 가리지 않는다(헤더)', 'HOST.DOCKER.INTERNAL:1', DOCKER, true],
    ['허용 이름은 대소문자를 가리지 않는다(설정)', 'host.docker.internal', ['Host.Docker.Internal'], true],
    ['허용 이름의 접두', 'host.docker', DOCKER, false],
    ['허용 이름에 덧붙임', 'host.docker.internal.evil', DOCKER, false],
    ['허용 이름 앞 덧붙임', 'xhost.docker.internal', DOCKER, false],
    ['허용 설정의 앞 공백', 'host.docker.internal', [' host.docker.internal'], false],
    ['허용 설정이 비면 빈 호스트가 열린다? 아니다(빈 값은 허용 이름과 같을 때만)', 'evil.com', [''], false],
    ['켈빈 기호는 소문자로 k', 'key', ['Key'], true],
    ['İ의 소문자는 두 글자', 'İ', ['i̇'], true],
    ['끝 시그마(포트 앞에서 잘린 뒤)', 'ΑΣ:Β', ['ας'], true],
    ['시그마 중간 꼴은 다르다', 'ΑΣ:Β', ['ασ'], false],
    ['짝 없는 서로게이트끼리는 다르다', '\ud800', ['\ud801'], false],
    ['짝 없는 서로게이트가 같으면 같다', '\ud800', ['\ud800'], true],
    ['짝 없는 서로게이트와 U+FFFD는 다르다', '\ud800', ['�'], false],
    ['예약 글자(U+E011)와 짝 없는 서로게이트는 다르다', '\ud800', [''], false],
  ];
  for (const [name, host, allowed, expected] of cases) {
    it(name, () => {
      expect(subject.hostAllowed(host, allowed)).toBe(expected);
    });
  }
});

describe('토큰(여는 쪽)', () => {
  const cases: Array<[string, string | undefined, string, boolean]> = [
    ['같다', 'Bearer abc', 'abc', true],
    ['접두는 대소문자를 구분한다', 'bearer abc', 'abc', false],
    ['접두 전부 대문자', 'BEARER abc', 'abc', false],
    ['접두 뒤 공백 둘', 'Bearer  abc', 'abc', false],
    ['끝 공백', 'Bearer abc ', 'abc', false],
    ['토큰이 한 글자 짧다', 'Bearer ab', 'abc', false],
    ['토큰이 한 글자 길다', 'Bearer abcd', 'abc', false],
    ['토큰의 접두', 'Bearer a', 'abc', false],
    ['대소문자', 'Bearer ABC', 'abc', false],
    ['마지막 글자만 다르다', 'Bearer abd', 'abc', false],
    ['첫 글자만 다르다', 'Bearer xbc', 'abc', false],
    ['접두 없음', 'abc', 'abc', false],
    ['Bearer만', 'Bearer', 'abc', false],
    ['토큰이 빈 요청', 'Bearer ', 'abc', false],
    ['빈 헤더', '', 'abc', false],
    ['헤더 없음', undefined, 'abc', false],
    ['Basic', 'Basic abc', 'abc', false],
    ['앞 공백', ' Bearer abc', 'abc', false],
    ['긴 토큰이 같다', `Bearer ${'0123456789abcdef'.repeat(3)}`, '0123456789abcdef'.repeat(3), true],
    ['긴 토큰의 마지막 한 글자', `Bearer ${'0123456789abcdef'.repeat(3).slice(0, -1)}0`, '0123456789abcdef'.repeat(3), false],
    ['유니코드가 같다', 'Bearer 한글😀', '한글😀', true],
    ['유니코드가 다르다', 'Bearer 한글', '한글😀', false],
    ['NUL 덧붙임', 'Bearer abc\u0000', 'abc', false],
    ['NUL이 든 토큰이 같다', 'Bearer ab\u0000', 'ab\u0000', true],
    ['NUL이 든 토큰이 다르다', 'Bearer ab\u0001', 'ab\u0000', false],
    ['짝 없는 서로게이트가 같은 토큰', 'Bearer \ud800', '\ud800', true],
    ['짝 없는 서로게이트와 쌍의 앞 절반', 'Bearer \ud83d', '😀', false],
  ];
  for (const [name, authorization, token, expected] of cases) {
    it(name, () => {
      expect(subject.tokenMatches(authorization, token)).toBe(expected);
    });
  }

  it('인증은 호스트가 먼저고, 거부 상태와 이유가 정해져 있다', () => {
    expect(subject.authorize('evil.com', 'Bearer t', 't', [])).toEqual({ status: 403, message: 'MCP 서버는 루프백에서만 접근할 수 있습니다' });
    expect(subject.authorize('evil.com', undefined, 't', [])).toEqual({ status: 403, message: 'MCP 서버는 루프백에서만 접근할 수 있습니다' });
    expect(subject.authorize('localhost', 'Bearer x', 't', [])).toEqual({ status: 401, message: 'unauthorized' });
    expect(subject.authorize('localhost:1', undefined, 't', [])).toEqual({ status: 401, message: 'unauthorized' });
    expect(subject.authorize('localhost', 'Bearer t', 't', [])).toBeUndefined();
    expect(subject.authorize('host.docker.internal', 'Bearer t', 't', DOCKER)).toBeUndefined();
    expect(subject.authorize('host.docker.internal', 'Bearer t', 't', [])).toEqual({ status: 403, message: 'MCP 서버는 루프백에서만 접근할 수 있습니다' });
  });
});

describe('의도한 차이(열린 쪽을 닫는다)', () => {
  it('의도한 차이: 빈 토큰은 어떤 요청도 맞지 않는다', () => {
    expect(subject.tokenMatches('Bearer ', '')).toBe(false);
    expect(subject.authorize('localhost', 'Bearer ', '', [])).toEqual({ status: 401, message: 'unauthorized' });
  });

  it('의도한 차이: 서로 다른 짝 없는 서로게이트 토큰은 다르다(옛 구현은 UTF-8 바이트로 바꾸며 U+FFFD로 합쳐 같다고 읽었다)', () => {
    expect(subject.tokenMatches('Bearer \ud800', '\ud801')).toBe(false);
    expect(subject.tokenMatches('Bearer \udc00', '\ud800')).toBe(false);
    expect(subject.tokenMatches('Bearer �', '\ud800')).toBe(false);
  });
});

describe('허용 출처·파비콘(여는 쪽)', () => {
  const LOCAL = ['http://localhost:3000'];
  const cases: Array<[string, string, readonly string[], boolean]> = [
    ['같은 출처', 'http://localhost:3000/x?y#z', LOCAL, true],
    ['포트 하나 다름', 'http://localhost:3001/', LOCAL, false],
    ['스킴 다름', 'https://localhost:3000/', LOCAL, false],
    ['호스트의 대소문자는 URL 파서가 접는다', 'HTTP://LOCALHOST:3000/x', LOCAL, true],
    ['허용 목록 쪽 대문자는 다르다', 'http://localhost:3000/', ['HTTP://localhost:3000'], false],
    ['뒤 덧붙임', 'http://localhost:3000.evil.com/', LOCAL, false],
    ['앞 덧붙임', 'http://evil.localhost:3000/', LOCAL, false],
    ['userinfo는 출처가 아니다', 'http://user@localhost:3000/', LOCAL, true],
    ['userinfo로 호스트를 속이기', 'http://localhost:3000@evil.com/', LOCAL, false],
    ['기본 포트는 출처에서 빠진다', 'http://localhost:80/', ['http://localhost'], true],
    ['기본 포트를 쓴 허용 목록은 맞지 않는다', 'http://localhost:80/', ['http://localhost:80'], false],
    ['끝 슬래시가 든 허용 목록', 'http://localhost:3000/', ['http://localhost:3000/'], false],
    ['허용 목록이 비었다', 'http://localhost:3000/', [], false],
    ['빈 허용 문자열', 'http://localhost:3000/', [''], false],
    ['IPv6', 'http://[::1]:3000/a', ['http://[::1]:3000'], true],
    ['IDN은 punycode 출처로 견준다', 'http://bücher.example/', ['http://xn--bcher-kva.example'], true],
    ['IDN 원문 허용 목록은 맞지 않는다', 'http://bücher.example/', ['http://bücher.example'], false],
    ['data:', 'data:text/html,x', [], true],
    ['DATA: 대문자도 파서가 접는다', 'DATA:text/html,x', [], true],
    ['blob:', 'blob:http://localhost:3000/uuid', [], true],
    ['about:', 'about:blank', [], true],
    ['file:은 내부 스킴이 아니다', 'file:///etc/passwd', LOCAL, false],
    ['file:의 출처는 null이라 허용 목록의 null과 맞는다', 'file:///etc/passwd', ['null'], true],
    ['javascript:', 'javascript:alert(1)', LOCAL, false],
    ['ftp', 'ftp://localhost:3000/', LOCAL, false],
    ['빈 URL', '', LOCAL, false],
    ['상대 경로', '/relative', LOCAL, false],
    ['스킴 없음', '//localhost:3000/', LOCAL, false],
    ['호스트 없음', 'http://', LOCAL, false],
    ['공백이 든 호스트', 'http://a b/', LOCAL, false],
    ['짝 없는 서로게이트가 든 URL', 'http://\ud800/', LOCAL, false],
  ];
  for (const [name, url, allowed, expected] of cases) {
    it(`요청: ${name}`, () => {
      expect(subject.isAllowedRequest(url, new Set(allowed))).toBe(expected);
    });
  }

  it('짝 없는 서로게이트가 든 허용 목록은 어떤 URL과도 맞지 않는다', () => {
    const allowed = new Set(['\ud800', 'http://localhost:3000\ud800', '�', 'http://localhost:3000�']);
    for (const url of ['http://localhost:3000/', 'http://localhost:3000�/', 'data:x', 'http://�/']) {
      expect(subject.isAllowedRequest(url, allowed), url).toBe(url.startsWith('data:'));
    }
  });

  const favicons: Array<[string, string, boolean | 'throws']> = [
    ['기본', 'http://localhost:3000/favicon.ico', true],
    ['쿼리·해시는 경로가 아니다', 'http://localhost:3000/favicon.ico?x=1#h', true],
    ['슬래시를 덧붙임', 'http://localhost:3000/favicon.ico/', false],
    ['대소문자', 'http://localhost:3000/Favicon.ico', false],
    ['하위 경로', 'http://localhost:3000/a/favicon.ico', false],
    ['앞 슬래시 둘', 'http://localhost:3000//favicon.ico', false],
    ['다른 확장자', 'http://localhost:3000/favicon.png', false],
    ['접두', 'http://localhost:3000/favicon.ico.map', false],
    ['점 경로 정리', 'http://localhost:3000/x/../favicon.ico', true],
    ['퍼센트 인코딩된 글자는 파서가 푼다', 'http://localhost:3000/%66avicon.ico', false],
    ['루트', 'http://localhost:3000/', false],
    ['파싱할 수 없으면 던진다', 'not a url', 'throws'],
    ['빈 값은 던진다', '', 'throws'],
  ];
  for (const [name, url, expected] of favicons) {
    it(`파비콘: ${name}`, () => {
      if (expected === 'throws') expect(() => subject.isAutomaticFavicon(url)).toThrow();
      else expect(subject.isAutomaticFavicon(url)).toBe(expected);
    });
  }
});

describe('단계 설명·거부 경로 안내', () => {
  it('동작 우선순위: click → fill → press → waitFor', () => {
    expect(subject.describeStep({ click: '#a', fill: { selector: '#b' }, press: 'x', waitFor: '.c' } as never)).toBe('click #a');
    expect(subject.describeStep({ fill: { selector: '#b' }, press: 'x', waitFor: '.c' } as never)).toBe('fill #b');
    expect(subject.describeStep({ press: 'Enter', waitFor: '.c' } as never)).toBe('press Enter');
    expect(subject.describeStep({ waitFor: '.c' } as never)).toBe('waitFor .c');
  });

  it('빈 문자열도 값이다, 아무 동작이 없으면 waitFor undefined', () => {
    expect(subject.describeStep({ click: '' } as never)).toBe('click ');
    expect(subject.describeStep({ press: '', waitFor: 'x' } as never)).toBe('press ');
    expect(subject.describeStep({} as never)).toBe('waitFor undefined');
    expect(subject.describeStep({ click: undefined, waitFor: 'x' } as never)).toBe('waitFor x');
  });

  it('fill의 selector가 없어도 fill로 적는다', () => {
    expect(subject.describeStep({ fill: {}, waitFor: 'x' } as never)).toBe('fill undefined');
  });

  const lines = (n: number): string[] => subject.rejectedChangeFeedback(Array.from({ length: n }, (_, i) => `f${i}`)).split('\n');

  it('거부 경로는 20개까지 적고 나머지는 개수로 알린다(경계 19·20·21·22)', () => {
    for (const [n, shown, rest] of [[0, 0, 0], [1, 1, 0], [19, 19, 0], [20, 20, 0], [21, 20, 1], [22, 20, 2], [45, 20, 25]] as const) {
      const text = lines(n);
      expect(text.length, `n=${n}`).toBe(1 + shown + (rest > 0 ? 1 : 0) + 1);
      expect(text.filter((line) => line.startsWith('- f')).length).toBe(shown);
      expect(text.includes(`- 외 ${rest}개`)).toBe(rest > 0);
    }
    expect(lines(21).includes('- f20')).toBe(false);
    expect(lines(21).includes('- f19')).toBe(true);
    expect(lines(0)[0]).toBe('[b-studio 검증 게이트] 게이트가 검증할 수 없는 경로가 이번 실행에서 바뀌어 통과시키지 않았습니다.');
    expect(lines(1).at(-1)).toContain('.gitignore에 넣은 뒤 턴을 끝내세요.');
  });
});

// ---------------------------------------------------------------------------
// 게시판
// ---------------------------------------------------------------------------

const fixedClock = (times: string[]): (() => Date) => {
  let index = 0;
  return () => new Date(times[Math.min(index++, times.length - 1)]!);
};

describe('게시판 validate(막는 쪽)', () => {
  const board = (noteBytes = 10, modelWrites = true) => new subject.Board({ topology: 'mesh', limits: { noteBytes, writesPerLane: 50 }, modelWrites });
  const post = (b: Board, kind: 'contract' | 'failure' | 'fact', body: string, refs?: string[], by: 'model' | 'platform' = 'model') => b.post({ kind, body, ...(refs ? { refs } : {}) }, { lane: 'a', by });
  const reason = (result: ReturnType<Board['post']>): string => (result.ok ? 'ok' : result.reason);

  it('바이트 상한 경계: 같음·+1, 멀티바이트', () => {
    expect(reason(post(board(), 'fact', 'a'.repeat(10)))).toBe('ok');
    expect(reason(post(board(), 'fact', 'a'.repeat(11)))).toBe('메모가 너무 큽니다(최대 10바이트)');
    expect(reason(post(board(), 'fact', `${'a'.repeat(7)}가`))).toBe('ok');
    expect(reason(post(board(), 'fact', `${'a'.repeat(8)}가`))).toBe('메모가 너무 큽니다(최대 10바이트)');
    expect(reason(post(board(), 'fact', '😀😀'))).toBe('ok');
    expect(reason(post(board(), 'fact', '😀😀😀'))).toBe('메모가 너무 큽니다(최대 10바이트)');
    expect(reason(post(board(11), 'fact', 'a'.repeat(11)))).toBe('ok');
    expect(reason(post(board(2048), 'fact', 'a'.repeat(2049)))).toBe('메모가 너무 큽니다(최대 2048바이트)');
  });

  it('빈 본문: JS trim이 걷는 글자만 빈 것이다', () => {
    for (const body of ['', ' ', '\t\n', '﻿', ' ', ' ', '　', ' \r\n  ']) {
      expect(reason(post(board(), 'fact', body)), JSON.stringify(body)).toBe('빈 메모는 쓸 수 없습니다');
    }
    for (const body of ['\u0085', '​', '᠎', 'x', '.', '0']) {
      expect(reason(post(board(), 'fact', body)), JSON.stringify(body)).toBe('ok');
    }
  });

  it('계약은 refs가 하나 이상이어야 한다(빈 글자 하나도 하나다)', () => {
    expect(reason(post(board(), 'contract', 'x'))).toBe('계약 메모는 refs가 하나 이상 필요합니다');
    expect(reason(post(board(), 'contract', 'x', []))).toBe('계약 메모는 refs가 하나 이상 필요합니다');
    expect(reason(post(board(), 'contract', 'x', ['']))).toBe('ok');
    expect(reason(post(board(), 'fact', 'x'))).toBe('ok');
    expect(reason(post(board(), 'failure', 'x', undefined, 'platform'))).toBe('ok');
  });

  it('모델의 실패 메모와 쓰기 금지, 검사 순서', () => {
    expect(reason(post(board(), 'failure', 'x'))).toBe('실패 메모는 검증기만 씁니다');
    expect(reason(post(board(10, false), 'fact', 'x'))).toBe('이 전략에서는 게시판에 쓸 수 없습니다');
    expect(reason(post(board(10, false), 'fact', 'x', undefined, 'platform'))).toBe('ok');
    // 순서: 쓰기 금지 → 실패 → 빈 본문 → 크기 → 계약 refs
    expect(reason(post(board(10, false), 'failure', ''))).toBe('이 전략에서는 게시판에 쓸 수 없습니다');
    expect(reason(post(board(), 'failure', ''))).toBe('실패 메모는 검증기만 씁니다');
    expect(reason(post(board(), 'contract', ''))).toBe('빈 메모는 쓸 수 없습니다');
    expect(reason(post(board(), 'contract', 'a'.repeat(11)))).toBe('메모가 너무 큽니다(최대 10바이트)');
    expect(reason(post(board(), 'contract', ' ', []))).toBe('빈 메모는 쓸 수 없습니다');
  });
});

describe('게시판 read의 고르기(정렬·개수·예산)', () => {
  const times = Array.from({ length: 12 }, (_, i) => `2026-11-10T00:00:${String(i).padStart(2, '0')}.000Z`);
  const make = (limits: { readLimit?: number; readBytesPerLane?: number }, bodies: Array<[('contract' | 'fact'), string]>) => {
    const b = new subject.Board({ topology: 'mesh', limits, now: fixedClock(times) });
    for (const [kind, body] of bodies) b.post({ kind, body, ...(kind === 'contract' ? { refs: ['r'] } : {}) }, { lane: 'a', by: 'model' });
    return b;
  };
  const bodiesOf = (b: Board, limit?: number) => b.read({ lane: 'a' }).notes.slice(0, limit).map((note) => note.body);

  it('계약이 사실보다 앞, 같은 우선순위는 최신이 앞', () => {
    const b = make({}, [['fact', 'f1'], ['contract', 'c1'], ['fact', 'f2'], ['contract', 'c2']]);
    expect(bodiesOf(b)).toEqual(['c2', 'c1', 'f2', 'f1']);
  });

  it('같은 시각이면 id 오름차순', () => {
    const b = new subject.Board({ topology: 'mesh', now: () => new Date('2026-11-10T00:00:00.000Z') });
    for (const body of ['x1', 'x2', 'x3']) b.post({ kind: 'fact', body }, { lane: 'a', by: 'model' });
    expect(bodiesOf(b)).toEqual(['x1', 'x2', 'x3']);
  });

  it('id는 문자열 순서라 note-10이 note-2보다 앞이다(같은 시각)', () => {
    const b = new subject.Board({ topology: 'mesh', now: () => new Date('2026-11-10T00:00:00.000Z'), limits: { writesPerLane: 50 } });
    for (let i = 1; i <= 10; i++) b.post({ kind: 'fact', body: `m${i}` }, { lane: 'a', by: 'model' });
    expect(bodiesOf(b).slice(0, 3)).toEqual(['m1', 'm10', 'm2']);
  });

  it('개수 상한: 같음은 잘리지 않고 +1은 잘린다', () => {
    const three = make({ readLimit: 3 }, [['fact', 'a1'], ['fact', 'a2'], ['fact', 'a3']]);
    expect(three.read({ lane: 'a' })).toMatchObject({ truncated: false });
    expect(three.read({ lane: 'a' }).notes.length).toBe(3);
    const four = make({ readLimit: 3 }, [['fact', 'a1'], ['fact', 'a2'], ['fact', 'a3'], ['fact', 'a4']]);
    const read = four.read({ lane: 'a' });
    expect(read.notes.length).toBe(3);
    expect(read).toMatchObject({ truncated: true, reason: '읽기 예산 또는 개수 상한으로 일부만 돌려줬습니다' });
  });

  it('바이트 예산: 합이 예산과 같으면 들어가고 +1이면 잘린다, 다 못 읽은 레인은 이어서 줄어든다', () => {
    const eight = make({ readBytesPerLane: 8 }, [['fact', 'aaaa'], ['fact', 'bbbb'], ['fact', 'cccc']]);
    const first = eight.read({ lane: 'a' });
    expect(first.notes.map((n) => n.body)).toEqual(['cccc', 'bbbb']);
    expect(first.truncated).toBe(true);
    // 예산 8을 모두 썼으므로 다음 읽기는 빈 목록과 초과 이유
    expect(eight.read({ lane: 'a' })).toEqual({ notes: [], truncated: true, reason: '레인 읽기 예산(8바이트)을 초과했습니다' });
    const seven = make({ readBytesPerLane: 7 }, [['fact', 'aaaa'], ['fact', 'bbbb']]);
    expect(seven.read({ lane: 'a' }).notes.map((n) => n.body)).toEqual(['bbbb']);
    const nine = make({ readBytesPerLane: 9 }, [['fact', 'aaaa'], ['fact', 'bbbb']]);
    const nineRead = nine.read({ lane: 'a' });
    expect(nineRead).toMatchObject({ truncated: false });
    // 남은 예산 1바이트: 같은 두 메모(8바이트)를 더 읽을 수 없다
    expect(nine.read({ lane: 'a' }).notes).toEqual([]);
  });

  it('한 메모가 예산보다 크면 아무것도 고르지 않고 잘림으로 알린다', () => {
    const b = make({ readBytesPerLane: 3 }, [['fact', 'aaaa']]);
    expect(b.read({ lane: 'a' })).toMatchObject({ notes: [], truncated: true });
  });

  it('종류·시각 필터', () => {
    const b = make({}, [['fact', 'f1'], ['contract', 'c1']]);
    expect(b.read({ lane: 'a' }, { kinds: ['fact'] }).notes.map((n) => n.body)).toEqual(['f1']);
    expect(b.read({ lane: 'a' }, { since: '2026-11-10T00:00:00.000Z' }).notes.map((n) => n.body)).toEqual(['c1']);
  });

  it('우선순위가 ±Infinity여도 정렬한다', () => {
    const b = new subject.Board({ topology: 'mesh', now: fixedClock(times) });
    b.post({ kind: 'fact', body: 'low', priority: -Infinity }, { lane: 'a', by: 'model' });
    b.post({ kind: 'fact', body: 'high', priority: Infinity }, { lane: 'a', by: 'model' });
    b.post({ kind: 'contract', body: 'mid', refs: ['r'] }, { lane: 'a', by: 'model' });
    expect(bodiesOf(b)).toEqual(['high', 'mid', 'low']);
  });
});

// ---------------------------------------------------------------------------
// board-mcp 입력 검사와 글
// ---------------------------------------------------------------------------

describe('board-mcp 입력 검사(막는 쪽)', () => {
  const run = async (tool: string, args: Record<string, unknown>) => {
    const board = new subject.Board({ topology: 'mesh', now: () => new Date('2026-11-10T00:00:00.000Z') });
    return subject.runBoardMcpTool(tool, args, externalBoardAccess(board, { lane: 'ext' }));
  };

  const rejected: Array<[string, Record<string, unknown>, string]> = [
    ['kind가 숫자', { kind: 5, body: 'x', refs: [] }, '"kind" must be a string'],
    ['kind가 없음', { body: 'x', refs: [] }, '"kind" must be a string'],
    ['kind가 null', { kind: null, body: 'x', refs: [] }, '"kind" must be a string'],
    ['kind가 배열', { kind: ['fact'], body: 'x', refs: [] }, '"kind" must be a string'],
    ['failure는 받지 않는다', { kind: 'failure', body: 'x', refs: [] }, 'Unknown note kind: failure'],
    ['대소문자', { kind: 'Fact', body: 'x', refs: [] }, 'Unknown note kind: Fact'],
    ['앞 공백', { kind: ' fact', body: 'x', refs: [] }, 'Unknown note kind:  fact'],
    ['뒤 덧붙임', { kind: 'facts', body: 'x', refs: [] }, 'Unknown note kind: facts'],
    ['접두', { kind: 'fac', body: 'x', refs: [] }, 'Unknown note kind: fac'],
    ['빈 kind', { kind: '', body: 'x', refs: [] }, 'Unknown note kind: '],
    ['NUL 덧붙임', { kind: 'fact\u0000', body: 'x', refs: [] }, 'Unknown note kind: fact\u0000'],
    ['body가 숫자', { kind: 'fact', body: 5, refs: [] }, '"body" must be a string'],
    ['body가 없음', { kind: 'fact', refs: [] }, '"body" must be a string'],
    ['refs가 문자열', { kind: 'fact', body: 'x', refs: 'a' }, '"refs" must be an array of strings'],
    ['refs에 숫자', { kind: 'fact', body: 'x', refs: ['a', 1] }, '"refs" must be an array of strings'],
    ['refs에 null', { kind: 'fact', body: 'x', refs: [null] }, '"refs" must be an array of strings'],
    ['refs에 중첩 배열', { kind: 'fact', body: 'x', refs: [['a']] }, '"refs" must be an array of strings'],
    ['refs가 없음', { kind: 'fact', body: 'x' }, '"refs" must be an array of strings'],
    ['검사 순서: kind가 body보다 먼저', { kind: 5, body: 5, refs: 5 }, '"kind" must be a string'],
    ['검사 순서: 알 수 없는 kind가 body보다 먼저', { kind: 'x', body: 5, refs: 5 }, 'Unknown note kind: x'],
    ['검사 순서: body가 refs보다 먼저', { kind: 'fact', body: 5, refs: 5 }, '"body" must be a string'],
  ];
  for (const [name, args, message] of rejected) {
    it(`post_note: ${name}`, async () => {
      expect(await run('post_note', args)).toEqual({ ok: false, content: message });
    });
  }

  const readRejected: Array<[string, Record<string, unknown>, string]> = [
    ['kinds가 문자열', { kinds: 'fact' }, '"kinds" must be an array of strings'],
    ['kinds가 없음', {}, '"kinds" must be an array of strings'],
    ['kinds에 숫자', { kinds: ['fact', 3] }, '"kinds" must be an array of strings'],
    ['알 수 없는 kind', { kinds: ['x'] }, 'Unknown note kind: x'],
    ['첫 번째 알 수 없는 kind를 알린다', { kinds: ['contract', 'x', 'y'] }, 'Unknown note kind: x'],
    ['대소문자', { kinds: ['Fact'] }, 'Unknown note kind: Fact'],
    ['빈 kind', { kinds: [''] }, 'Unknown note kind: '],
    ['배열 검사가 종류 검사보다 먼저', { kinds: ['x', 1] }, '"kinds" must be an array of strings'],
  ];
  for (const [name, args, message] of readRejected) {
    it(`read_notes: ${name}`, async () => {
      expect(await run('read_notes', args)).toEqual({ ok: false, content: message });
    });
  }

  it('받는 입력과 알 수 없는 도구', async () => {
    expect(await run('post_note', { kind: 'contract', body: '계약', refs: ['a.ts'], extra: 1 })).toEqual({ ok: true, content: 'posted note-1 (contract)' });
    expect(await run('post_note', { kind: 'fact', body: 'x', refs: [] })).toEqual({ ok: true, content: 'posted note-1 (fact)' });
    expect(await run('read_notes', { kinds: [] })).toEqual({ ok: true, content: '(no notes)' });
    expect(await run('read_notes', { kinds: ['failure'] })).toEqual({ ok: true, content: '(no notes)' });
    expect(await run('nope', {})).toEqual({ ok: false, content: 'Unknown tool: nope' });
  });

  it('읽은 메모의 글 모양: [kind·priority] lane: 본문 (refs)', async () => {
    const board = new subject.Board({ topology: 'mesh', now: fixedClock(['2026-11-10T00:00:01.000Z', '2026-11-10T00:00:02.000Z', '2026-11-10T00:00:03.000Z', '2026-11-10T00:00:04.000Z', '2026-11-10T00:00:05.000Z']) });
    const access = externalBoardAccess(board, { lane: 'ext' });
    board.post({ kind: 'contract', body: '계약 본문', refs: ['a.ts', 'b ts'] }, { lane: 'lane1', by: 'model' });
    board.post({ kind: 'fact', body: '사실', refs: [] }, { lane: 'lane1', by: 'model' });
    board.post({ kind: 'fact', body: '소수', priority: 2.5 }, { lane: 'lane2', by: 'model' });
    board.post({ kind: 'fact', body: '큰 수', priority: 1e21 }, { lane: 'lane2', by: 'model' });
    board.post({ kind: 'fact', body: '음의 영', priority: -0 }, { lane: 'lane2', by: 'model' });
    const read = await subject.runBoardMcpTool('read_notes', { kinds: [] }, access);
    expect(read.content.split('\n')).toEqual(['[fact·1e+21] lane2: 큰 수', '[fact·2.5] lane2: 소수', '[contract·2] lane1: 계약 본문 (a.ts, b ts)', '[fact·1] lane1: 사실', '[fact·0] lane2: 음의 영']);
  });

  it('의도한 차이: 짝 없는 서로게이트는 글에서 U+FFFD가 된다', async () => {
    const board = new subject.Board({ topology: 'mesh', now: () => new Date('2026-11-10T00:00:00.000Z') });
    const access = externalBoardAccess(board, { lane: 'ext' });
    await subject.runBoardMcpTool('post_note', { kind: 'fact', body: 'a\ud800b', refs: [] }, access);
    const read = await subject.runBoardMcpTool('read_notes', { kinds: [] }, access);
    expect(read.content).toBe('[fact·1] ext: a�b');
  });
});
