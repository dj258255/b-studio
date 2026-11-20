import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { estimateCost } from '@b-studio/agent';
import type { FleetCandidate, FleetMemberStatus, FleetMemberView, FleetView } from '@/lib/fleet-types';
import type { SessionMode, StudioEvent } from '@/lib/studio-events';
import { accountProcessEnv, resolveSessionAccount, type AiAccount } from './ai-accounts';
import { StudioError } from './errors';
import { listModelOptions, modelById } from './model-registry';
import { findProject } from './projects';
import { sessionTerminalMode } from './session-terminal';
import { allowedBackends, assertBackendReady, createSession, getSnapshot, resolveSessionBackend, sendMessage, sessionTerminalAllowed, setTerminalCheckChanges, stopAndDeleteSession, subscribe, type BackendPreflights } from './sessions';
import { runTerminalTask, terminalLaneDriver, type TerminalTaskDeps } from './terminal-lane';

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
  /** 구독 해제 함수(세션 id별). 터미널 멤버는 run_finished 뒤 결과가 확정될 때 이것으로 구독을 푼다 */
  unwatch: Map<string, () => void>;
  loaded: boolean;
}
const globalFleets = globalThis as typeof globalThis & { __bStudioFleets?: FleetStore };
const fleetStore: FleetStore = (globalFleets.__bStudioFleets ??= { fleets: new Map(), subscribed: new Set(), unwatch: new Map(), loaded: false });
// 이전 판의 전역(unwatch 없음)이 남아 있어도 쓸 수 있게 채운다(개발 서버의 모듈 다시 읽기)
fleetStore.unwatch ??= new Map();
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
  /** 고른 AI 계정(설정 폴더를 둔 계정). 없으면 그 CLI의 기본 계정 */
  account?: AiAccount;
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
  /** 멤버를 돌리는 방식. 없으면 chat(채팅식 실행). terminal이면 세션 터미널의 CLI에 요청을 붙여 넣어 돌린다 */
  runner?: 'chat' | 'terminal';
  /** 서버 안에서만 넘긴다(테스트). CLI 로그인 확인을 바꿔 끼운다 */
  preflights?: BackendPreflights;
}): Promise<FleetView> {
  const mode = process.env.B_STUDIO_MODE?.trim() || 'api';
  if (!(FLEET_MODES as readonly string[]).includes(mode)) throw new StudioError(409, `여러 후보를 나란히 비교하는 Fleet은 데모가 아닌 모드에서만 쓸 수 있습니다 (지금 모드: ${mode})`);
  const request = input.request.trim();
  if (!request) throw new StudioError(400, '요청 내용을 입력하세요');
  if (request.length > MAX_REQUEST) throw new StudioError(400, `요청은 ${MAX_REQUEST.toLocaleString()}자까지 입력할 수 있습니다`);

  const runner = input.runner ?? 'chat';
  if (runner !== 'chat' && runner !== 'terminal') throw new StudioError(400, 'runner는 chat 또는 terminal이어야 합니다');

  const candidates = candidatesOf(input);
  if (candidates.length < 2 || candidates.length > MAX_MEMBERS) throw new StudioError(400, `비교할 후보를 2~${MAX_MEMBERS}개 고르세요`);
  const selected: ValidatedCandidate[] = [];
  for (const candidate of candidates) selected.push(await validateCandidate(candidate));
  // 터미널로 못 띄우는 후보는 세션을 하나도 만들기 전에 거절한다(조용히 다른 백엔드로 바꾸지 않는다)
  if (runner === 'terminal') assertTerminalRunnable(selected);

  // CLI 백엔드는 멤버를 만들기 전에 로그인을 확인한다. 실패하면 Fleet을 만들지 않고 이유를 알린다
  // (멤버를 몇 개 만들다 실패하면 절반만 뜬 비교가 남는다). 계정을 고른 후보는 그 계정의 설정 폴더로 확인한다(#892)
  const cli = new Map<string, ValidatedCandidate>();
  for (const candidate of selected) if (candidate.backend !== 'api') cli.set(`${candidate.backend}@${candidate.account?.id ?? ''}`, candidate);
  if (cli.size > 0) {
    const project = await findProject(input.projectId);
    if (!project) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
    for (const candidate of cli.values()) await assertBackendReady(candidate.backend, project.root, input.preflights ?? {}, accountProcessEnv(candidate.account));
  }

  ensureLoaded();
  const fleet: FleetView = {
    id: randomUUID().slice(0, 8),
    owner: input.owner,
    projectId: input.projectId,
    projectName: input.projectId,
    request,
    allowBreaking: input.allowBreaking === true,
    runner,
    createdAt: new Date().toISOString(),
    members: [],
  };
  fleets.set(fleet.id, fleet);
  persist(fleet);

  for (const candidate of selected) {
    try {
      // 멤버 세션은 레인과 같은 방식으로 backend·model을 싣는다(레인·플릿이 같은 실행 경로를 탄다)
      const options =
        candidate.backend === 'api'
          ? { backend: 'api' as const, ...(candidate.model ? { modelId: candidate.model } : {}) }
          : { backend: candidate.backend, ...(candidate.model ? { modelId: candidate.model } : {}), ...(candidate.account ? { accountId: candidate.account.id } : {}) };
      const snapshot = await createSession(input.projectId, input.owner, 'copy', options);
      fleet.projectName = snapshot.projectName;
      const member: FleetMemberView = {
        sessionId: snapshot.id,
        backend: candidate.backend,
        ...(candidate.model ? { modelId: candidate.model } : {}),
        ...(candidate.account ? { accountId: candidate.account.id } : {}),
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
        ...(candidate.account ? { accountId: candidate.account.id } : {}),
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
 * 터미널 실행이 띄울 수 있는 후보만 받는다. 세션 터미널은 claude-code를 띄우고, 이 컴퓨터 방식에서만 codex도 띄운다
 * (sessions.ts의 terminalCliKind는 이 컴퓨터 방식의 codex가 아니면 claude를 띄운다 — 컨테이너 방식 codex를 받으면 엉뚱한 CLI가 뜬다).
 * **허용 목록이라 모르는 백엔드는 거절한다**
 */
function assertTerminalRunnable(selected: readonly ValidatedCandidate[]): void {
  if (!sessionTerminalAllowed()) throw new StudioError(400, '이 서버에서는 세션 터미널을 쓸 수 없어 터미널 방식 Fleet을 만들 수 없습니다');
  const mode = sessionTerminalMode();
  for (const candidate of selected) {
    const runnable = candidate.backend === 'claude-code' || (candidate.backend === 'codex' && mode === 'host');
    if (!runnable) throw new StudioError(400, `아직 터미널에서 띄우지 못하는 백엔드입니다: ${candidate.backend}`);
  }
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
async function validateCandidate(candidate: FleetCandidate): Promise<ValidatedCandidate> {
  // 허용 목록 밖 백엔드는 400으로 거부한다(세션 만들기와 같은 규칙)
  const backend = resolveSessionBackend(candidate.backend);
  const model = candidate.model?.trim() || undefined;
  if (backend === 'api') {
    if (candidate.accountId !== undefined) throw new StudioError(400, 'AI 계정은 CLI 후보에만 고릅니다(api 후보는 모델을 고릅니다)');
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
  // CLI 백엔드는 모델 이름을 그대로 그 CLI에 넘긴다(없으면 그 CLI의 계정 기본).
  // 계정은 목록에 있고 그 CLI의 것이어야 한다(아니면 400). 다른 계정으로 조용히 띄우면 다른 구독의 한도를 쓴다
  const account = await resolveSessionAccount(candidate.accountId, backend);
  const label = account ? (model ? `${account.name} · ${model}` : account.name) : (model ?? '계정 기본');
  return { backend, ...(model ? { model } : {}), label, provider: backend, ...(account ? { account } : {}) };
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
  const release = () => {
    subscribed.delete(member.sessionId);
    fleetStore.unwatch.delete(member.sessionId);
    unsubscribe();
  };
  unsubscribe = subscribe(member.sessionId, (event) => {
    try {
      updateMember(fleet, member, event);
    } catch (error) {
      // 비교 화면의 기록 실패가 실제 에이전트 실행과 체크포인트 저장을 깨뜨리면 안 된다
      console.error(`[b-studio] Agent Fleet ${fleet.id}/${member.sessionId} 상태를 반영하지 못했습니다`, error);
    } finally {
      if (terminal(member.status)) release();
    }
  });
  fleetStore.unwatch.set(member.sessionId, release);
  // subscribe가 이전 이벤트를 재생하는 동안 이미 끝난 세션일 수 있다
  if (terminal(member.status)) release();
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
  // 터미널 Fleet의 끝은 runTerminalTask가 돌려준 값으로만 쓴다(늦게 오는 텔레메트리까지 더한 값이라, 여기서 쓰면 두 번 쓴다)
  if (event.type === 'run_finished' && event.runId === member.runId && fleet.runner !== 'terminal') {
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

/** 테스트가 터미널 실행의 driver·이벤트 통로·시계를 바꿔 끼우는 자리. undefined면 실제 값(terminal-lane.ts)을 쓴다 */
let terminalDeps: Partial<TerminalTaskDeps> | undefined;
export function setFleetTerminalDepsForTest(deps: Partial<TerminalTaskDeps> | undefined): void {
  terminalDeps = deps;
}

function startMember(fleet: FleetView, member: FleetMemberView): void {
  // 같은 ready 이벤트가 재생돼도 runId를 먼저 넣어 한 번만 보낸다
  member.runId = 'starting';
  if (fleet.runner === 'terminal') {
    void runTerminalMember(fleet, member);
    return;
  }
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

/**
 * 터미널 멤버 하나를 세션 터미널에서 돌린다. 작업 분해의 터미널 레인과 같은 runTerminalTask를 쓴다.
 * 쓰기 범위는 걸지 않는다(Fleet은 지금도 쓰기 범위가 없다) — `writableScope: []`는 "어디에도 못 쓴다"는 뜻이라 쓰지 않는다
 */
async function runTerminalMember(fleet: FleetView, member: FleetMemberView): Promise<void> {
  const driver = terminalDeps?.driver ?? terminalLaneDriver;
  try {
    await driver.open(member.sessionId);
    // 터미널의 요청은 CLI가 훅으로 알려 와 요청마다 옵션을 실을 수 없다. 붙여 넣기 전에 미리 켜 두면 그 뒤 처음 시작되는 만들기 실행이 가져간다
    if (fleet.allowBreaking) setTerminalCheckChanges(member.sessionId, true);
    const result = await runTerminalTask(
      member.sessionId,
      fleet.request,
      {
        writableScope: undefined,
        doneTests: [],
        onStarted: (runId) => {
          // 이 runId로 이후의 checkpoint 이벤트를 updateMember가 받는다
          if (terminal(member.status)) return;
          member.runId = runId;
          member.status = 'running';
          member.startedAt = new Date().toISOString();
          persist(fleet);
        },
        onWaiting: (note) => {
          if (terminal(member.status) || member.waiting === note) return;
          if (note === undefined) delete member.waiting;
          else member.waiting = note;
          persist(fleet);
        },
      },
      terminalDeps,
    );
    // 멈춤 등으로 먼저 닫힌 멤버는 덮어쓰지 않는다
    if (terminal(member.status)) return;
    member.runId = result.runId;
    member.status = result.status as FleetMemberStatus;
    member.summary = result.summary;
    if (result.usage) member.usage = result.usage;
    if (result.metrics?.usageByModel) member.usageByModel = result.metrics.usageByModel;
    // 비용은 CLI 텔레메트리가 알려 온 값만 쓴다(estimateCost로 추정하지 않는다). 없으면 두지 않는다
    if (result.costUsd !== undefined) member.costUsd = result.costUsd;
    member.finishedAt = new Date().toISOString();
  } catch (error) {
    if (!terminal(member.status)) {
      member.status = 'error';
      member.summary = describe(error);
      member.finishedAt = new Date().toISOString();
    }
  } finally {
    // 켠 허용은 끝나면 반드시 끈다. 허용은 "다음 만들기 실행 하나"가 가져갈 때만 지워진다 — 붙여 넣기 전에 실패했거나 읽기 실행으로 끝났으면
    // 세션에 남아, 뒤에 사람이 그 세션에서 친 무관한 요청이 확인 변경 허용으로 돈다(게이트를 푸는 상태가 남는다)
    if (fleet.allowBreaking) {
      try {
        setTerminalCheckChanges(member.sessionId, false);
      } catch {
        // 세션이 이미 지워졌으면 끌 허용도 없다
      }
    }
    delete member.waiting;
    try {
      persist(fleet);
    } catch (error) {
      console.error(`[b-studio] Agent Fleet ${fleet.id}/${member.sessionId} 상태를 저장하지 못했습니다`, error);
    }
    // 끝난 멤버의 구독은 푼다(터미널 Fleet은 run_finished를 구독이 아니라 결과로 쓰므로 여기서 푼다)
    if (terminal(member.status)) fleetStore.unwatch.get(member.sessionId)?.();
  }
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
    for (const name of readdirSync(root())) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(root(), name), 'utf8')) as FleetView;
        if (!parsed?.id || !Array.isArray(parsed.members)) continue;
        // runner 필드가 생기기 전 기록은 채팅식뿐이었다
        parsed.runner ??= 'chat';
        // 프로세스가 바뀌면 진행 중 실행을 그대로 이어받을 수 없다. 세션 기록은 각 링크에서 확인할 수 있다
        for (const member of parsed.members) {
          // backend 필드가 생기기 전 기록은 api 모드뿐이었다
          member.backend ??= 'api';
          if (!terminal(member.status) && parsed.runner === 'terminal') {
            // 실행을 몰던 runTerminalTask는 프로세스와 함께 사라졌다. 세션이 살아 있어도 이어받을 수 없다
            member.status = 'error';
            member.summary = 'Studio가 다시 시작되어 진행 상태를 이어받지 못했습니다. 세션을 열어 기록을 확인하세요.';
            member.finishedAt = new Date().toISOString();
          } else if (!terminal(member.status)) {
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
  return path.resolve(process.env.B_STUDIO_FLEETS_DIR ?? path.join(homedir(), '.cache', 'b-studio', 'fleets'));
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
