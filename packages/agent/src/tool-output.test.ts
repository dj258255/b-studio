import { describe, expect, it } from 'vitest';
import {
  clipCommandOutput,
  clipText,
  COMMAND_OUTPUT_BUDGET,
  createToolResultCache,
  dedupeResult,
  HTTP_BODY_BUDGET,
  invalidateReadCache,
  isHtmlContent,
  isRepeatNote,
  READ_FILE_BUDGET,
  repeatNote,
  visibleHtml,
} from './tool-output';

describe('clipCommandOutput', () => {
  it('예산 안이면 그대로 둔다', () => {
    expect(clipCommandOutput('short output')).toBe('short output');
    expect(clipCommandOutput('x'.repeat(COMMAND_OUTPUT_BUDGET))).toHaveLength(COMMAND_OUTPUT_BUDGET);
  });

  it('예산을 넘으면 뒤쪽 위주로 남기고, 잃은 양과 다시 좁히라는 안내를 한 줄로 넣는다', () => {
    // 실패 요약이 뒤에 있는 로그를 흉내 낸다
    const text = `${'a'.repeat(10_000)}FAILURE: could not compile`;
    const clipped = clipCommandOutput(text, 1_000);
    expect(clipped.startsWith('a'.repeat(250))).toBe(true);
    expect(clipped.endsWith('FAILURE: could not compile')).toBe(true);
    expect(clipped).toContain('전체 10026자 중 9026자 생략');
    expect(clipped).toContain('grep·tail로 좁혀 다시 실행');
    // 앞 25%·뒤 75%: 뒤쪽이 더 길다
    const [head, , tail] = clipped.split('\n');
    expect(tail!.length).toBeGreaterThan(head!.length);
  });
});

describe('clipText', () => {
  it('예산 안이면 그대로, 넘으면 앞쪽 위주로 남긴다', () => {
    expect(clipText('short', 100)).toBe('short');
    const text = 'H'.repeat(900) + 'T'.repeat(100);
    const clipped = clipText(text, 100);
    expect(clipped.startsWith('H'.repeat(80))).toBe(true);
    expect(clipped.endsWith('T'.repeat(20))).toBe(true);
    expect(clipped).toContain('전체 1000자 중 900자 생략');
  });

  it('read_file 예산은 12,000자다', () => {
    expect(READ_FILE_BUDGET).toBe(12_000);
    expect(clipText('x'.repeat(READ_FILE_BUDGET + 1), READ_FILE_BUDGET)).toContain('1자 생략');
  });
});

describe('visibleHtml', () => {
  it('script·style·noscript·주석을 지우고 태그를 벗겨 보이는 글자만 남긴다', () => {
    const html = `<!DOCTYPE html>
<html><head><title>주문 목록</title><style>body{color:red}</style>
<script>if (1 < 2) { document.write("<div>hi</div>"); }</script></head>
<body><!-- 숨은 주석 --><h1>주문</h1><p>안녕 &amp; 환영</p><noscript>자바스크립트를 켜세요</noscript></body></html>`;
    const text = visibleHtml(html);
    expect(text).toContain('주문 목록');
    expect(text).toContain('주문');
    expect(text).toContain('안녕 & 환영');
    // 스크립트 안의 `<`가 태그로 새지 않는다
    expect(text).not.toContain('document.write');
    expect(text).not.toContain('hi');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('주석');
    expect(text).not.toContain('자바스크립트를 켜세요');
    expect(text).not.toContain('<');
  });

  it('HTML 판별은 content-type 또는 문서 시작으로 본다', () => {
    expect(isHtmlContent('text/html; charset=utf-8', 'anything')).toBe(true);
    expect(isHtmlContent('application/xhtml+xml', 'anything')).toBe(true);
    expect(isHtmlContent('application/json', '<!DOCTYPE html><p>')).toBe(true);
    expect(isHtmlContent(undefined, '  <html lang="ko">')).toBe(true);
    expect(isHtmlContent('application/json', '{"a":1}')).toBe(false);
    expect(isHtmlContent(undefined, 'plain text')).toBe(false);
  });

  it('HTTP 본문 예산은 4,000자다', () => {
    expect(HTTP_BODY_BUDGET).toBe(4_000);
  });
});

describe('dedupeResult', () => {
  it('같은 도구·같은 입력의 결과가 앞과 완전히 같으면 참조로 바꾼다', () => {
    const cache = createToolResultCache();
    expect(dedupeResult(cache, 'read_file', { path: 'a.ts' }, 'same')).toBe('same');
    expect(dedupeResult(cache, 'read_file', { path: 'a.ts' }, 'same')).toBe(repeatNote(1));
    expect(isRepeatNote(repeatNote(1))).toBe(true);
    // 결과가 다르면 그대로 돌려주고 새 결과로 갱신한다
    expect(dedupeResult(cache, 'read_file', { path: 'a.ts' }, 'changed')).toBe('changed');
    expect(dedupeResult(cache, 'read_file', { path: 'a.ts' }, 'changed')).toBe(repeatNote(3));
  });

  it('입력 객체의 키 순서가 달라도 같은 호출로 본다', () => {
    const cache = createToolResultCache();
    dedupeResult(cache, 'list_files', { path: '.', depth: 2 }, 'same');
    expect(dedupeResult(cache, 'list_files', { depth: 2, path: '.' }, 'same')).toBe(repeatNote(1));
  });

  it('도구가 다르면 다른 호출이다', () => {
    const cache = createToolResultCache();
    dedupeResult(cache, 'read_file', { path: 'a' }, 'same');
    expect(dedupeResult(cache, 'list_files', { path: 'a' }, 'same')).toBe('same');
  });
});

describe('invalidateReadCache', () => {
  it('쓰기 도구 뒤에는 읽기 캐시를 비우고, 다른 도구 캐시는 남긴다', () => {
    const cache = createToolResultCache();
    dedupeResult(cache, 'read_file', { path: 'a' }, 'same');
    dedupeResult(cache, 'list_files', { path: '.' }, 'same');
    dedupeResult(cache, 'run_in_service', { command: ['ls'] }, 'same');

    invalidateReadCache(cache);

    // 읽기는 캐시가 비워져 다시 본문을 돌려준다
    expect(dedupeResult(cache, 'read_file', { path: 'a' }, 'same')).toBe('same');
    expect(dedupeResult(cache, 'list_files', { path: '.' }, 'same')).toBe('same');
    // 다른 도구는 캐시가 남아 참조로 바뀐다
    expect(dedupeResult(cache, 'run_in_service', { command: ['ls'] }, 'same')).toBe(repeatNote(3));
  });
});
