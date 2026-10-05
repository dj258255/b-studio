import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { estimateCost } from '@b-studio/agent';
import type { FleetCandidate, FleetMemberView, FleetView } from '@/lib/fleet-types';
import type { SessionMode, StudioEvent } from '@/lib/studio-events';
import { StudioError } from './errors';
import { listModelOptions, modelById } from './model-registry';
import { findProject } from './projects';
import { allowedBackends, assertBackendReady, createSession, getSnapshot, resolveSessionBackend, sendMessage, stopAndDeleteSession, subscribe, type BackendPreflights } from './sessions';

const MAX_MEMBERS = 4;
const MAX_REQUEST = 20_000;
/**
 * 여러 후보를 나란히 비교하는 Agent Fleet을 쓸 수 있는 모드. **데모만 뺀다** —
 * 데모는 준비된 대본을 도는 것이라 비교할 후보가 아니다. 나머지 백엔드는 멤버 세션을 그 백엔드로 만들면 된다.
 * capabilities가 같은 목록을 화면에 알린다 — 두 곳이 갈라지지 않게 여기 한 곳에 둔다
 */
export const FLEET_MODES = ['api', 'claude-code', 'codex', 'commandcode', 'opencode', 'gemini'] as const;

/**
 * 후보를 주지 않았을 때의 기본 후보(홈 화면이 쓴다).
 * 허용 백엔드가 둘 이상이면 백엔드마다 하나(모델은 그 백엔드의 기본), 하나뿐이면 **같은 백엔드로 두 번** 돌린다 —
 * Fleet의 원래 뜻이 "같은 요청을 독립 후보로 비교"라 모델이 하나여도 독립 시도 두 개가 뜻이 있다.
 */
export function defaultFleetCandidates(backends: readonly SessionMode[]): FleetCandidate[] {
  const unique = [...new Set(backends)];
  if (unique.length === 1) return [{ backend: unique[0]! }, { backend: unique[0]! }];
  return unique.map((backend) => ({ backend }));
}
/** 비교 상태. 페이지와 API 라우트가 모듈을 따로 불러와도 같은 상태를 보도록 전역에 둔다(task-plans.ts와 같은 이유) */
interface FleetStore {
  fleets: Map<string, FleetView>;
  subscribed: Set<string>;
  loaded: boolean;
}
const globalFleets = globalThis as typeof globalThis & { __bStudioFleets?: FleetStore };
const fleetStore: FleetStore = (globalFleets.__bStudioFleets ??= { fleets: new Map(), subscribed: new Set(), loaded: false });
const fleets = fleetStore.fleets;
const subscribed = fleetStore.subscribed;

/** 후보 하나를 검증해 멤버를 만들 때 쓸 값으로 바꾼다. backend마다 model의 뜻과 확인할 것이 다르다 */
interface ValidatedCandidate {
  backend: SessionMode;
  /** 후보가 고른 모델(api=레지스트리 id, CLI=그 CLI의 모델 이름). 없으면 그 백엔드의 기본 */
  model?: string;
  /** 사람이 읽는 후보 이름 */
  label: string;
  /** api는 모델 제공자, CLI는 백엔드 이름 */
  provider: string;
}

export async function createFleet(input: {
  projectId: string;
  request: string;
  /** 후보(backend+model 짝). 없으면 모델 id 목록이나 서버 기본 후보를 쓴다 */
  candidates?: readonly FleetCandidate[];
  /** 기존 API 입력(모델 레지스트리 id 목록). `{ backend: 'api', model: <id> }`와 같다 */
  modelIds?: readonly string[];
  owner: string;
  allowBreaking?: boolean;
  /** 서버 안에서만 넘긴다(테스트). CLI 로그인 확인을 바꿔 끼운다 */
  preflights?: BackendPreflights;
}): Promise<FleetView> {
  const mode = process.env.B_STUDIO_MODE?.trim() || 'api';
  if (!(FLEET_MODES as readonly string[]).includes(mode)) throw new StudioError(409, `여러 후보를 나란히 비교하는 Fleet은 데모가 아닌 모드에서만 쓸 수 있습니다 (지금 모드: ${mode})`);
  const request = input.request.trim();
  if (!request) throw new StudioError(400, '요청 내용을 입력하세요');
  if (request.length > MAX_REQUEST) throw new StudioError(400, `요청은 ${MAX_REQUEST.toLocaleString()}자까지 입력할 수 있습니다`);

  const candidates = candidatesOf(input);
  if (candidates.length < 2 || candidates.length > MAX_MEMBERS) throw new StudioError(400, `비교할 후보를 2~${MAX_MEMBERS}개 고르세요`);
  const selected: ValidatedCandidate[] = candidates.map((candidate) => validateCandidate(candidate));

  // CLI 백엔드는 멤버를 만들기 전에 로그인을 확인한다. 실패하면 Fleet을 만들지 않고 이유를 알린다
  // (멤버를 몇 개 만들다 실패하면 절반만 뜬 비교가 남는다)
  const cliBackends = [...new Set(selected.map((candidate) => candidate.backend).filter((backend) => backend !== 'api'))];
  if (cliBackends.length > 0) {
    const project = await findProject(input.projectId);
    if (!project) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
    for (const backend of cliBackends) await assertBackendReady(backend, project.root, input.preflights ?? {});
  }

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

  for (const candidate of selected) {
    try {
      // 멤버 세션은 레인과 같은 방식으로 backend·model을 싣는다(레인·플릿이 같은 실행 경로를 탄다)
      const options = candidate.backend === 'api' ? { backend: 'api' as const, ...(candidate.model ? { modelId: candidate.model } : {}) } : { backend: candidate.backend, ...(candidate.model ? { modelId: candidate.model } : {}) };
      const snapshot = await createSession(input.projectId, input.owner, 'copy', options);
      fleet.projectName = snapshot.projectName;
      const member: FleetMemberView = {
        sessionId: snapshot.id,
        backend: candidate.backend,
        ...(candidate.model ? { modelId: candidate.model } : {}),
        label: candidate.label,
        provider: candidate.provider,
        status: 'booting',
      };
      fleet.members.push(member);
      persist(fleet);
      watchMember(fleet, member);
    } catch (error) {
      fleet.members.push({
        sessionId: `failed-${randomUUID().slice(0, 8)}`,
        backend: candidate.backend,
        ...(candidate.model ? { modelId: candidate.model } : {}),
        label: candidate.label,
        provider: candidate.provider,
        status: 'error',
        summary: describe(error),
        finishedAt: new Date().toISOString(),
      });
      persist(fleet);
    }
  }
  return clone(fleet);
}

/**
 * 요청에서 후보 목록을 정한다.
 * 명시한 후보 → 기존 입력(모델 id 목록) → 서버 기본 후보 순서다. 기존 입력은 중복을 없애고(예전 규칙 그대로),
 * 명시한 후보는 **중복을 없애지 않는다** — 같은 후보를 두 번 넣는 것이 곧 독립 시도 두 개라 뜻이 있다.
 */
function candidatesOf(input: { candidates?: readonly FleetCandidate[]; modelIds?: readonly string[] }): FleetCandidate[] {
  if (input.candidates && input.candidates.length > 0) return [...input.candidates];
  if (input.modelIds) return [...new Set(input.modelIds)].map((model) => ({ backend: 'api' as const, model }));
  return defaultFleetCandidates([...allowedBackends()]);
}

/** 후보의 backend가 이 서버의 허용 목록 안인지 보고, backend마다 다른 확인을 한다 */
function validateCandidate(candidate: FleetCandidate): ValidatedCandidate {
  // 허용 목록 밖 백엔드는 400으로 거부한다(세션 만들기와 같은 규칙)
  const backend = resolveSessionBackend(candidate.backend);
  const model = candidate.model?.trim() || undefined;
  if (backend === 'api') {
    if (!model) {
      // 모델을 고르지 않으면 요청마다 라우터가 고른다
      return { backend, label: '서버 기본 모델', provider: 'router' };
    }
    const found = listModelOptions().find((entry) => entry.id === model && entry.enabled !== false);
    if (!found) throw new StudioError(400, `등록되지 않은 모델입니다: ${model}`);
    if (!found.configured) throw new StudioError(400, `${found.label}의 API 키 환경 변수가 설정되지 않았습니다`);
    if (!found.capabilities.includes('tools')) throw new StudioError(400, `${found.label}은 Coding Agent 도구 호출을 지원하지 않습니다`);
    return { backend, model, label: found.label, provider: found.provider };
  }
  // CLI 백엔드는 모델 이름을 그대로 그 CLI에 넘긴다(없으면 그 CLI의 계정 기본)
  return { backend, ...(model ? { model } : {}), label: model ?? '계정 기본', provider: backend };
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

/**
 * Agent Fleet 기록을 지운다. 참가자가 하나라도 아직 진행 중(booting·running)이면 지우지 않는다.
 * 지울 때는 이 Fleet을 통째로 지우겠다는 의사가 이미 분명하므로, 끝난 참가자든 실패한 참가자든 그 세션 기록도
 * 함께 지운다(세션이 아직 켜져 있으면 먼저 멈춘 뒤 지운다). 실패해 세션을 만들지 못한 참가자(`failed-` id)는 건너뛴다.
 */
export async function deleteFleet(id: string, owner: string): Promise<void> {
  ensureLoaded();
  const fleet = fleets.get(id);
  if (!fleet) throw new StudioError(404, 'Agent Fleet을 찾을 수 없습니다');
  if (fleet.owner !== owner) throw new StudioError(403, '이 Agent Fleet을 지울 수 없습니다');
  if (fleet.members.some((member) => !terminal(member.status))) {
    throw new StudioError(409, '진행 중인 참가자가 있어 지울 수 없습니다. 끝나거나 멈춘 뒤 지우세요');
  }
  fleets.delete(id);
  removeFleetFile(id);
  await Promise.all(fleet.members.filter((member) => !member.sessionId.startsWith('failed-')).map((member) => stopAndDeleteSession(member.sessionId)));
}

function removeFleetFile(id: string): void {
  try {
    unlinkSync(path.join(root(), `${id}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[b-studio] Agent Fleet ${id} 파일을 지우지 못했습니다`, error);
  }
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
    // 실행 중 모델이 바뀌었으면(승격) 모델별 사용량을 남긴다 — 화면이 토큰 탭과 같은 표기로 보여 준다
    member.usageByModel = event.metrics?.usageByModel;
    member.finishedAt = new Date().toISOString();
    try {
      // 비용은 모델 레지스트리에 단가가 있는 api 후보만 계산한다(CLI 구독은 청구가 없어 의미가 없다)
      const model = member.backend === 'api' && member.modelId ? modelById(member.modelId) : undefined;
      member.costUsd = model && event.usage ? estimateCost(model, event.usage) : undefined;
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
  if (fleetStore.loaded) return;
  fleetStore.loaded = true;
  try {
    for (const name of readdirSync(/* turbopackIgnore: true */ root())) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(root(), name), 'utf8')) as FleetView;
        if (!parsed?.id || !Array.isArray(parsed.members)) continue;
        // 프로세스가 바뀌면 진행 중 실행을 그대로 이어받을 수 없다. 세션 기록은 각 링크에서 확인할 수 있다
        for (const member of parsed.members) {
          // backend 필드가 생기기 전 기록은 api 모드뿐이었다
          member.backend ??= 'api';
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
  // awaiting_input은 플릿 실행에서 오지 않는다(되묻기를 켜지 않는다). 와도 사람이 답할 수 없으니 끝난 것으로 본다
  return status === 'done' || status === 'failed' || status === 'error' || status === 'cancelled' || status === 'awaiting_input';
}

function clone(fleet: FleetView): FleetView {
  return structuredClone(fleet);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
