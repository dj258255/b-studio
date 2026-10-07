import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { GENERATED_DOCKERFILE, syncSystemPackages } from './system-packages-sync';

const made: string[] = [];

async function tempProjectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-syspkg-'));
  made.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const NODE_DOCKERFILE = ['FROM node:22-bookworm-slim', '', 'WORKDIR /workspace', 'EXPOSE 3000', ''].join('\n');
const SPRING_DOCKERFILE = ['FROM eclipse-temurin:21-jdk', '', 'WORKDIR /workspace', 'EXPOSE 8080', ''].join('\n');

function fakeProject(root: string, managed: LoadedProject['managed']): LoadedProject {
  return { root, managed } as unknown as LoadedProject;
}

describe('syncSystemPackages(도그푸딩 마찰 113, ADR-137)', () => {
  it('studio.yaml의 systemPackages를 Dockerfile.b-studio에 반영한다', async () => {
    const root = await tempProjectRoot();
    await mkdir(path.join(root, 'commerce'), { recursive: true });
    await writeFile(path.join(root, 'commerce', GENERATED_DOCKERFILE), SPRING_DOCKERFILE);
    const project = fakeProject(root, [['commerce', { source: 'managed', template: 'spring-boot', path: 'commerce', port: 8080, preview: 'openapi', systemPackages: ['ffmpeg'] } as never]]);

    const changed = await syncSystemPackages(project, ['commerce']);

    expect(changed).toEqual(['commerce/Dockerfile.b-studio']);
    const written = await readFile(path.join(root, 'commerce', GENERATED_DOCKERFILE), 'utf8');
    expect(written).toContain('RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg');
  });

  it('path가 "."인 루트 서비스도 올바른 자리에 쓴다', async () => {
    const root = await tempProjectRoot();
    await writeFile(path.join(root, GENERATED_DOCKERFILE), NODE_DOCKERFILE);
    const project = fakeProject(root, [['web', { source: 'managed', template: 'nextjs', path: '.', port: 3000, preview: 'browser', systemPackages: ['imagemagick'] } as never]]);

    const changed = await syncSystemPackages(project, ['web']);

    expect(changed).toEqual([GENERATED_DOCKERFILE]);
    const written = await readFile(path.join(root, GENERATED_DOCKERFILE), 'utf8');
    expect(written).toContain('imagemagick');
  });

  it('services로 넘기지 않은(다시 띄우지 않는) 서비스는 건드리지 않는다', async () => {
    const root = await tempProjectRoot();
    await mkdir(path.join(root, 'commerce'), { recursive: true });
    await writeFile(path.join(root, 'commerce', GENERATED_DOCKERFILE), SPRING_DOCKERFILE);
    const project = fakeProject(root, [['commerce', { source: 'managed', template: 'spring-boot', path: 'commerce', port: 8080, preview: 'openapi', systemPackages: ['ffmpeg'] } as never]]);

    const changed = await syncSystemPackages(project, []); // 아무 서비스도 다시 안 띄움

    expect(changed).toEqual([]);
    const untouched = await readFile(path.join(root, 'commerce', GENERATED_DOCKERFILE), 'utf8');
    expect(untouched).toBe(SPRING_DOCKERFILE);
  });

  it('b-studio가 만든 Dockerfile이 없는 서비스(직접 쓴 Dockerfile)는 건드리지 않는다', async () => {
    const root = await tempProjectRoot();
    await mkdir(path.join(root, 'commerce'), { recursive: true });
    // Dockerfile.b-studio가 아예 없음 — 사용자가 직접 다른 이름의 Dockerfile을 쓰는 경우
    const project = fakeProject(root, [['commerce', { source: 'managed', template: 'spring-boot', path: 'commerce', port: 8080, preview: 'openapi', systemPackages: ['ffmpeg'] } as never]]);

    await expect(syncSystemPackages(project, ['commerce'])).resolves.toEqual([]);
  });

  it('systemPackages를 선언하지 않은 서비스는 바꾸지 않는다(변경 없음)', async () => {
    const root = await tempProjectRoot();
    await writeFile(path.join(root, GENERATED_DOCKERFILE), NODE_DOCKERFILE);
    const project = fakeProject(root, [['web', { source: 'managed', template: 'nextjs', path: '.', port: 3000, preview: 'browser' } as never]]);

    expect(await syncSystemPackages(project, ['web'])).toEqual([]);
    expect(await readFile(path.join(root, GENERATED_DOCKERFILE), 'utf8')).toBe(NODE_DOCKERFILE);
  });

  it('선언을 지우면 이미 설치된 블록도 지워진다(재현 가능 — 선언이 유일한 출처)', async () => {
    const root = await tempProjectRoot();
    await writeFile(path.join(root, GENERATED_DOCKERFILE), NODE_DOCKERFILE);
    const withFfmpeg = fakeProject(root, [['web', { source: 'managed', template: 'nextjs', path: '.', port: 3000, preview: 'browser', systemPackages: ['ffmpeg'] } as never]]);
    await syncSystemPackages(withFfmpeg, ['web']);
    expect(await readFile(path.join(root, GENERATED_DOCKERFILE), 'utf8')).toContain('ffmpeg');

    const withoutPackages = fakeProject(root, [['web', { source: 'managed', template: 'nextjs', path: '.', port: 3000, preview: 'browser', systemPackages: [] } as never]]);
    await syncSystemPackages(withoutPackages, ['web']);

    expect(await readFile(path.join(root, GENERATED_DOCKERFILE), 'utf8')).toBe(NODE_DOCKERFILE);
  });

  it('모르는 베이스 이미지 계열은 조용히 넘어가지 않고 예외를 던진다(호출부가 재시작 실패로 다룬다)', async () => {
    const root = await tempProjectRoot();
    await writeFile(path.join(root, GENERATED_DOCKERFILE), 'FROM rust:1-slim\nWORKDIR /workspace\n');
    const project = fakeProject(root, [['web', { source: 'managed', template: 'nextjs', path: '.', port: 3000, preview: 'browser', systemPackages: ['ffmpeg'] } as never]]);

    await expect(syncSystemPackages(project, ['web'])).rejects.toThrow(/패키지 계열/);
  });
});
