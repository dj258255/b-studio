import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExploreQaRun } from './explore-qa-runs';

/**
 * 끝난 탐색형 QA 실행을 세션 상태 폴더의 파일로 남기고 다시 읽는다(이슈 #602).
 * 실행 기록은 studio 프로세스의 메모리에만 있어서, studio를 다시 띄우면 판정·발견·예상된 거절 목록이 화면에서 사라졌다.
 * 세션마다 마지막으로 끝난 실행 하나만 남긴다(화면이 보여 주는 것도 하나다).
 */

/** 세션 상태 폴더 기준 경로. 테스트 결과 사이드카(test-results.json)와 같은 폴더다 */
export const EXPLORE_QA_RUN_FILE = path.join('.git', 'b-studio', 'explore-qa-run.json');

/** 파일 형식이 바뀌면 올린다. 다른 판의 파일은 읽지 않는다 */
const FORMAT = 1;
/** 읽을 파일의 크기 상한. 넘으면 읽지 않는다(행동 기록은 실행의 행동 수 상한으로 묶여 있어 보통 수십 KB다) */
const MAX_BYTES = 5 * 1024 * 1024;

/** 끝난 실행만 남긴다. 임시 파일에 쓴 뒤 이름을 바꿔, 쓰다 끊겨도 반쯤 쓴 파일이 남지 않게 한다 */
export async function writeExploreQaRunFile(file: string, run: ExploreQaRun): Promise<void> {
  if (run.status !== 'done') return;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ format: FORMAT, run }), 'utf8');
  await rename(temporary, file);
}

/** 남겨 둔 실행을 읽는다. 없거나, 형식이 다르거나, 끝난 실행이 아니면 undefined */
export async function readExploreQaRunFile(file: string): Promise<ExploreQaRun | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(text) > MAX_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.format !== FORMAT || !isRecord(parsed.run)) return undefined;
  const run = parsed.run;
  const shaped =
    typeof run.id === 'string' &&
    typeof run.service === 'string' &&
    run.status === 'done' &&
    isRecord(run.goal) &&
    typeof run.goal.goal === 'string' &&
    typeof run.goal.startPath === 'string' &&
    Array.isArray(run.actions) &&
    Array.isArray(run.findings) &&
    Array.isArray(run.expectedRejections) &&
    Array.isArray(run.texts) &&
    typeof run.startedAt === 'number' &&
    (run.result === undefined || isRecord(run.result)) &&
    (run.error === undefined || typeof run.error === 'string');
  return shaped ? (run as unknown as ExploreQaRun) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
