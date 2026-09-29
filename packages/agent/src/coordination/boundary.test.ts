import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 조율 모듈은 Git·샌드박스·작업 공간을 모른다.
 * 조율이 무엇을 넘길지의 규칙만 갖게 하고, 실제 저장·실행은 실행기(agent 밖)가 맡는다.
 * 소스 텍스트를 읽어 import 경계를 강제한다 — 실수로 다시 엮이지 않게.
 */
const BANNED = ['../workspace', '../sandbox', '../checkpoints', '../repository', '@b-studio/sandbox', 'node:child_process'];

function coordinationSources(): string[] {
  return readdirSync(import.meta.dirname)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => path.join(import.meta.dirname, file));
}

describe('import 경계', () => {
  it('조율 모듈이 Git·샌드박스·작업 공간을 import하지 않는다', () => {
    const files = coordinationSources();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const banned of BANNED) {
        const where = `${path.basename(file)}은(는) ${banned}을(를) import하지 않는다`;
        expect(source, where).not.toContain(`'${banned}'`);
        expect(source, where).not.toContain(`"${banned}"`);
      }
    }
  });
});
