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
