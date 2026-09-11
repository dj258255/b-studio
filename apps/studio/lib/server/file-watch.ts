import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

const GENERATED = new Set(['.git', 'node_modules', '.next', 'build', '.gradle', '.venv', '__pycache__']);

/** 코드 화면에서 빼는 경로. 에이전트 작업 공간과 같은 생성물 폴더와 .env */
export function isDeniedPath(file: string): boolean {
  return file.split(/[\\/]/).some((segment) => GENERATED.has(segment) || /^\.env(\..*)?$/.test(segment));
}

export interface FileWatcher {
  close(): void;
}

/**
 * 프로젝트 폴더의 파일 변경을 모아서 알린다. 서비스 안에서 명령이 만든 파일처럼 에이전트 도구를 거치지 않은 변경도
 * 코드 화면에 반영하기 위해서다. 빌드하는 동안 생성물 폴더는 쉬지 않고 바뀌므로 생성물과 .env는 무시하고,
 * 몰려오는 변경은 debounceMs 동안 모아 한 번만 알린다
 */
export function watchProjectFiles(root: string, onChange: (files: string[]) => void, { debounceMs = 500 }: { debounceMs?: number } = {}): FileWatcher {
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const file = filename.toString().split(path.sep).join('/');
    if (isDeniedPath(file)) return;
    pending.add(file);
    timer ??= setTimeout(() => {
      timer = undefined;
      const files = [...pending];
      pending = new Set();
      onChange(files);
    }, debounceMs);
  });
  // 감시하던 폴더가 사라져 감시가 끊겨도 스튜디오 서버는 계속 돈다
  watcher.on('error', (error) => console.error('[b-studio] 파일 변경 감시가 끊겼습니다', error));
  return {
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}
