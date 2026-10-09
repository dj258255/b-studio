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

  it('겹치는 이름이 없으면 비어 있다. 자기 자신·다른 동적 폴더·인터셉트 라우트는 고정 경로가 아니다', async () => {
    const root = await project({
      'web/app/orders/[id]/page.tsx': page,
      'web/app/orders/[slug]/page.tsx': page,
      'web/app/orders/(.)7/page.tsx': page,
      'web/app/orders/list/page.tsx': page,
      'web/app/orders/70.tsx': page,
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

  it('이름은 넓게 견준다: 인코딩을 풀고, 첫 점 앞까지만 보고, app 라우터의 파일도 겹친 것으로 본다', async () => {
    const encoded = await project({ 'web/app/orders/[id]/page.tsx': page, 'web/app/orders/%5Fnew/page.tsx': page });
    expect(await check(encoded, 'web/app/orders/[id]/page.tsx', { id: '_new' })).toEqual([{ name: 'id', value: '_new', where: 'web/app/orders/%5Fnew' }]);

    const extensions = await project({ 'web/app/orders/[id]/page.tsx': page, 'web/pages/orders/new.page.tsx': page });
    expect(await check(extensions, 'web/app/orders/[id]/page.tsx', { id: 'new' })).toEqual([{ name: 'id', value: 'new', where: 'web/pages/orders/new.page.tsx' }]);

    const metadata = await project({ 'web/app/[id]/page.tsx': page, 'web/app/icon.png': 'x' });
    expect(await check(metadata, 'web/app/[id]/page.tsx', { id: 'icon' })).toEqual([{ name: 'id', value: 'icon', where: 'web/app/icon.png' }]);
  });

  it('page가 src/app에 있어도 app 폴더의 고정 경로를 본다(어느 쪽이 쓰이는지 가리지 않는다)', async () => {
    const root = await project({ 'web/src/app/orders/[id]/page.tsx': page, 'web/app/orders/new/page.tsx': page });
    expect(await check(root, 'web/src/app/orders/[id]/page.tsx', { id: 'new' })).toEqual([{ name: 'id', value: 'new', where: 'web/app/orders/new' }]);
  });

  it('주소를 따라 내려가는 길에 심볼릭 링크가 있으면 따라가지 않고 모른다고 던진다(호스트와 컨테이너에서 다른 곳을 가리킬 수 있다)', async () => {
    const unknown = async (build: (root: string) => Promise<void>, files: Record<string, string> = {}): Promise<void> => {
      const root = await project({ 'web/app/orders/[id]/page.tsx': page, ...files });
      await build(root);
      await expect(check(root, 'web/app/orders/[id]/page.tsx', { id: 'new' })).rejects.toThrow(/심볼릭 링크라 그 너머의 경로를 확인할 수 없습니다/);
    };
    // 컨테이너 안에서만 유효한 절대 경로를 가리키는 링크: 호스트에서는 끊겨 보인다
    await unknown((root) => symlink('/workspace/web/groups', path.join(root, 'web/app/(admin)')));
    await unknown((root) => symlink('/workspace/web/slot', path.join(root, 'web/app/orders/@modal')));
    await unknown((root) => symlink('/workspace/web/legacy-pages', path.join(root, 'web/pages')));
    await unknown((root) => symlink('/workspace/web/static', path.join(root, 'web/public')));
    // 앞 조각과 이름이 같은 폴더가 링크일 때(대소문자만 다른 형제)와 서비스 폴더 자체가 링크일 때
    await unknown((root) => symlink('/workspace/web/other-orders', path.join(root, 'web/pages/orders')), { 'web/pages/index.tsx': page });
    const linkedService = await project({ 'real/app/orders/[id]/page.tsx': page });
    await symlink(path.join(linkedService, 'real'), path.join(linkedService, 'web'));
    await expect(check(linkedService, 'web/app/orders/[id]/page.tsx', { id: 'new' })).rejects.toBeInstanceOf(StaticShadowUnknownError);
  });

  it('주소와 상관없는 자리의 링크는 막지 않는다', async () => {
    const root = await project({ 'web/app/orders/[id]/page.tsx': page, 'web/app/about/page.tsx': page });
    await symlink('/workspace/web/somewhere', path.join(root, 'web/app/docs'));
    await symlink('/workspace/web/somewhere', path.join(root, 'web/app/orders/assets'));
    expect(await check(root, 'web/app/orders/[id]/page.tsx', { id: '7' })).toEqual([]);
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
