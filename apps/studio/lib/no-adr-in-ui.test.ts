import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 번호(ADR-073 등)는 내부 설계 결정 참조라 코드 주석에만 쓴다 — 화면에 보이는 문구(JSX 텍스트·라벨·
 * placeholder 등)에 새면 사용자가 알 수 없는 내부 표기를 보게 된다. 주석을 정규식으로 걷어낸 나머지에서
 * ADR-숫자가 남아 있으면 화면 문구에 섞인 것으로 본다(완벽한 파서는 아니지만 이 저장소 코드 스타일에는 충분하다).
 */
const ROOTS = ['components', 'app'];

function listTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsxFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) && !entry.name.endsWith('.test.tsx') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** 블록·줄 주석을 걷어낸다(이 저장소의 주석 스타일에 맞춘 단순한 근사치) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('화면 문구에 ADR 번호가 남아 있지 않아야 한다', () => {
  const studioRoot = path.resolve(import.meta.dirname, '..');

  it('components·app의 .ts·.tsx 파일 중 주석 밖에 ADR-숫자가 있는 파일이 없다', () => {
    const offenders: Array<{ file: string; match: string }> = [];
    for (const root of ROOTS) {
      const dir = path.join(studioRoot, root);
      for (const file of listTsxFiles(dir)) {
        const code = stripComments(readFileSync(file, 'utf8'));
        const match = code.match(/ADR-\d+/);
        if (match) offenders.push({ file: path.relative(studioRoot, file), match: match[0] });
      }
    }
    expect(offenders).toEqual([]);
  });
});
