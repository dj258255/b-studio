import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { overlayGeneratedFiles } from './project-registry';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-overlay-'));
  roots.push(dir);
  return dir;
}

describe('overlayGeneratedFiles', () => {
  it('두 단계 아래 서비스(apps/web, commerce/consumer-app)의 Dockerfile.b-studio도 세션 복사본에 넣는다', async () => {
    const source = await tempDir();
    const copy = await tempDir();
    await mkdir(path.join(copy, '.git', 'info'), { recursive: true });
    for (const relative of ['studio.yaml', 'compose.b-studio.yaml', 'commerce/Dockerfile.b-studio', 'apps/web/Dockerfile.b-studio', 'commerce/consumer-app/Dockerfile.b-studio']) {
      await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
      await writeFile(path.join(source, relative), `# ${relative}\n`);
    }
    // 건너뛸 폴더 안의 같은 이름 파일은 서비스가 아니다
    await mkdir(path.join(source, 'apps', 'web', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(source, 'apps', 'web', 'node_modules', 'Dockerfile.b-studio'), 'x');

    const copied = await overlayGeneratedFiles(source, copy, copy);

    expect(copied.sort()).toEqual(
      ['apps/web/Dockerfile.b-studio', 'commerce/Dockerfile.b-studio', 'commerce/consumer-app/Dockerfile.b-studio', 'compose.b-studio.yaml', 'studio.yaml'].sort(),
    );
    expect(await readFile(path.join(copy, 'apps/web/Dockerfile.b-studio'), 'utf8')).toBe('# apps/web/Dockerfile.b-studio\n');
    const exclude = await readFile(path.join(copy, '.git', 'info', 'exclude'), 'utf8');
    // Dockerfile.b-studio는 경로 없는 패턴 한 줄로 모든 깊이를 무시한다
    expect(exclude.split('\n')).toContain('Dockerfile.b-studio');
  });
});
