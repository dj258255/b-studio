import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 스튜디오는 Next 없이 node:http 서버(server/main.ts)로만 돈다(ADR-188). 화면이 없으니 Next·React를 다시 끌어들이지 않는다.
 * 남은 Next 흔적(설정 파일, 의존성, 'next/*' import, next typegen)이 생기면 여기서 막는다
 */
const studioDir = path.resolve(import.meta.dirname, '..');

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('스튜디오는 Next 없이 돈다', () => {
  it('package.json에 Next·React 의존성과 next 명령이 없다', async () => {
    const pkg = JSON.parse(await readFile(path.join(studioDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((name) => /^(next|react|react-dom|@types\/react|@types\/react-dom|eslint-config-next)$/.test(name))).toEqual([]);
    expect(Object.values(pkg.scripts ?? {}).filter((script) => /\bnext\b/.test(script))).toEqual([]);
  });

  it('Next 설정·진입 파일이 없다', async () => {
    const names = await readdir(studioDir);
    expect(names.filter((name) => /^(next\.config\.\w+|next-env\.d\.ts|proxy\.ts|instrumentation\.ts)$/.test(name))).toEqual([]);
  });

  it('서버 코드가 next·react를 불러오지 않는다(예제 앱을 만드는 e2e 글은 빼고)', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(studioDir)) {
      if (file.includes(`${path.sep}e2e${path.sep}`)) continue;
      const text = await readFile(file, 'utf8');
      if (/from\s+['"](next|react|react-dom)(\/[^'"]*)?['"]|import\(\s*['"](next|react)(\/[^'"]*)?['"]\s*\)/.test(text)) offenders.push(path.relative(studioDir, file));
    }
    expect(offenders).toEqual([]);
  });

  it('tsconfig가 Next 플러그인·생성 타입에 기대지 않는다', async () => {
    const tsconfig = await readFile(path.join(studioDir, 'tsconfig.json'), 'utf8');
    expect(tsconfig).not.toMatch(/"name":\s*"next"|next-env\.d\.ts|\.next\//);
  });
});
