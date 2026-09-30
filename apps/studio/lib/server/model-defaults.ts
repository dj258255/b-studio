/**
 * 프로젝트별로 마지막에 고른 모델을 기억한다. 대화에서 모델을 바꾸면 이 파일에 남기고,
 * 같은 프로젝트·백엔드로 새 세션을 만들 때(모델을 따로 고르지 않았으면) 기본값으로 쓴다.
 *
 * 스튜디오 상태 폴더(홈 아래 캐시)에 두므로 사용자의 저장소에는 아무것도 남기지 않는다.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionMode } from '../studio-events';

type Store = Record<string, string>;

let cache: Store | undefined;

/** 이 프로젝트·백엔드에 저장된 마지막 모델 선택. 고른 적이 없으면 없다. 빈 문자열은 "기본"을 명시적으로 고른 기록이다 */
export function projectModelDefault(projectId: string, backend: SessionMode): string | undefined {
  const store = load();
  const value = store[key(projectId, backend)];
  return value === undefined ? undefined : value;
}

/** 대화에서 모델을 바꿀 때마다 부른다. 빈 문자열(기본)도 그대로 남겨 다음 세션이 같은 선택을 이어받는다 */
export function rememberProjectModelDefault(projectId: string, backend: SessionMode, modelId: string | undefined): void {
  write(key(projectId, backend), modelId);
}

/** 이 프로젝트·백엔드에 저장된 마지막 노력 단계 선택. modelId와 같은 파일에 다른 키로 둔다(model-defaults.json) */
export function projectEffortDefault(projectId: string, backend: SessionMode): string | undefined {
  const store = load();
  const value = store[effortKey(projectId, backend)];
  return value === undefined ? undefined : value;
}

/** 대화에서 노력 단계를 바꿀 때마다 부른다. 빈 문자열(기본)도 그대로 남겨 다음 세션이 같은 선택을 이어받는다 */
export function rememberProjectEffortDefault(projectId: string, backend: SessionMode, effort: string | undefined): void {
  write(effortKey(projectId, backend), effort);
}

function write(storeKey: string, value: string | undefined): void {
  const store = load();
  const next = { ...store, [storeKey]: value ?? '' };
  cache = next;
  const file = filePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

function key(projectId: string, backend: SessionMode): string {
  return `${projectId}:${backend}`;
}

function effortKey(projectId: string, backend: SessionMode): string {
  return `${projectId}:${backend}:effort`;
}

function load(): Store {
  if (cache) return cache;
  const next: Store = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(/* turbopackIgnore: true */ filePath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [storedKey, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') next[storedKey] = value;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[b-studio] 프로젝트 모델 기본값을 읽지 못했습니다', error);
  }
  cache = next;
  return cache;
}

function filePath(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.B_STUDIO_MODEL_DEFAULTS_FILE ?? path.join(homedir(), '.cache', 'b-studio', 'model-defaults.json'));
}

/** 테스트 전용: 캐시를 비워 다음 호출이 파일을 다시 읽게 한다 */
export function resetProjectModelDefaultsCache(): void {
  cache = undefined;
}
