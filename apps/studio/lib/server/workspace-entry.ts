/**
 * 첫 화면(`/`)이 여는 개발 화면을 고른다. 앱을 켜면 입력창이 아니라 마지막 프로젝트의 대화+미리보기가 바로 열리고,
 * 샌드박스는 그 자리에서 켜기 시작한다(켜는 동안 사람은 요청을 적는다). ADR-066.
 *
 * 고르는 순서:
 *  1) 켜져 있거나 켜는 중인 세션 → 그대로 연다
 *  2) 샌드박스를 아직 켜지 않은 세션(지연 기동)·중지된 세션 → "이어서 열기"를 눌러야 켠다(ADR-104) —
 *     서버를 막 재시작했을 때는 모든 세션이 중지로 보이는데, 예전처럼 첫 화면을 열자마자 되살리면 다른
 *     프로젝트로 시작하려던 사람에게는 헛된 기동이다(샌드박스 켜기는 비용이 든다)
 *  3) 고를 세션이 아예 없으면(새 프로젝트) → 잃을 것이 없으니 그 프로젝트로 새 세션을 만들고 바로 켠다
 * 여러 명 비교 참가자·나눠서 병렬 레인·통합 세션은 사람이 직접 개발하는 세션이 아니라 고르지 않는다.
 */
import type { SessionSummary, WorkspaceKind } from '../studio-events';
import { canManageSession } from './access';
import { StudioError } from './errors';
import { listFleets } from './fleets';
import { listProjects } from './projects';
import { createSession, listSessions, localFolderAllowed, recoverSessions, resumeSession, startBooting } from './sessions';
import { listTaskPlans } from './task-plans';

export type WorkspaceAction = 'opened' | 'booting' | 'resumed' | 'created';

export interface OpenWorkspaceResult {
  id: string;
  projectId: string;
  action: WorkspaceAction;
}

export interface WorkspacePick {
  /** 열 세션. 없으면 projectId로 새로 만든다 */
  session?: SessionSummary;
  projectId?: string;
  /** 새로 만들 때의 작업 위치. 마지막 세션과 같게 두되, 내 폴더를 쓸 수 없으면 복사본 */
  workspace: WorkspaceKind;
}

/**
 * 열 세션을 고른다(순수 함수). sessions는 최근 순이어야 한다(listSessions가 그렇게 준다).
 * 프로젝트를 지정하면 그 프로젝트에서만 고르고, 없으면 가장 최근에 쓴 세션의 프로젝트를 쓴다
 */
export function pickWorkspace(input: {
  sessions: readonly SessionSummary[];
  /** 비교 참가자·병렬 레인·통합 세션 */
  excluded: ReadonlySet<string>;
  viewer: string;
  canManage: (viewer: string, owner: string | undefined) => boolean;
  /** 쓸 수 있는 프로젝트(오류 없는 것) */
  projectIds: readonly string[];
  projectId?: string;
  localAllowed: boolean;
}): WorkspacePick {
  const mine = input.sessions.filter(
    (session) =>
      !input.excluded.has(session.id) &&
      // 켜지 못한 세션은 다시 열어도 같은 오류다. 새로 만든다
      session.status !== 'failed' &&
      input.canManage(input.viewer, session.owner) &&
      input.projectIds.includes(session.projectId),
  );
  const projectId = input.projectId ?? mine[0]?.projectId ?? input.projectIds[0];
  const inProject = mine.filter((session) => session.projectId === projectId);
  // 이미 켜진 것을 먼저 연다(최근 순 안에서). 없으면 가장 최근 세션을 이어서 연다
  const live = inProject.find((session) => session.status === 'ready' || session.status === 'starting');
  const session = live ?? inProject[0];
  const lastWorkspace = session?.workspace ?? mine[0]?.workspace ?? 'copy';
  return { ...(session ? { session } : {}), ...(projectId ? { projectId } : {}), workspace: lastWorkspace === 'local' && input.localAllowed ? 'local' : 'copy' };
}

/** 사람이 직접 개발하지 않는 세션(비교 참가자·병렬 레인·통합) */
export function excludedSessions(viewer: string): Set<string> {
  const ids = new Set<string>();
  for (const fleet of listFleets(viewer)) for (const member of fleet.members) ids.add(member.sessionId);
  for (const plan of listTaskPlans(viewer)) {
    for (const lane of plan.lanes) if (lane.sessionId) ids.add(lane.sessionId);
    if (plan.integration?.sessionId) ids.add(plan.integration.sessionId);
  }
  return ids;
}

export type WorkspaceChoice =
  | { kind: 'live'; id: string }
  | { kind: 'resumable'; sessionId: string; projectId: string; projectName: string; updatedAt: string }
  | { kind: 'start'; projectId?: string };

/**
 * pickWorkspace가 고른 결과를 첫 화면이 보여줄 모양으로 바꾼다(순수 함수 — 부작용 없이 테스트한다, ADR-104).
 *  - live: 이미 켜져 있거나 켜는 중 → 읽기만 하고 바로 그 화면으로 보낸다
 *  - resumable: 지연 기동·중지 세션이 있다 → 사람이 "이어서 열기"를 눌러야 샌드박스를 켠다
 *  - start: 고를 세션이 없다(새 프로젝트) → 잃을 것이 없으니 바로 만들어 켠다(기존 흐름, WorkspaceLauncher)
 */
export function workspaceChoiceFor(pick: WorkspacePick): WorkspaceChoice {
  const session = pick.session;
  if (session?.status === 'ready' || session?.status === 'starting') return { kind: 'live', id: session.id };
  if (session?.status === 'idle' || session?.status === 'stopped') {
    return { kind: 'resumable', sessionId: session.id, projectId: session.projectId, projectName: session.projectName, updatedAt: session.updatedAt };
  }
  return { kind: 'start', ...(pick.projectId ? { projectId: pick.projectId } : {}) };
}

/**
 * 첫 화면(`/`)이 고를 선택을 만든다(읽기만 한다 — 세션을 만들거나 켜지 않는다). live면 화면이 곧바로 그 세션으로
 * 가고, resumable이면 "이어서 열기"를 보여주고, start면 화면이 POST /api/workspace로 새로 연다
 * (GET인 이 함수 자체는 세션을 만들지 않는다).
 */
export async function findWorkspaceChoice(viewer: string, options: { projectId?: string } = {}): Promise<WorkspaceChoice> {
  const projects = (await listProjects()).filter((project) => !project.error);
  const projectIds = projects.map((project) => project.id);
  if (options.projectId && !projectIds.includes(options.projectId)) return { kind: 'start', projectId: options.projectId };
  const pick = pickWorkspace({
    sessions: await listSessions(),
    excluded: excludedSessions(viewer),
    viewer,
    canManage: canManageSession,
    projectIds,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    localAllowed: localFolderAllowed(),
  });
  return workspaceChoiceFor(pick);
}

// 첫 화면이 두 번 불려도(React 개발 모드의 이중 실행, 탭 두 개) 세션을 두 개 만들지 않도록 사람마다 한 번에 하나만 연다
const globalOpening = globalThis as typeof globalThis & { __bStudioOpening?: Map<string, Promise<OpenWorkspaceResult>> };
const opening = (globalOpening.__bStudioOpening ??= new Map());

export function openWorkspace(viewer: string, options: { projectId?: string } = {}): Promise<OpenWorkspaceResult> {
  const key = `${viewer}\u0000${options.projectId ?? ''}`;
  const running = opening.get(key);
  if (running) return running;
  const task = open(viewer, options).finally(() => opening.delete(key));
  opening.set(key, task);
  return task;
}

async function open(viewer: string, options: { projectId?: string }): Promise<OpenWorkspaceResult> {
  await recoverSessions();
  const projects = (await listProjects()).filter((project) => !project.error);
  if (projects.length === 0) throw new StudioError(404, '열 수 있는 프로젝트가 없습니다. 프로젝트 폴더를 확인하세요');
  const projectIds = projects.map((project) => project.id);
  if (options.projectId && !projectIds.includes(options.projectId)) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');

  const pick = pickWorkspace({
    sessions: await listSessions(),
    excluded: excludedSessions(viewer),
    viewer,
    canManage: canManageSession,
    projectIds,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    localAllowed: localFolderAllowed(),
  });
  const projectId = pick.projectId!;
  const session = pick.session;

  if (session?.status === 'ready' || session?.status === 'starting') return { id: session.id, projectId, action: 'opened' };
  if (session?.status === 'idle') {
    startBooting(session.id);
    return { id: session.id, projectId, action: 'booting' };
  }
  if (session?.status === 'stopped') {
    try {
      const resumed = await resumeSession(session.id);
      return { id: resumed.id, projectId, action: 'resumed' };
    } catch (error) {
      // 작업 복사본이 사라졌거나 지금 서버가 그 백엔드를 허용하지 않으면 새로 만든다. 이유는 서버 로그에 남긴다
      console.warn(`[b-studio] 세션 ${session.id}을 이어서 열지 못해 새로 만듭니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const created = await createSession(projectId, viewer, pick.workspace, { boot: 'eager' });
  return { id: created.id, projectId, action: 'created' };
}
