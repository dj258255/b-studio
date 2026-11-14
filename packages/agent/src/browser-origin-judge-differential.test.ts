import { describe, expect, it } from 'vitest';
import { native } from '@b-studio/sandbox';
import { isAllowedRequest } from './browser-check';

/**
 * 출처 판정을 Rust(`browserIsAllowedUrl`, `url` 크레이트)와 TS(`isAllowedRequest`, WHATWG `new URL`)가 같은 입력에 같은 답을 내는지 견준다(ADR-199).
 * Rust 러너의 요청 가로채기와 프록시는 Rust 판정을, 옛 러너는 TS 판정을 쓴다. 한쪽이 더 넓게 열리면 막는 검사가 열린다.
 */

const ALLOWED = ['http://127.0.0.1:5173', 'http://localhost:3000', 'https://app.example.test', 'http://[::1]:8080', 'http://example.test', 'http://xn--bcher-kva.example'];

const URLS = [
  // 평범한 것
  'http://127.0.0.1:5173/',
  'http://127.0.0.1:5173/a/b?c=d#e',
  'http://127.0.0.1:5174/',
  'http://localhost:3000/x',
  'http://LOCALHOST:3000/x',
  'https://app.example.test/x',
  'https://app.example.test:443/x',
  'http://app.example.test/x',
  'http://example.test:80/x',
  'http://example.test:8080/x',
  'http://[::1]:8080/x',
  'http://[0:0:0:0:0:0:0:1]:8080/x',
  // 사용자 정보·경로 꼴이 섞인 것
  'http://user:pw@127.0.0.1:5173/',
  'http://127.0.0.1:5173@evil.test/',
  'http://evil.test\\@127.0.0.1:5173/',
  'http://127.0.0.1:5173\\@evil.test/',
  'http://evil.test#@127.0.0.1:5173/',
  'http://127.0.0.1:5173.evil.test/',
  'http://evil.test/http://127.0.0.1:5173/',
  // 호스트 표기가 다른 것(IPv4 줄임·16진·8진, 끝의 점, 대소문자, 전각)
  'http://127.1:5173/',
  'http://0x7f.0.0.1:5173/',
  'http://0177.0.0.1:5173/',
  'http://2130706433:5173/',
  'http://127.0.0.1.:5173/',
  'http://127.0.0.1%2e:5173/',
  'http://１２７.０.０.１:5173/',
  'http://LocalHost.:3000/',
  'http://ｌｏｃａｌｈｏｓｔ:3000/',
  'http://bücher.example/',
  'http://xn--bcher-kva.example/',
  'http://BÜCHER.example/',
  // 스킴
  'HTTP://127.0.0.1:5173/',
  'https://127.0.0.1:5173/',
  'ws://127.0.0.1:5173/socket',
  'wss://app.example.test/socket',
  'ftp://127.0.0.1:5173/',
  'file:///etc/passwd',
  'file://127.0.0.1:5173/x',
  'javascript:alert(1)',
  'chrome://version',
  'chrome-error://chromewebdata/',
  // 내부 스킴은 연다
  'data:text/plain,hello',
  'data:text/html;base64,PGgxPng8L2gxPg==',
  'blob:http://127.0.0.1:5173/uuid',
  'blob:http://evil.test/uuid',
  'about:blank',
  'about:srcdoc',
  // 파싱할 수 없는 것
  '',
  ' ',
  '/relative/path',
  '//127.0.0.1:5173/x',
  'http://',
  'http:///x',
  'http://[::1',
  'http://127.0.0.1:99999/',
  'http://127.0.0.1:-1/',
  'not a url',
  'http://exa mple.test/',
  'http://a b/',
  ':',
  // 포트 표기
  'http://127.0.0.1:05173/',
  'http://127.0.0.1:5173:80/',
  'http://127.0.0.1:/',
  'http://localhost:3000./x',
  // 제어 문자·공백·탭
  'http://127.0.0.1:5173/\t',
  'http://127.0.0.1:\t5173/',
  'http://127.0.0.1\n:5173/',
  '  http://127.0.0.1:5173/  ',
  'http://127.0.0.1:5173/%00',
];

describe('출처 판정: Rust(url 크레이트)와 TS(WHATWG URL)는 같은 입력에 같은 답을 낸다', () => {
  it('허용 목록이 있을 때 모든 URL에서 답이 같다', () => {
    const allowed = new Set(ALLOWED);
    const mismatches: string[] = [];
    for (const url of URLS) {
      const ts = isAllowedRequest(url, allowed);
      const rust = native.browserIsAllowedUrl(url, ALLOWED);
      if (ts !== rust) mismatches.push(`${JSON.stringify(url)}: ts=${ts} rust=${rust}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('허용 목록이 비면 내부 스킴 말고는 모두 막는다', () => {
    for (const url of URLS) {
      expect(native.browserIsAllowedUrl(url, []), url).toBe(isAllowedRequest(url, new Set()));
    }
    expect(native.browserIsAllowedUrl('http://127.0.0.1:5173/', [])).toBe(false);
    expect(native.browserIsAllowedUrl('data:text/plain,x', [])).toBe(true);
  });

  it('다른 허용 목록에서도 같다', () => {
    for (const list of [['http://127.0.0.1:5173'], ['https://app.example.test', 'http://example.test'], ['null'], ['http://localhost:3000', 'http://127.0.0.1:3000']]) {
      const allowed = new Set(list);
      for (const url of URLS) expect(native.browserIsAllowedUrl(url, list), `${url} ${list.join()}`).toBe(isAllowedRequest(url, allowed));
    }
  });
});
