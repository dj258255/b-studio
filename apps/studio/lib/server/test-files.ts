import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isTestFilePath, type PackageJsonInfo } from '@b-studio/agent';

/** 테스트 스캔이 들어가지 않는 폴더. 생성물·의존성 폴더는 훑을 필요가 없고 아주 커서 느려질 수 있다 */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.gradle', '.venv', 'venv', '__pycache__', 'coverage', '.turbo']);
/** 테스트 탭을 열 때마다 도는 동기 스캔이라 안전판을 둔다(요구사항 탭의 scanWorkingCopyTestFiles와 같은 상한) */
const MAX_FILES = 400;
const MAX_FILE_BYTES = 200_000;

export interface ScannedTestFile {
  /** 서비스 폴더 기준 상대 경로(gradlew --tests, jest/vitest/pytest에 넘기는 경로와 같다) */
  path: string;
  content: string;
}

/**
 * 서비스 폴더(프로젝트 루트 기준 상대 경로) 안에서 테스트로 보이는 파일을 찾아 읽는다.
 * 요구사항 탭의 scanWorkingCopyTestFiles와 같은 안전판을 쓰되, 여기는 프레임워크를 가리지 않고
 * (JUnit·Vitest/Jest/Playwright·pytest 모두) test-discovery.ts의 isTestFilePath로 가른다.
 */
export async function walkServiceTestFiles(root: string, servicePath: string): Promise<ScannedTestFile[]> {
  const serviceRoot = path.join(root, servicePath);
  const files: ScannedTestFile[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const relative = path.relative(serviceRoot, path.join(dir, entry.name)).replaceAll(path.sep, '/');
        if (!isTestFilePath(relative)) continue;
        const absolute = path.join(dir, entry.name);
        try {
          const info = await stat(absolute);
          if (info.size > MAX_FILE_BYTES) continue;
          const content = await readFile(absolute, 'utf8');
          files.push({ path: relative, content });
        } catch {
          // 읽는 사이 지워졌거나 이진 파일이면 건너뛴다
        }
      }
    }
  }

  await walk(serviceRoot);
  return files;
}

/**
 * 서비스 폴더(spec.path)와 그 서비스의 `includes`(studio.yaml, ADR-139) 경로까지 함께 테스트 파일을 찾는다.
 * `includes`가 가리키는 경로는 서비스 폴더 밖(형제 폴더 등)이라 `walkServiceTestFiles(root, servicePath)`만으로는
 * 전혀 보이지 않는다 — Gradle 멀티 모듈 빌드에서 그 서브프로젝트의 테스트 보고서는 `extraReportRootsFor`로 이미
 * 모아 오면서도(ADR-139), "테스트" 탭의 발견 단계(discoverServiceTestRows)는 그 경로를 몰라 모아 온 결과를
 * 어느 행에도 붙이지 못하고 조용히 버렸다(다그푸딩 마찰 140 — `attachResults`가 발견한 행에만 결과를 붙이기 때문에,
 * 발견하지 못한 테스트는 통과했어도 "테스트" 탭·요구사항 증거 어디에도 나타나지 않았다).
 * `includes` 경로에서 찾은 파일은 "<include>/<그 경로 기준 상대 경로>"로 접두어를 붙인다 — 요구사항 탭의
 * `scanWorkingCopyTestFiles`(프로젝트 루트 전체를 훑는다)가 이미 이 모양으로 보여주므로, 두 스캔의 표시가 같아진다.
 */
export async function walkServiceAndIncludedTestFiles(root: string, servicePath: string, includes: readonly string[] = []): Promise<ScannedTestFile[]> {
  const own = await walkServiceTestFiles(root, servicePath);
  const included = await Promise.all(
    includes.map(async (include) => {
      const files = await walkServiceTestFiles(root, include);
      return files.map((file) => ({ ...file, path: `${include}/${file.path}` }));
    }),
  );
  return [...own, ...included.flat()];
}

/** 서비스 폴더의 package.json을 읽는다. 없거나 JSON이 아니면 undefined(JS/TS 서비스가 아니라고 본다) */
export async function readServicePackageJson(root: string, servicePath: string): Promise<PackageJsonInfo | undefined> {
  try {
    const raw = await readFile(path.join(root, servicePath, 'package.json'), 'utf8');
    return JSON.parse(raw) as PackageJsonInfo;
  } catch {
    return undefined;
  }
}

/** 서비스 폴더에 pom.xml이 있는지(Spring Boot를 Gradle 대신 Maven으로 쓰는 프로젝트를 가른다) */
export async function serviceHasPomXml(root: string, servicePath: string): Promise<boolean> {
  try {
    await stat(path.join(root, servicePath, 'pom.xml'));
    return true;
  } catch {
    return false;
  }
}
