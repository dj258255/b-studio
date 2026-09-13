import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { estimateCost } from '@b-studio/agent';
import type { FleetMemberView, FleetView } from '@/lib/fleet-types';
import type { StudioEvent } from '@/lib/studio-events';
import { StudioError } from './errors';
import { listModelOptions, modelById } from './model-registry';
import { createSession, getSnapshot, sendMessage, subscribe } from './sessions';

const MAX_MEMBERS = 4;
const MAX_REQUEST = 20_000;
const fleets = new Map<string, FleetView>();
const subscribed = new Set<string>();
let loaded = false;

export async function createFleet(input: {
  projectId: string;
  request: string;
  modelIds: string[];
  owner: string;
  allowBreaking?: boolean;
}): Promise<FleetView> {
  if ((process.env.B_STUDIO_MODE?.trim() || 'api') !== 'api') throw new StudioError(409, '병렬 모델 Fleet은 B_STUDIO_MODE=api에서만 사용할 수 있습니다');
  const request = input.request.trim();
  if (!request) throw new StudioError(400, '요청 내용을 입력하세요');
  if (request.length > MAX_REQUEST) throw new StudioError(400, `요청은 ${MAX_REQUEST.toLocaleString()}자까지 입력할 수 있습니다`);
  const modelIds = [...new Set(input.modelIds)];
  if (modelIds.length < 2 || modelIds.length > MAX_MEMBERS) throw new StudioError(400, `비교할 모델을 2~${MAX_MEMBERS}개 고르세요`);
  const options = listModelOptions();
  const selected = modelIds.map((id) => {
    const model = options.find((candidate) => candidate.id === id && candidate.enabled !== false);
    if (!model) throw new StudioError(400, `등록되지 않은 모델입니다: ${id}`);
    if (!model.configured) throw new StudioError(400, `${model.label}의 API 키 환경 변수가 설정되지 않았습니다`);
    if (!model.capabilities.includes('tools')) throw new StudioError(400, `${model.label}은 Coding Agent 도구 호출을 지원하지 않습니다`);
    return model;
  });

  ensureLoaded();
  const fleet: FleetView = {
    id: randomUUID().slice(0, 8),
    owner: input.owner,
    projectId: input.projectId,
    projectName: input.projectId,
    request,
    allowBreaking: input.allowBreaking === true,
    createdAt: new Date().toISOString(),
    members: [],
  };
  fleets.set(fleet.id, fleet);
  persist(fleet);

  for (const model of selected) {
    try {
      const snapshot = await createSession(input.projectId, input.owner, 'copy', { modelId: model.id });
      fleet.projectName = snapshot.projectName;
      const member: FleetMemberView = {
        sessionId: snapshot.id,
        modelId: model.id,
        label: model.label,
        provider: model.provider,
        status: 'booting',
      };
      fleet.members.push(member);
      persist(fleet);
      watchMember(fleet, member);
    } catch (error) {
      fleet.members.push({
        sessionId: `failed-${randomUUID().slice(0, 8)}`,
        modelId: model.id,
        label: model.label,
        provider: model.provider,
        status: 'error',
        summary: describe(error),
        finishedAt: new Date().toISOString(),
      });
      persist(fleet);
    }
  }
  return clone(fleet);
}

export function listFleets(owner: string): FleetView[] {
  ensureLoaded();
  return [...fleets.values()]
    .filter((fleet) => fleet.owner === owner)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30)
    .map(clone);
}

export function getFleet(id: string, owner: string): FleetView {
  ensureLoaded();
  const fleet = fleets.get(id);
  if (!fleet) throw new StudioError(404, 'Agent Fleet을 찾을 수 없습니다');
  if (fleet.owner !== owner) throw new StudioError(403, '이 Agent Fleet을 볼 수 없습니다');
  return clone(fleet);
}

export function chooseFleetWinner(id: string, sessionId: string, owner: string): FleetView {
  ensureLoaded();
  const fleet = fleets.get(id);
  if (!fleet) throw new StudioError(404, 'Agent Fleet을 찾을 수 없습니다');
  if (fleet.owner !== owner) throw new StudioError(403, '이 Agent Fleet을 바꿀 수 없습니다');
  const member = fleet.members.find((candidate) => candidate.sessionId === sessionId);
  if (!member) throw new StudioError(400, '이 Fleet에 속하지 않은 세션입니다');
  if (member.status !== 'done') throw new StudioError(409, '검증을 통과한 결과만 승자로 선택할 수 있습니다');
  fleet.winnerSessionId = sessionId;
  persist(fleet);
  return clone(fleet);
}

function watchMember(fleet: FleetView, member: FleetMemberView): void {
  if (subscribed.has(member.sessionId) || terminal(member.status)) return;
  subscribed.add(member.sessionId);
  let unsubscribe = () => {};
  unsubscribe = subscribe(member.sessionId, (event) => {
    try {
      updateMember(fleet, member, event);
    } catch (error) {
      // 비교 화면의 기록 실패가 실제 에이전트 실행과 체크포인트 저장을 깨뜨리면 안 된다
      console.error(`[b-studio] Agent Fleet ${fleet.id}/${member.sessionId} 상태를 반영하지 못했습니다`, error);
    } finally {
      if (terminal(member.status)) {
        subscribed.delete(member.sessionId);
        unsubscribe();
      }
    }
  });
  // subscribe가 이전 이벤트를 재생하는 동안 이미 끝난 세션일 수 있다
  if (terminal(member.status)) {
    subscribed.delete(member.sessionId);
    unsubscribe();
  }
}

function updateMember(fleet: FleetView, member: FleetMemberView, event: StudioEvent): void {
  if (event.type === 'snapshot') {
    if (event.snapshot.status === 'ready' && !member.runId && member.status === 'booting') startMember(fleet, member);
    if (event.snapshot.status === 'failed') failMember(fleet, member, event.snapshot.error ?? '샌드박스를 시작하지 못했습니다');
    return;
  }
  if (event.type === 'status') {
    if (event.status === 'ready' && !member.runId && member.status === 'booting') startMember(fleet, member);
    if (event.status === 'failed') failMember(fleet, member, event.error ?? '샌드박스를 시작하지 못했습니다');
    if (event.status === 'stopped' && !terminal(member.status)) failMember(fleet, member, '샌드박스가 중지됐습니다');
    return;
  }
  if (event.type === 'run_started' && event.runId === member.runId) {
    member.status = 'running';
    member.startedAt = new Date().toISOString();
    persist(fleet);
    return;
  }
  if (event.type === 'checkpoint' && event.runId === member.runId) {
    member.checkpoint = { sha: event.checkpoint.sha, shortSha: event.checkpoint.shortSha, files: event.checkpoint.files };
    persist(fleet);
    return;
  }
  if (event.type === 'run_finished' && event.runId === member.runId) {
    member.status = event.status;
    member.summary = event.summary;
    member.turns = event.turns;
    member.usage = event.usage;
    member.finishedAt = new Date().toISOString();
    try {
      const model = modelById(member.modelId);
      member.costUsd = event.usage ? estimateCost(model, event.usage) : undefined;
    } catch {
      // 실행 중 레지스트리에서 모델을 지웠어도 세션 결과 자체는 보존한다
      member.costUsd = undefined;
    }
    persist(fleet);
  }
}

function startMember(fleet: FleetView, member: FleetMemberView): void {
  // 같은 ready 이벤트가 재생돼도 runId를 먼저 넣어 한 번만 보낸다
  member.runId = 'starting';
  try {
    const { runId } = sendMessage(member.sessionId, fleet.request, { allowBreaking: fleet.allowBreaking, by: fleet.owner });
    member.runId = runId;
    member.status = 'running';
    member.startedAt = new Date().toISOString();
  } catch (error) {
    member.status = 'error';
    member.summary = describe(error);
    member.finishedAt = new Date().toISOString();
  }
  persist(fleet);
}

function failMember(fleet: FleetView, member: FleetMemberView, summary: string): void {
  if (terminal(member.status)) return;
  member.status = 'error';
  member.summary = summary;
  member.finishedAt = new Date().toISOString();
  persist(fleet);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    for (const name of readdirSync(/* turbopackIgnore: true */ root())) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(root(), name), 'utf8')) as FleetView;
        if (!parsed?.id || !Array.isArray(parsed.members)) continue;
        // 프로세스가 바뀌면 진행 중 실행을 그대로 이어받을 수 없다. 세션 기록은 각 링크에서 확인할 수 있다
        for (const member of parsed.members) {
          if (!terminal(member.status)) {
            const snapshot = getSnapshot(member.sessionId);
            if (snapshot?.status === 'ready') watchMember(parsed, member);
            else {
              member.status = 'error';
              member.summary = 'Studio가 다시 시작되어 진행 상태를 이어받지 못했습니다. 세션을 열어 기록을 확인하세요.';
              member.finishedAt = new Date().toISOString();
            }
          }
        }
        fleets.set(parsed.id, parsed);
      } catch (error) {
        console.error(`[b-studio] Agent Fleet ${name}을 읽지 못했습니다`, error);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[b-studio] Agent Fleet 목록을 읽지 못했습니다', error);
  }
}

function persist(fleet: FleetView): void {
  const directory = root();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${fleet.id}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(fleet, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

function root(): string {
  return path.resolve(/* turbopackIgnore: true */ process.env.B_STUDIO_FLEETS_DIR ?? path.join(homedir(), '.cache', 'b-studio', 'fleets'));
}

function terminal(status: FleetMemberView['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'error' || status === 'cancelled';
}

function clone(fleet: FleetView): FleetView {
  return structuredClone(fleet);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
