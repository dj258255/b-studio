import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 조율 모듈은 Git·샌드박스·작업 공간을 모른다.
 * 조율이 무엇을 넘길지의 규칙만 갖게 하고, 실제 저장·실행은 실행기(agent 밖)가 맡는다.
 * 소스 텍스트를 읽어 import 경계를 강제한다 — 실수로 다시 엮이지 않게.
 */
const BANNED = ['../workspace', '../sandbox', '../checkpoints', '../repository', 'node:child_process'];
/**
 * `@b-studio/sandbox`에서는 Rust 판정 로더(ADR-191 3단계 3i)만 가져온다. 판정은 순수 Rust 크레이트가 하고 이 이름들은 그 판정을 부르는
 * 통로일 뿐이라 Git·샌드박스·작업 공간을 아는 것이 아니다. 샌드박스의 다른 기능을 가져오면 막는다
 */
const SANDBOX_NATIVE_NAMES = new Set(['native', 'encodeNative', 'decodeNative']);

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
      for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@b-studio\/sandbox['"]/g)) {
        for (const name of match[1]!.split(',').map((item) => item.trim()).filter(Boolean)) {
          expect(SANDBOX_NATIVE_NAMES.has(name), `${path.basename(file)}은(는) @b-studio/sandbox에서 ${name}을(를) 가져오지 않는다`).toBe(true);
        }
      }
      // 이름 없는 import(`import * as`, 기본 import)로 통째로 가져오는 것도 막는다
      expect(source, `${path.basename(file)}은(는) @b-studio/sandbox를 통째로 가져오지 않는다`).not.toMatch(/import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+['"]@b-studio\/sandbox['"]/);
    }
  });
});
