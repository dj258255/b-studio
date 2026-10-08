import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walkServiceAndIncludedTestFiles, walkServiceTestFiles } from './test-files';

/**
 * includes(studio.yaml, ADR-139) 경로의 테스트 파일이 "테스트" 탭 발견 단계에서도 보이는지(다그푸딩 마찰 140).
 * 실제 b-studio가 쓰는 임시 폴더만 쓴다 — Docker·네트워크·모델 호출은 없다.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-test-files-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('walkServiceTestFiles — 서비스 폴더 자신만 훑는다(기존 동작)', () => {
  it('서비스 폴더 밖(형제 폴더)의 테스트 파일은 전혀 찾지 못한다', async () => {
    await mkdir(path.join(root, 'commerce', 'src', 'test'), { recursive: true });
    await writeFile(path.join(root, 'commerce', 'src', 'test', 'OwnTest.java'), 'class OwnTest {}');
    await mkdir(path.join(root, 'media', 'src', 'test'), { recursive: true });
    await writeFile(path.join(root, 'media', 'src', 'test', 'ExtraTest.java'), 'class ExtraTest {}');

    const files = await walkServiceTestFiles(root, 'commerce');
    expect(files.map((file) => file.path)).toEqual(['src/test/OwnTest.java']);
  });
});

describe('walkServiceAndIncludedTestFiles — 서비스 폴더 + includes 경로를 함께 훑는다(다그푸딩 마찰 140)', () => {
  it('includes 경로의 테스트 파일을 "<include>/<상대경로>"로 접두어를 붙여 함께 돌려준다', async () => {
    await mkdir(path.join(root, 'commerce', 'src', 'test'), { recursive: true });
    await writeFile(path.join(root, 'commerce', 'src', 'test', 'OwnTest.java'), 'class OwnTest {}');
    await mkdir(path.join(root, 'media', 'src', 'test'), { recursive: true });
    await writeFile(path.join(root, 'media', 'src', 'test', 'ExtraTest.java'), 'class ExtraTest {}');

    const files = await walkServiceAndIncludedTestFiles(root, 'commerce', ['media']);
    const paths = files.map((file) => file.path).sort();
    expect(paths).toEqual(['media/src/test/ExtraTest.java', 'src/test/OwnTest.java']);
  });

  it('includes가 없으면 서비스 폴더 자신만 훑은 것과 똑같다', async () => {
    await mkdir(path.join(root, 'commerce', 'src', 'test'), { recursive: true });
    await writeFile(path.join(root, 'commerce', 'src', 'test', 'OwnTest.java'), 'class OwnTest {}');

    const withoutIncludes = await walkServiceAndIncludedTestFiles(root, 'commerce');
    const own = await walkServiceTestFiles(root, 'commerce');
    expect(withoutIncludes).toEqual(own);
  });

  it('여러 includes 경로를 모두 모은다', async () => {
    await mkdir(path.join(root, 'commerce', 'src', 'test'), { recursive: true });
    await mkdir(path.join(root, 'media', 'src', 'test'), { recursive: true });
    await mkdir(path.join(root, 'personalization', 'src', 'test'), { recursive: true });
    await writeFile(path.join(root, 'commerce', 'src', 'test', 'OwnTest.java'), 'class OwnTest {}');
    await writeFile(path.join(root, 'media', 'src', 'test', 'MediaTest.java'), 'class MediaTest {}');
    await writeFile(path.join(root, 'personalization', 'src', 'test', 'PersonalizationTest.java'), 'class PersonalizationTest {}');

    const files = await walkServiceAndIncludedTestFiles(root, 'commerce', ['media', 'personalization']);
    const paths = files.map((file) => file.path).sort();
    expect(paths).toEqual(['media/src/test/MediaTest.java', 'personalization/src/test/PersonalizationTest.java', 'src/test/OwnTest.java']);
  });

  it('includes 경로가 비어 있거나 존재하지 않아도(테스트가 없는 서브프로젝트) 조용히 빈 목록으로 넘어간다', async () => {
    await mkdir(path.join(root, 'commerce', 'src', 'test'), { recursive: true });
    await writeFile(path.join(root, 'commerce', 'src', 'test', 'OwnTest.java'), 'class OwnTest {}');

    const files = await walkServiceAndIncludedTestFiles(root, 'commerce', ['does-not-exist']);
    expect(files.map((file) => file.path)).toEqual(['src/test/OwnTest.java']);
  });
});
