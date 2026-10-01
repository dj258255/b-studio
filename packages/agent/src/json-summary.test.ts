import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_JSON_SUMMARY_BYTES, summarizeJsonContent, summarizeJsonStructure, summarizeLargeJsonFile } from './json-summary';

describe('summarizeJsonStructure', () => {
  it('배열이면 길이를 담는다', () => {
    expect(summarizeJsonStructure([1, 2, 3])).toBe('배열, 3개 항목');
  });

  it('배열의 첫 항목이 객체면 필드 이름·타입을 함께 담는다', () => {
    const parsed = [
      { id: 1, name: '김철수', tags: ['a', 'b'], active: true, deletedAt: null },
      { id: 2, name: '이영희', tags: [], active: false, deletedAt: null },
    ];
    expect(summarizeJsonStructure(parsed)).toBe('배열, 2개 항목 · 첫 항목 필드: id: number, name: string, tags: 배열(2), active: boolean, deletedAt: null');
  });

  it('배열의 첫 항목이 원시값이면 필드를 덧붙이지 않는다', () => {
    expect(summarizeJsonStructure(['a', 'b'])).toBe('배열, 2개 항목');
  });

  it('객체면 키마다(배열 값이면 길이와 함께) 나열한다', () => {
    const parsed = { posts: new Array(42).fill(0), comments: new Array(2076).fill(0), meta: { ok: true } };
    expect(summarizeJsonStructure(parsed)).toBe('posts 42개, comments 2,076개, meta');
  });

  it('빈 객체는 "(빈 객체)"', () => {
    expect(summarizeJsonStructure({})).toBe('(빈 객체)');
  });
});

describe('summarizeJsonContent', () => {
  it('JSON 문자열을 파싱해 요약한다', () => {
    expect(summarizeJsonContent(JSON.stringify([1, 2, 3]))).toBe('배열, 3개 항목');
  });

  it('JSON이 아니면 undefined', () => {
    expect(summarizeJsonContent('그냥 텍스트')).toBeUndefined();
  });
});

describe('summarizeLargeJsonFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'json-summary-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('256KB를 넘는 JSON도 전체를 읽어 구조를 요약한다(seed.json 같은 시드 파일)', async () => {
    const records = Array.from({ length: 9000 }, (_, index) => ({ id: index, name: `item-${index}`, price: index * 100 }));
    const content = JSON.stringify(records);
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    expect(sizeBytes).toBeGreaterThan(256 * 1024); // 실제로 256KB 상한을 넘기는 크기인지 확인
    await writeFile(path.join(root, 'seed.json'), content);

    const summary = await summarizeLargeJsonFile(root, 'seed.json', sizeBytes);
    expect(summary).toBe('배열, 9,000개 항목 · 첫 항목 필드: id: number, name: string, price: number');
  });

  it('.json이 아니면 undefined(호출하는 쪽이 기존 "너무 커서" 메시지를 쓴다)', async () => {
    await writeFile(path.join(root, 'seed.csv'), 'a,b,c');
    expect(await summarizeLargeJsonFile(root, 'seed.csv', 1000)).toBeUndefined();
  });

  it('MAX_JSON_SUMMARY_BYTES를 넘으면 읽지 않고 undefined', async () => {
    expect(await summarizeLargeJsonFile(root, 'seed.json', MAX_JSON_SUMMARY_BYTES + 1)).toBeUndefined();
  });

  it('파일이 없으면 undefined', async () => {
    expect(await summarizeLargeJsonFile(root, 'nope.json', 300_000)).toBeUndefined();
  });

  it('JSON이 깨졌으면 undefined', async () => {
    await writeFile(path.join(root, 'broken.json'), '{"a": '.repeat(100_000));
    const sizeBytes = Buffer.byteLength('{"a": '.repeat(100_000), 'utf8');
    expect(await summarizeLargeJsonFile(root, 'broken.json', sizeBytes)).toBeUndefined();
  });
});
