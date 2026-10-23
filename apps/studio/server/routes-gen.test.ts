import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderRoutesModule, scanRoutes } from './gen-routes';
import { routes } from './routes.gen';

const studioDir = path.resolve(import.meta.dirname, '..');

describe('라우트 표(routes.gen.ts)', () => {
  it('app 아래 route.ts 전체와 같다(라우트를 더하거나 지웠으면 pnpm --filter @b-studio/studio routes로 다시 만든다)', async () => {
    const scanned = await scanRoutes(path.join(studioDir, 'app'));
    expect(routes.map((route) => route.pattern)).toEqual(scanned.map((route) => route.pattern));
    expect(await readFile(path.join(studioDir, 'server', 'routes.gen.ts'), 'utf8')).toBe(renderRoutesModule(scanned));
  });

  it('API 라우트와 로컬 토큰 교환 페이지를 담는다', () => {
    const patterns = routes.map((route) => route.pattern);
    expect(patterns).toContain('/api/health');
    expect(patterns).toContain('/api/sessions/[id]/artifacts/[...path]');
    expect(patterns).toContain('/local-auth');
    expect(patterns.length).toBeGreaterThan(100);
  });
});
