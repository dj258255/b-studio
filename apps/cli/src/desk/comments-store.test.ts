import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeskComment } from './changes';
import { loadComments, saveComments } from './comments-store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desk-comments-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const comment = (id: string, extra: Partial<DeskComment> = {}): DeskComment => ({ id, file: 'a.ts', line: 1, side: 'new', code: 'x', text: `의견 ${id}`, createdAt: `2026-10-26T00:00:0${id.length}Z`, ...extra });

describe('지금 변경 의견 저장(#924)', () => {
  it('세션마다 따로 남기고 다시 읽는다', () => {
    saveComments(dir, 's1', [comment('a')]);
    saveComments(dir, 's2', [comment('b', { resolved: true })]);
    expect(loadComments(dir, 's1')).toEqual([comment('a')]);
    expect(loadComments(dir, 's2')).toEqual([comment('b', { resolved: true })]);
    expect(loadComments(dir, 'none')).toEqual([]);
  });

  it('빈 목록을 저장하면 그 세션을 지운다', () => {
    saveComments(dir, 's1', [comment('a')]);
    saveComments(dir, 's1', []);
    expect(JSON.parse(readFileSync(join(dir, 'desk-comments.json'), 'utf8')).sessions).toEqual({});
  });

  it('깨진 파일이나 모양이 틀린 의견은 버린다', () => {
    writeFileSync(join(dir, 'desk-comments.json'), '{깨짐');
    expect(loadComments(dir, 's1')).toEqual([]);
    writeFileSync(join(dir, 'desk-comments.json'), JSON.stringify({ sessions: { s1: [comment('a'), { id: 3 }, null] } }));
    expect(loadComments(dir, 's1')).toEqual([comment('a')]);
  });

  it('세션 하나에 너무 많으면 해결한 오래된 의견부터 버린다', () => {
    const many = Array.from({ length: 210 }, (_, index) => comment(`c${index}`, { resolved: index < 20 }));
    saveComments(dir, 's1', many);
    const kept = loadComments(dir, 's1');
    expect(kept).toHaveLength(200);
    expect(kept.filter((entry) => entry.resolved)).toHaveLength(10);
  });
});
