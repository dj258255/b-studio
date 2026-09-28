import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { compareExample, designPathFor, writeDesignPng } from './design-files';
import { StudioError } from './errors';

function project(root: string, protectedPaths: string[] = []): LoadedProject {
  return { root, spec: { workflow: { protectedPaths } }, managed: [] } as unknown as LoadedProject;
}

describe('design-files', () => {
  it('프레임 이름을 안전한 design/ 경로로 바꾼다', () => {
    expect(designPathFor({ name: 'Order list / mobile' })).toBe('design/Order-list-mobile.png');
    expect(designPathFor({ name: '///' })).toBe('design/artifact.png');
  });

  it('프로젝트 안 design/에 PNG를 쓰고, 보호 경로면 거부한다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-files-'));
    const png = Buffer.from([1, 2, 3]);
    await writeDesignPng(project(root), 'design/order.png', png);
    expect(await readFile(path.join(root, 'design/order.png'))).toEqual(png);

    await expect(writeDesignPng(project(root, ['design']), 'design/order.png', png)).rejects.toBeInstanceOf(StudioError);
  });

  it('프로젝트 밖 경로는 거부한다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-files-'));
    await expect(writeDesignPng(project(root), '../escape.png', Buffer.from([1]))).rejects.toBeInstanceOf(StudioError);
  });

  it('compare 예시 줄에 프레임 크기와 저장 경로를 넣는다', () => {
    const example = compareExample('design/list.png', { width: 375, height: 812 });
    expect(example).toContain('viewport: { width: 375, height: 812 }');
    expect(example).toContain('reference: design/list.png');
    expect(example).toContain('maxDiffRatio: 0.15');
  });
});
