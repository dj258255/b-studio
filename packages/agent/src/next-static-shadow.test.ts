import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findStaticShadows, StaticShadowUnknownError } from './next-static-shadow';

const page = 'export default function Page() { return null; }\n';

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'static-shadow-'));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

function check(root: string, pageFile: string, values: Record<string, string>, names: string[] = Object.keys(values)) {
  return findStaticShadows({ root, servicePath: 'web', pageFile, values, check: new Set(names) });
}

describe('findStaticShadows: 값을 채운 동적 경로를 다른 고정 경로가 먼저 받는지 (ADR-159 결정 11)', () => {
  it('같은 폴더의 고정 경로 폴더를 찾는다(page가 없어도, 대소문자가 달라도)', async () => {
    const root = await project({ 'web/app/orders/[id]/page.tsx': page, 'web/app/orders/New/layout.tsx': page });
    expect(await check(root, 'web/app/orders/[id]/page.tsx', { id: 'new' })).toEqual([{ name: 'id', value: 'new', where: 'web/app/orders/New' }]);
  });

  it('겹치는 이름이 없으면 비어 있다. 자기 자신·다른 동적 폴더·인터셉트 라우트·파일은 고정 경로가 아니다', async () => {
    const root = await project({
      'web/app/orders/[id]/page.tsx': page,
      'web/app/orders/[slug]/page.tsx': page,
      'web/app/orders/(.)7/page.tsx': page,
      'web/app/orders/list/page.tsx': page,
      'web/app/orders/7.tsx': page,
    });
    expect(await check(root, 'web/app/orders/[id]/page.tsx', { id: '7' })).toEqual([]);
  });

  it('라우트 그룹과 병렬 라우트 슬롯은 주소에 없으므로 통과해서 본다 — 다른 그룹 가지의 고정 경로도 찾는다', async () => {
    const root = await project({
      'web/app/(shop)/orders/(detail)/[id]/page.tsx': page,
      'web/app/(admin)/(inner)/orders/@modal/new/page.tsx': page,
    });
    expect(await check(root, 'web/app/(shop)/orders/(detail)/[id]/page.tsx', { id: 'new' })).toEqual([
      { name: 'id', value: 'new', where: 'web/app/(admin)/(inner)/orders/@modal/new' },
    ]);
  });

  it('심볼릭 링크로 만든 고정 경로도 겹친 것으로 본다', async () => {
    const root = await project({ 'web/app/orders/[id]/page.tsx': page, 'web/elsewhere/page.tsx': page });
    await symlink(path.join(root, 'web/elsewhere'), path.join(root, 'web/app/orders/new'));
    expect(await check(root, 'web/app/orders/[id]/page.tsx', { id: 'new' })).toEqual([{ name: 'id', value: 'new', where: 'web/app/orders/new' }]);
  });

  it('src/app, pages 라우터의 파일·폴더, public의 정적 파일도 본다', async () => {
    const inPages = await project({ 'web/src/app/orders/[id]/page.tsx': page, 'web/src/pages/orders/new.tsx': page });
    expect(await check(inPages, 'web/src/app/orders/[id]/page.tsx', { id: 'new' })).toEqual([{ name: 'id', value: 'new', where: 'web/src/pages/orders/new.tsx' }]);

    const inPublic = await project({ 'web/app/orders/[id]/edit/page.tsx': page, 'web/public/orders/new/edit': 'static' });
    expect(await check(inPublic, 'web/app/orders/[id]/edit/page.tsx', { id: 'new' })).toEqual([{ name: 'id', value: 'new', where: 'web/public/orders/new/edit' }]);

    const clean = await project({ 'web/app/orders/[id]/page.tsx': page, 'web/pages/orders/list.tsx': page, 'web/public/orders/logo.png': 'x' });
    expect(await check(clean, 'web/app/orders/[id]/page.tsx', { id: 'new' })).toEqual([]);
  });

  it('동적 세그먼트가 여럿이면 확인하라고 한 이름만 보고, 앞 조각은 채운 값이나 동적 폴더를 따라 내려간다', async () => {
    const root = await project({
      'web/app/shops/[shopId]/orders/[id]/page.tsx': page,
      'web/app/shops/[shopId]/orders/new/page.tsx': page,
      'web/app/shops/main/page.tsx': page,
    });
    const file = 'web/app/shops/[shopId]/orders/[id]/page.tsx';
    // shopId=main도 고정 경로(shops/main)와 겹치지만 확인 대상이 아니면 보고하지 않는다
    expect(await check(root, file, { shopId: 'main', id: 'new' }, ['id'])).toEqual([{ name: 'id', value: 'new', where: 'web/app/shops/[shopId]/orders/new' }]);
    expect((await check(root, file, { shopId: 'main', id: '7' })).map((shadow) => shadow.name)).toEqual(['shopId']);
  });

  it('살펴볼 폴더가 상한을 넘거나 page 경로를 알아볼 수 없으면 모른다고 던진다(호출자가 받지 않는 쪽으로 처리)', async () => {
    const files: Record<string, string> = { 'web/app/orders/[id]/page.tsx': page };
    for (let index = 0; index < 6; index += 1) files[`web/app/(g${index})/orders/x/page.tsx`] = page;
    const root = await project(files);
    await expect(findStaticShadows({ root, servicePath: 'web', pageFile: 'web/app/orders/[id]/page.tsx', values: { id: 'new' }, check: new Set(['id']), maxFolders: 5 })).rejects.toBeInstanceOf(
      StaticShadowUnknownError,
    );
    await expect(check(root, 'web/components/Card.tsx', { id: 'new' })).rejects.toBeInstanceOf(StaticShadowUnknownError);
    await expect(check(root, 'web/app/orders/[id]/page.tsx', {}, ['id'])).rejects.toBeInstanceOf(StaticShadowUnknownError);
  });
});
