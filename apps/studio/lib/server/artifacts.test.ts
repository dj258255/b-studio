import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactError, artifactRoot, MAX_ARTIFACTS, resolveArtifact, safeName, saveArtifact } from './artifacts';

const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'b-studio-artifacts-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const png = (bytes = [1, 2, 3]) => ({ data: Buffer.from(bytes), contentType: 'image/png' as const });

describe('safeName', () => {
  it('경로 구분자와 공백 같은 위험한 글자를 지우고 사람이 읽을 수 있는 이름을 남긴다', () => {
    const name = safeName('api /orders (browser 390x844) 1. open /orders');
    expect(name).not.toMatch(/[/\\]/);
    expect(name).not.toMatch(/\s/);
    expect(name).toContain('api');
    expect(name).toContain('orders');
  });

  it('쓸 수 있는 글자가 하나도 없으면 기본 이름을 쓴다', () => {
    expect(safeName('///')).toBe('artifact');
  });
});

describe('saveArtifact', () => {
  it('식별자(`<runId>/<순번>-<이름>.png`)를 돌려주고 파일 0600·폴더 0700으로 저장한다', async () => {
    const stateDir = await workspace();
    const id = await saveArtifact(stateDir, 'run1', { name: 'api /orders 1. open /orders', ...png() });

    expect(id).toMatch(/^run1\/001-.+\.png$/);
    const resolved = await resolveArtifact(stateDir, id.split('/'));
    expect(resolved.contentType).toBe('image/png');
    expect((await stat(resolved.file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(resolved.file))).mode & 0o777).toBe(0o700);
  });

  it('실행 폴더마다 순번을 다시 시작한다', async () => {
    const stateDir = await workspace();
    const first = await saveArtifact(stateDir, 'run', { name: 'shot', ...png() });
    const second = await saveArtifact(stateDir, 'run', { name: 'shot', ...png() });
    const other = await saveArtifact(stateDir, 'other', { name: 'shot', ...png() });
    expect(first).toMatch(/\/001-/);
    expect(second).toMatch(/\/002-/);
    expect(other).toMatch(/^other\/001-/);
  });
});

describe('resolveArtifact', () => {
  it('`..`이나 절대 경로처럼 산출물 폴더를 벗어나는 경로를 거부한다', async () => {
    const stateDir = await workspace();
    await saveArtifact(stateDir, 'run', { name: 'shot', ...png() });

    await expect(resolveArtifact(stateDir, ['..', 'secret.png'])).rejects.toBeInstanceOf(ArtifactError);
    await expect(resolveArtifact(stateDir, ['run', '..', '..', 'secret.png'])).rejects.toBeInstanceOf(ArtifactError);
    await expect(resolveArtifact(stateDir, ['/etc/passwd'])).rejects.toMatchObject({ status: 400 });
    await expect(resolveArtifact(stateDir, [])).rejects.toMatchObject({ status: 400 });
  });

  it('없는 파일은 404, 지원하지 않는 형식도 거부한다', async () => {
    const stateDir = await workspace();
    await expect(resolveArtifact(stateDir, ['run', 'nope.png'])).rejects.toMatchObject({ status: 404 });

    // 알려진 확장자(.png/.jpg)가 아니면 내려주지 않는다
    const dir = path.join(artifactRoot(stateDir), 'run');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manual.txt'), 'x');
    await expect(resolveArtifact(stateDir, ['run', 'manual.txt'])).rejects.toMatchObject({ status: 404 });
  });
});

describe('한도 정리', () => {
  it('세션당 최대 개수를 넘으면 오래된 실행 폴더부터 통째로 지운다', async () => {
    const stateDir = await workspace();
    for (let index = 0; index < MAX_ARTIFACTS; index++) {
      await saveArtifact(stateDir, 'aaa', { name: `shot-${index}`, ...png() });
    }
    expect(await readdir(path.join(artifactRoot(stateDir), 'aaa'))).toHaveLength(MAX_ARTIFACTS);

    // 하나를 더 저장하면 총 201개가 되어 가장 오래된 실행(aaa)이 지워진다
    await saveArtifact(stateDir, 'bbb', { name: 'later', ...png() });
    await expect(readdir(path.join(artifactRoot(stateDir), 'aaa'))).rejects.toThrow();
    expect(await readdir(path.join(artifactRoot(stateDir), 'bbb'))).toHaveLength(1);
    // 파일 201개를 쓰고 그때마다 정리 검사를 도는 테스트라, 전체 테스트가 함께 도는 부하에서는 기본 5초를 넘긴 적이 있다
    // (단독으로는 통과). 다른 느린 테스트와 같은 제한 시간을 준다
  }, 20_000);
});
