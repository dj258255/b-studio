import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './text-diff';

describe('unifiedDiff', () => {
  it('내용이 같으면 빈 문자열이다', async () => {
    expect(await unifiedDiff('studio.yaml', 'version: 1\n', 'version: 1\n')).toBe('');
  });

  it('바뀐 내용을 git diff 형식으로 돌려주고, 임시 경로(old/·new/) 대신 실제 경로를 보여준다', async () => {
    const diff = await unifiedDiff('studio.yaml', 'version: 1\nname: a\n', 'version: 1\nname: b\n');

    expect(diff).toContain('diff --git a/studio.yaml b/studio.yaml');
    expect(diff).toContain('-name: a');
    expect(diff).toContain('+name: b');
    expect(diff).not.toContain('old/');
    expect(diff).not.toContain('new/');
  });

  it('하위 폴더 경로(서비스별 Dockerfile.b-studio)도 그대로 보여준다', async () => {
    const diff = await unifiedDiff('backend/Dockerfile.b-studio', 'FROM node:20\n', 'FROM node:22\n');

    expect(diff).toContain('diff --git a/backend/Dockerfile.b-studio b/backend/Dockerfile.b-studio');
    expect(diff).toContain('-FROM node:20');
    expect(diff).toContain('+FROM node:22');
  });
});
