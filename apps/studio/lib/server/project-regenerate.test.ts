import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GENERATED_COMPOSE } from './project-detect';
import { applyGeneratedFilesToWorkingCopy, applyRegeneration, findRegisteredProject, proposeRegeneration, readRegistry, registerFolder } from './project-registry';

const made: string[] = [];

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-regenerate-'));
  made.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const nextPackageNoLock = JSON.stringify({ name: 'shop', dependencies: { next: '16.0.0', react: '19.0.0' } });

describe('proposeRegeneration / applyRegeneration(ADR-0XX, 생성 파일 다시 만들기)', () => {
  it('직접 만든 studio.yaml을 쓰는 프로젝트는 다시 만들 것이 없다고 한다(해시를 기록한 적이 없다)', async () => {
    const root = await repo({
      'studio.yaml': 'version: 1\nname: hand\nservices:\n  legacy:\n    source: external\n    baseUrl: https://example.com\n',
      'compose.yaml': 'services: {}\n',
    });
    const registry = path.join(await repo({}), 'projects.json');
    const registered = await registerFolder(root, new Set(), registry);

    const proposal = await proposeRegeneration(registered.id, registry);

    expect(proposal.eligible).toBe(false);
    expect(proposal.reason).toContain('직접 만든 studio.yaml');
    expect(proposal.files).toEqual([]);
  });

  it('등록한 적 없는 id는 404로 거부한다', async () => {
    const registry = path.join(await repo({}), 'projects.json');
    await expect(proposeRegeneration('없는-id', registry)).rejects.toMatchObject({ status: 404 });
  });

  it('등록 직후에는 디스크 내용과 새로 만들 내용이 같아 changed가 모두 false다', async () => {
    const root = await repo({ 'package.json': nextPackageNoLock });
    const registry = path.join(await repo({}), 'projects.json');
    const registered = await registerFolder(root, new Set(), registry);

    const proposal = await proposeRegeneration(registered.id, registry);

    expect(proposal.eligible).toBe(true);
    expect(proposal.files.length).toBeGreaterThan(0);
    expect(proposal.files.every((file) => !file.changed)).toBe(true);
    expect(proposal.files.every((file) => !file.handEdited)).toBe(true);
  });

  it('등록한 뒤 프로젝트가 바뀌면(pnpm 잠금 파일이 생김) 그 변화가 diff로 드러나고, 고른 파일만 다시 쓴다', async () => {
    const root = await repo({ 'package.json': nextPackageNoLock });
    const registry = path.join(await repo({}), 'projects.json');
    const registered = await registerFolder(root, new Set(), registry);
    const before = await readFile(path.join(root, GENERATED_COMPOSE), 'utf8');

    // 처음엔 잠금 파일이 없어 npm으로 잡았는데, 이제 pnpm으로 바꿨다 — Dockerfile·compose 내용이 달라져야 한다
    await writeFile(path.join(root, 'pnpm-lock.yaml'), '');

    const proposal = await proposeRegeneration(registered.id, registry);
    const changed = proposal.files.filter((file) => file.changed);
    expect(changed.length).toBeGreaterThan(0);
    const dockerfile = changed.find((file) => file.path.endsWith('Dockerfile.b-studio'));
    expect(dockerfile?.diff).toContain('diff --git');
    expect(dockerfile?.newContent).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile?.oldContent).not.toContain('pnpm install --frozen-lockfile');

    const { written } = await applyRegeneration(registered.id, [dockerfile!.path], registry);
    expect(written).toEqual([dockerfile!.path]);
    // 고르지 않은 compose.b-studio.yaml은 그대로다
    expect(await readFile(path.join(root, GENERATED_COMPOSE), 'utf8')).toBe(before);
    expect(await readFile(path.join(root, dockerfile!.path), 'utf8')).toBe(dockerfile!.newContent);

    // 다시 쓴 파일의 해시가 레지스트리에 갱신됐다 — 재규성해도 더는 "바뀜"으로 보이지 않는다
    const again = await proposeRegeneration(registered.id, registry);
    expect(again.files.find((file) => file.path === dockerfile!.path)?.changed).toBe(false);
  });

  it('손으로 고친 생성 파일은 handEdited로 경고하고, 덮어쓰지 않으면 그대로 남는다', async () => {
    const root = await repo({ 'package.json': nextPackageNoLock });
    const registry = path.join(await repo({}), 'projects.json');
    const registered = await registerFolder(root, new Set(), registry);

    // b-studio가 쓴 적 없는 손편집 — 해시가 레지스트리 값과 달라진다
    const handEdited = '# 내가 손으로 고쳤다\nversion: 1\nname: shop\nservices: {}\n';
    await writeFile(path.join(root, 'studio.yaml'), handEdited);
    // 실제 변화도 있어야 changed도 true가 된다(아니면 핸드에딧이어도 다시 쓸 이유가 없다는 뜻)
    await writeFile(path.join(root, 'pnpm-lock.yaml'), '');

    const proposal = await proposeRegeneration(registered.id, registry);
    const specFile = proposal.files.find((file) => file.path === 'studio.yaml')!;
    expect(specFile.handEdited).toBe(true);
    expect(specFile.changed).toBe(true);
    expect(specFile.oldContent).toBe(handEdited);

    // 덮어쓰기를 고르지 않으면(미리보기가 경고했는데도 무시하고 비워 두면) 손댄 내용이 남는다
    await applyRegeneration(registered.id, [], registry);
    expect(await readFile(path.join(root, 'studio.yaml'), 'utf8')).toBe(handEdited);
  });

  it('경고를 보고도 덮어쓰기를 고르면 손으로 고친 내용이 사라진다', async () => {
    const root = await repo({ 'package.json': nextPackageNoLock });
    const registry = path.join(await repo({}), 'projects.json');
    const registered = await registerFolder(root, new Set(), registry);
    await writeFile(path.join(root, 'studio.yaml'), '# 손으로 고쳤다\nversion: 1\nname: shop\nservices: {}\n');
    await writeFile(path.join(root, 'pnpm-lock.yaml'), '');

    const proposal = await proposeRegeneration(registered.id, registry);
    const specFile = proposal.files.find((file) => file.path === 'studio.yaml')!;

    const { written } = await applyRegeneration(registered.id, [specFile.path], registry);
    expect(written).toEqual(['studio.yaml']);
    const content = await readFile(path.join(root, 'studio.yaml'), 'utf8');
    expect(content).not.toContain('손으로 고쳤다');
    expect(content).toBe(specFile.newContent);
  });

  it('지금은 이 폴더에서 돌릴 서비스를 찾지 못하면(코드가 사라진 경우) eligible: false로 알린다', async () => {
    const root = await repo({ 'package.json': nextPackageNoLock });
    const registry = path.join(await repo({}), 'projects.json');
    const registered = await registerFolder(root, new Set(), registry);
    await rm(path.join(root, 'package.json'));

    const proposal = await proposeRegeneration(registered.id, registry);
    expect(proposal.eligible).toBe(false);
    expect(proposal.files).toEqual([]);
  });

  it('eligible: false면 applyRegeneration은 아무것도 쓰지 않고 거부한다', async () => {
    const root = await repo({
      'studio.yaml': 'version: 1\nname: hand\nservices:\n  legacy:\n    source: external\n    baseUrl: https://example.com\n',
      'compose.yaml': 'services: {}\n',
    });
    const registry = path.join(await repo({}), 'projects.json');
    const registered = await registerFolder(root, new Set(), registry);

    await expect(applyRegeneration(registered.id, ['studio.yaml'], registry)).rejects.toMatchObject({ status: 409 });
  });

  it('registerFolder가 이번에 쓴 파일의 해시를 레지스트리에 남긴다', async () => {
    const root = await repo({ 'package.json': nextPackageNoLock });
    const registry = path.join(await repo({}), 'projects.json');
    const registered = await registerFolder(root, new Set(), registry);

    const entry = await findRegisteredProject(registered.id, registry);
    expect(entry?.generatedHashes).toBeDefined();
    expect(Object.keys(entry!.generatedHashes!).sort()).toEqual(['Dockerfile.b-studio', GENERATED_COMPOSE, 'studio.yaml'].sort());

    const all = await readRegistry(registry);
    expect(all).toHaveLength(1);
  });
});

describe('applyGeneratedFilesToWorkingCopy(ADR-0XX, "이 세션에도 적용")', () => {
  it('지정한 파일만 덮어쓰고, 없는 파일은 건너뛰고, git 추적에서 뺀다', async () => {
    const source = await repo({ 'studio.yaml': 'version: 1\n새 내용\n' });
    const projectRoot = await repo({ 'studio.yaml': '옛 내용\n', '.git': '' });
    // 작업 복사본의 .git은 디렉터리여야 excludeFromGit이 뺀다
    await rm(path.join(projectRoot, '.git'));
    await mkdir(path.join(projectRoot, '.git', 'info'), { recursive: true });

    const copied = await applyGeneratedFilesToWorkingCopy(source, projectRoot, projectRoot, ['studio.yaml', 'no-such-file.yaml']);

    expect(copied).toEqual(['studio.yaml']);
    expect(await readFile(path.join(projectRoot, 'studio.yaml'), 'utf8')).toBe('version: 1\n새 내용\n');
    const exclude = await readFile(path.join(projectRoot, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/studio.yaml');
  });

  it('소스 폴더에 그 파일이 전혀 없으면 아무것도 복사하지 않는다', async () => {
    const source = await repo({});
    const projectRoot = await repo({});
    await mkdir(path.join(projectRoot, '.git'), { recursive: true });

    const copied = await applyGeneratedFilesToWorkingCopy(source, projectRoot, projectRoot, ['studio.yaml']);
    expect(copied).toEqual([]);
    await expect(stat(path.join(projectRoot, 'studio.yaml'))).rejects.toThrow();
  });
});
