import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 고정 경로 판정(3aa)의 벡터·차등 시험이 함께 쓰는 임시 프로젝트 만들기. 시험 파일만 쓴다 */
export function buildProject(files: readonly string[], links: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'static-shadow-'));
  for (const file of files) {
    // 이름이 `/`로 끝나면 빈 폴더
    const absolute = path.join(root, file);
    if (file.endsWith('/')) {
      mkdirSync(absolute, { recursive: true });
      continue;
    }
    try {
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, 'x');
    } catch {
      // 앞 항목이 같은 이름의 파일이라 만들 수 없는 조합은 건너뛴다
    }
  }
  for (const [link, target] of Object.entries(links)) {
    const absolute = path.join(root, link);
    try {
      mkdirSync(path.dirname(absolute), { recursive: true });
      symlinkSync(target.replace('@root', root), absolute);
    } catch {
      // 이미 있는 이름이면 건너뛴다
    }
  }
  return root;
}
