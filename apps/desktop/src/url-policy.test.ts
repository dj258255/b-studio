import { describe, expect, it } from 'vitest';
import { decideInput, decideUrl, isLocalHost, normalizeInput } from './url-policy';

const STUDIO = 'http://127.0.0.1:3000/';

describe('normalizeInput', () => {
  it('스킴 없이 쓴 로컬 주소에 http://를 붙인다', () => {
    expect(normalizeInput('localhost:3000', STUDIO)).toEqual({ url: 'http://localhost:3000/' });
    expect(normalizeInput('127.0.0.1:3100/orders', STUDIO)).toEqual({ url: 'http://127.0.0.1:3100/orders' });
    // `localhost:`는 URL 파서가 스킴으로 읽어 버리므로 따로 받는다
    expect(normalizeInput('localhost:3000/sessions/abc', STUDIO)).toEqual({ url: 'http://localhost:3000/sessions/abc' });
    expect(normalizeInput('[::1]:3000', STUDIO)).toEqual({ url: 'http://[::1]:3000/' });
    expect(normalizeInput('127.0.0.1', STUDIO)).toEqual({ url: 'http://127.0.0.1/' });
  });

  it('숫자만 입력하면 미리보기 포트로 본다', () => {
    expect(normalizeInput('3100', STUDIO)).toEqual({ url: 'http://127.0.0.1:3100/' });
    expect(normalizeInput(' 80 ', STUDIO)).toEqual({ url: 'http://127.0.0.1:80/' });
    expect(normalizeInput('70000', STUDIO)).toEqual({ reason: '포트 번호가 범위를 벗어났습니다: 70000' });
    expect(normalizeInput('0', STUDIO)).toEqual({ reason: '포트 번호가 범위를 벗어났습니다: 0' });
  });

  it('슬래시가 있든 없든 스튜디오 주소 기준 상대 경로로 푼다', () => {
    expect(normalizeInput('/sessions/abc', STUDIO)).toEqual({ url: 'http://127.0.0.1:3000/sessions/abc' });
    expect(normalizeInput('sessions/abc', STUDIO)).toEqual({ url: 'http://127.0.0.1:3000/sessions/abc' });
    expect(normalizeInput('sessions/abc?tab=diff', STUDIO)).toEqual({ url: 'http://127.0.0.1:3000/sessions/abc?tab=diff' });
    // 스튜디오가 다른 포트면 그 주소를 기준으로 푼다
    expect(normalizeInput('/orders', 'http://127.0.0.1:3100/')).toEqual({ url: 'http://127.0.0.1:3100/orders' });
  });

  it('이미 절대 주소면 그대로 두고, 빈 입력은 거부한다', () => {
    expect(normalizeInput('http://127.0.0.1:3000/sessions/abc', STUDIO)).toEqual({ url: 'http://127.0.0.1:3000/sessions/abc' });
    expect(normalizeInput('https://example.com/x', STUDIO)).toEqual({ url: 'https://example.com/x' });
    expect(normalizeInput('   ', STUDIO)).toEqual({ reason: '주소를 입력하세요' });
  });

  it('http/https가 아닌 스킴은 정규화 단계에서 거부한다', () => {
    expect(normalizeInput('file:///etc/passwd', STUDIO)).toEqual({ reason: '앱 안에서 열지 않는 주소입니다: file:' });
    expect(normalizeInput('javascript:alert(1)', STUDIO)).toEqual({ reason: '앱 안에서 열지 않는 주소입니다: javascript:' });
    expect(normalizeInput('data:text/html,<b>x</b>', STUDIO)).toEqual({ reason: '앱 안에서 열지 않는 주소입니다: data:' });
  });
});

describe('decideInput', () => {
  it('이 PC 주소는 앱 안에서 연다', () => {
    for (const input of ['localhost:3000', '127.0.0.1:3100', 'http://127.0.0.1:3000/sessions/a', 'https://localhost:3000/', '/sessions/a', '3100']) {
      expect(decideInput(input, STUDIO), input).toMatchObject({ kind: 'app' });
    }
  });

  it('외부 주소는 기본 브라우저로 넘긴다', () => {
    // 스튜디오의 PR 링크(깃허브)처럼 앱 밖으로 나가는 주소
    expect(decideInput('https://github.com/dj258255/b-studio/pull/155', STUDIO)).toEqual({
      kind: 'external',
      url: 'https://github.com/dj258255/b-studio/pull/155',
    });
    // 다른 PC·사설망 주소는 이 PC가 아니다
    expect(decideInput('http://192.168.0.5:3000/', STUDIO)).toMatchObject({ kind: 'external' });
    expect(decideInput('https://example.com', STUDIO)).toMatchObject({ kind: 'external' });
  });

  it('스킴 없는 맨 글자는 스튜디오 상대 경로로 본다(도메인은 스킴을 붙여야 브라우저로 간다)', () => {
    // `sessions/abc`를 상대 경로로 받는 규칙의 대가다. 틀린 스킴을 지어내지 않으려고 이렇게 둔다
    expect(decideInput('example.com', STUDIO)).toEqual({ kind: 'app', url: 'http://127.0.0.1:3000/example.com' });
    expect(decideInput('orders/new', STUDIO)).toEqual({ kind: 'app', url: 'http://127.0.0.1:3000/orders/new' });
  });

  it('앱 안에서 열지 않는 입력은 이유와 함께 거부한다', () => {
    expect(decideInput('file:///etc/passwd', STUDIO)).toEqual({ kind: 'reject', reason: '앱 안에서 열지 않는 주소입니다: file:' });
    expect(decideInput('javascript:alert(1)', STUDIO)).toEqual({ kind: 'reject', reason: '앱 안에서 열지 않는 주소입니다: javascript:' });
    expect(decideInput('chrome://settings', STUDIO)).toEqual({ kind: 'reject', reason: '앱 안에서 열지 않는 주소입니다: chrome:' });
    expect(decideInput('', STUDIO)).toEqual({ kind: 'reject', reason: '주소를 입력하세요' });
    expect(decideInput('70000', STUDIO)).toMatchObject({ kind: 'reject' });
  });
});

describe('decideUrl', () => {
  it('절대 주소도 같은 규칙으로 가른다', () => {
    expect(decideUrl('http://127.0.0.1:3000/sessions/abc')).toEqual({ kind: 'app', url: 'http://127.0.0.1:3000/sessions/abc' });
    expect(decideUrl('http://localhost:3100/orders/1')).toMatchObject({ kind: 'app' });
    expect(decideUrl('https://www.figma.com/file/abc/x')).toMatchObject({ kind: 'external' });
    expect(decideUrl('file:///tmp/x')).toMatchObject({ kind: 'reject' });
    expect(decideUrl('about:blank')).toMatchObject({ kind: 'reject' });
    expect(decideUrl('javascript:void(0)')).toMatchObject({ kind: 'reject' });
    expect(decideUrl('그냥 문장')).toMatchObject({ kind: 'reject' });
  });

  it('루프백처럼 보이는 다른 호스트는 앱 안에서 열지 않는다', () => {
    expect(decideUrl('http://127.0.0.1.evil.example.com/')).toMatchObject({ kind: 'external' });
    expect(decideUrl('http://localhost.evil.example.com/')).toMatchObject({ kind: 'external' });
  });
});

describe('isLocalHost', () => {
  it('이 PC 루프백만 참이다', () => {
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]']) expect(isLocalHost(host), host).toBe(true);
    for (const host of ['example.com', '127.0.0.1.evil.com', '0.0.0.0', '192.168.0.5', 'localhost.localdomain']) expect(isLocalHost(host), host).toBe(false);
  });
});
