import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { type CodeMatch } from '@/lib/code-search';
import { isDeniedPath } from './file-watch';

/**
 * 코드 탭의 파일 목록과 내용 찾기.
 * 에이전트 도구의 목록 한도(Workspace.list, 500개)는 모델에게 보내는 양이라 그대로 두고,
 * 사람이 보는 화면은 따로 걸어 큰 저장소도 세고 나눠 보낸다
 */
export const MAX_CODE_FILES = 20_000;
/** 내용 찾기에서 읽을 파일 크기 상한. 이보다 큰 파일은 건너뛴다 */
export const MAX_SEARCH_BYTES = 256 * 1024;

export interface FileWalk {
  files: string[];
  /** 파일이 상한보다 많아 다 세지 못한 경우 */
  truncated: boolean;
}

/**
 * 프로젝트 폴더의 파일 목록. 생성물 폴더는 들어가지 않고, 폴더마다 이름 순으로 훑어 순서가 항상 같다.
 * 심볼릭 링크는 폴더로도 파일로도 보지 않아 루트 밖으로 나가지 않는다
 */
export async function walkFiles(root: string, limit = MAX_CODE_FILES): Promise<FileWalk> {
  const files: string[] = [];
  let truncated = false;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (truncated) return;
      if (isDeniedPath(child.name)) continue;
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) {
        await walk(path.join(dir, child.name), relative);
      } else if (child.isFile()) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(relative);
      }
    }
  };

  await walk(root, '');
  return { files, truncated };
}

export interface FileMatches {
  file: string;
  matches: CodeMatch[];
}

export interface SearchResult {
  results: FileMatches[];
  /** 실제로 읽어 본 파일 수 */
  scanned: number;
  /** 결과 수 상한에 걸려 멈춘 경우 */
  truncated: boolean;
}
