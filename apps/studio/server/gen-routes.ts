/**
 * app 아래 route.ts를 훑어 라우트 표(server/routes.gen.ts)를 만든다. 실행: pnpm --filter @b-studio/studio routes
 *
 * 표를 미리 만들어 두는 까닭: 시작할 때 폴더를 훑지 않아도 되고, import 경로가 소스에 그대로 있어 번들러·타입 검사가 따라간다.
 * 모듈은 표에서 `() => import(...)`로 두어, 처음 불릴 때 불러온다(시작이 빠르고 쓰지 않는 라우트의 의존성을 불러오지 않는다).
 * 라우트를 더하거나 지우면 다시 만들어야 하고, 테스트(routes-gen.test.ts)가 표와 폴더가 같은지 본다
 */
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { routePathOf } from './router';

export interface ScannedRoute {
  pattern: string;
  /** app 기준 상대 경로(`api/health/route.ts`) */
  file: string;
}

async function walk(dir: string, base: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.name === 'route.ts') out.push(path.relative(base, full).split(path.sep).join('/'));
  }
}

export async function scanRoutes(appDir: string): Promise<ScannedRoute[]> {
  const files: string[] = [];
  await walk(appDir, appDir, files);
  return files.map((file) => ({ pattern: routePathOf(file), file })).sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
}

export function renderRoutesModule(routes: readonly ScannedRoute[]): string {
  const lines = routes.map((route) => `  { pattern: ${JSON.stringify(route.pattern)}, load: () => import(${JSON.stringify(`../app/${route.file.replace(/\.ts$/, '')}`)}) },`);
  return [
    '// 이 파일은 server/gen-routes.ts가 만든다. 손으로 고치지 말고 `pnpm --filter @b-studio/studio routes`로 다시 만든다',
    "import type { RouteEntry } from './router';",
    '',
    'export const routes: RouteEntry[] = [',
    ...lines,
    '];',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const studioDir = path.resolve(import.meta.dirname, '..');
  const routes = await scanRoutes(path.join(studioDir, 'app'));
  await writeFile(path.join(studioDir, 'server', 'routes.gen.ts'), renderRoutesModule(routes));
  console.log(`라우트 ${routes.length}개를 server/routes.gen.ts에 적었습니다`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
