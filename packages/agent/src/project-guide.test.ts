import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectGuide } from './project-guide';
import { createOrdersProject } from './test-helpers';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(overrides: Partial<LoadedProject['spec']> = {}): Promise<LoadedProject> {
  const loaded = await createOrdersProject('b-studio-guide-');
  roots.push(loaded.root);
  return { ...loaded, spec: { ...loaded.spec, ...overrides } } as LoadedProject;
}

describe('loadProjectGuide', () => {
  it('AGENTS.md가 없으면 아무것도 돌려주지 않는다(고정 문맥을 늘리지 않는다)', async () => {
    const loaded = await project();
    expect(await loadProjectGuide(loaded)).toBeUndefined();
  });

  it('AGENTS.md가 있으면 그대로 읽어 파일 이름·글자 수와 함께 돌려준다', async () => {
    const loaded = await project();
    await writeFile(path.join(loaded.root, 'AGENTS.md'), '- pnpm test 대신 scripts/web-test.sh를 실행\n');

    const guide = await loadProjectGuide(loaded);
    expect(guide?.file).toBe('AGENTS.md');
    expect(guide?.text).toBe('- pnpm test 대신 scripts/web-test.sh를 실행\n');
    expect(guide?.charsUsed).toBe(guide?.text.length);
  });

  it('AGENTS.md가 없고 CLAUDE.md가 있으면 대신 읽는다(기본 파일 이름을 그대로 뒀을 때만)', async () => {
    const loaded = await project();
    await writeFile(path.join(loaded.root, 'CLAUDE.md'), '메모 내용\n');

    const guide = await loadProjectGuide(loaded);
    expect(guide?.file).toBe('CLAUDE.md');
    expect(guide?.text).toBe('메모 내용\n');
  });

  it('파일 이름을 직접 다른 값으로 바꿨으면 CLAUDE.md로 대신 찾지 않는다', async () => {
    const loaded = await project({ guide: { file: 'GUIDE.md', maxChars: 8_000, enabled: true } });
    await writeFile(path.join(loaded.root, 'CLAUDE.md'), '이건 못 찾아야 한다\n');

    expect(await loadProjectGuide(loaded)).toBeUndefined();
  });

  it('예산을 넘으면 앞부분만 남기고 잘렸다는 한국어 안내를 덧붙인다', async () => {
    const loaded = await project({ guide: { file: 'AGENTS.md', maxChars: 10, enabled: true } });
    await writeFile(path.join(loaded.root, 'AGENTS.md'), '0123456789가나다라마바사');

    const guide = await loadProjectGuide(loaded);
    expect(guide?.text.startsWith('0123456789')).toBe(true);
    expect(guide?.text).toContain('잘렸습니다');
    expect(guide?.text).toContain('read_file');
    // 실제로 프롬프트에 들어가는 글자 수(잘린 뒤 + 안내 문구)를 기록한다
    expect(guide?.charsUsed).toBe(guide?.text.length);
  });

  it('예산 안이면 안내 문구를 붙이지 않는다', async () => {
    const loaded = await project({ guide: { file: 'AGENTS.md', maxChars: 8_000, enabled: true } });
    await writeFile(path.join(loaded.root, 'AGENTS.md'), '짧은 지침');

    const guide = await loadProjectGuide(loaded);
    expect(guide?.text).toBe('짧은 지침');
    expect(guide?.text).not.toContain('잘렸습니다');
  });

  it('studio.yaml에서 꺼 뒀으면(guide.enabled=false) 파일이 있어도 읽지 않는다', async () => {
    const loaded = await project({ guide: { file: 'AGENTS.md', maxChars: 8_000, enabled: false } });
    await writeFile(path.join(loaded.root, 'AGENTS.md'), '읽으면 안 된다');

    expect(await loadProjectGuide(loaded)).toBeUndefined();
  });

  it('spec.guide가 아예 없는 옛 픽스처는 기본값(켬·AGENTS.md·8,000자)으로 동작한다', async () => {
    const loaded = await createOrdersProject('b-studio-guide-legacy-');
    roots.push(loaded.root);
    expect((loaded.spec as Record<string, unknown>).guide).toBeUndefined();
    await writeFile(path.join(loaded.root, 'AGENTS.md'), '기본값 확인');

    const guide = await loadProjectGuide(loaded);
    expect(guide?.file).toBe('AGENTS.md');
    expect(guide?.text).toBe('기본값 확인');
  });
});
