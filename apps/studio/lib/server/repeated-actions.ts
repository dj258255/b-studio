/**
 * 프로젝트의 되풀이 행동 후보(ADR-077)를 만들고, 무시 목록을 다룬다.
 *
 * 읽는 쪽은 얇게 둔다: 프로젝트의 세션 목록(listSessions)에서 최근 것부터 상한만큼 골라 기록(sessionHistory)을 읽고,
 * 계산은 순수 함수(`findRepeatedActions`)에 넘긴다(project-token-report.ts와 같은 구조).
 *
 * 무시 목록은 사용자 저장소 폴더에 프로젝트별 파일로 둔다(fleets.ts·usage-state.ts와 같은 자리, 사용자 코드 저장소 밖).
 * 학습 데이터(에이전트가 실제로 반복한 것)일 뿐이라 커밋에 들어가면 안 되고, 사용자 저장소를 건드리지 않아야 한다.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_MAX_SESSIONS, findRepeatedActions, type RepeatedActionCandidate } from '../repeated-actions';
import { StudioError } from './errors';
import { findProject } from './projects';
import { listSessions, sessionHistory } from './sessions';

export interface RepeatedActionsReport {
  projectId: string;
  projectName: string;
  generatedAt: string;
  /** 실제로 훑은 세션 수(상한 적용 뒤) */
  sessionsAnalyzed: number;
  candidates: RepeatedActionCandidate[];
  /** 후보였지만 무시 목록에 있어 뺀 개수 */
  ignoredCount: number;
}

/** 프로젝트의 최근 세션 기록에서 되풀이 후보를 찾는다. 무시한 후보는 뺀다 */
export async function projectRepeatedActions(projectId: string, options: { now?: string } = {}): Promise<RepeatedActionsReport> {
  const project = await findProject(projectId);
  if (!project) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
  // listSessions()는 최근에 바뀐 것부터 정렬해 돌려준다(sessions.ts) — findRepeatedActions가 그중 최근 N개만 본다
  // 데모 세션은 준비된 대본을 되풀이할 뿐이라 에이전트의 반복 행동이 아니다. 분석에서 뺀다
  const sessions = (await listSessions()).filter((session) => session.projectId === projectId && (session.backend ?? session.mode) !== 'demo');
  const inputs = sessions.map((session) => ({ sessionId: session.id, events: sessionHistory(session.id) }));
  const all = findRepeatedActions(inputs);
  const ignored = readIgnoreList(projectId);
  const candidates = all.filter((candidate) => !ignored.has(candidate.id));
  return {
    projectId,
    projectName: project.spec.name,
    generatedAt: options.now ?? new Date().toISOString(),
    sessionsAnalyzed: Math.min(inputs.length, DEFAULT_MAX_SESSIONS),
    candidates,
    ignoredCount: all.length - candidates.length,
  };
}

/** 후보 하나를 무시 목록에 더한다(멱등: 이미 있으면 그대로 둔다) */
export function ignoreRepeatedAction(projectId: string, candidateId: string): void {
  const ignored = readIgnoreList(projectId);
  if (ignored.has(candidateId)) return;
  ignored.add(candidateId);
  persistIgnoreList(projectId, ignored);
}

interface IgnoreFile {
  version: 1;
  ignored: string[];
}

export function repeatedActionsStateDir(): string {
  return path.resolve(
    /* turbopackIgnore: true */ process.env.B_STUDIO_REPEATED_ACTIONS_DIR ?? path.join(homedir(), '.cache', 'b-studio', 'repeated-actions'),
  );
}

function ignoreFile(projectId: string): string {
  return path.join(repeatedActionsStateDir(), `${encodeURIComponent(projectId)}.json`);
}

function readIgnoreList(projectId: string): Set<string> {
  try {
    const data = JSON.parse(readFileSync(ignoreFile(projectId), 'utf8')) as IgnoreFile;
    return new Set(Array.isArray(data.ignored) ? data.ignored.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    // 파일이 없거나 읽지 못하면 무시한 것이 없는 것으로 본다(후보를 조용히 숨기지 않는다)
    return new Set();
  }
}

function persistIgnoreList(projectId: string, ignored: Set<string>): void {
  const directory = repeatedActionsStateDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = ignoreFile(projectId);
  const temp = `${file}.${process.pid}.tmp`;
  const data: IgnoreFile = { version: 1, ignored: [...ignored] };
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
