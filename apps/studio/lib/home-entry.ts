/**
 * 홈 입구(입력창 하나 + 방식 선택)의 순수 로직.
 *
 * 방식 목록·프로젝트 자동 선택·모델 기본값·보내기 흐름을 화면에서 떼어 두어 테스트한다.
 * 실제 네트워크는 `submitEntry`에 넘기는 fetch 구현으로만 만진다(테스트는 가짜 fetch를 넘긴다).
 */

export type EntryMethod = 'single' | 'fleet' | 'split';

/** `GET /api/capabilities` 응답. 다른 브랜치가 만든다 — 없으면 한 명만 켠다 */
export interface Capabilities {
  mode?: string;
  single?: { enabled?: boolean };
  fleet?: { enabled?: boolean; reason?: string };
  split?: { enabled?: boolean; reason?: string };
  /** 세션 백엔드로 고를 수 있는 값(서버 모드 + B_STUDIO_BACKENDS). 하나면 고를 게 없다 */
  backends?: string[];
}

export interface MethodOption {
  id: EntryMethod;
  label: string;
  /** 방식 옆 한 줄 설명 */
  description: string;
  enabled: boolean;
  /** 쓸 수 없을 때 보여줄 이유. 활성이면 없다 */
  reason?: string;
}

const METHOD_META: Record<EntryMethod, { label: string; description: string }> = {
  single: { label: '한 명', description: '에이전트 하나가 만들고 검증합니다' },
  fleet: { label: '여러 명 비교', description: '같은 요청을 여러 에이전트가 따로 만들어 고릅니다' },
  split: { label: '나눠서 병렬', description: '요청을 나눠 동시에 만들고 합칩니다' },
};

const UNCHECKED_REASON = '이 서버에서 확인하지 못했습니다';

/**
 * 방식 목록을 만든다. capabilities가 없으면(API가 없거나 실패) 한 명만 켜고 나머지는 확인하지 못했다고 알린다.
 * capabilities가 있으면 각 방식의 enabled를 그대로 따르고, 꺼진 이유가 있으면 그대로 보여 준다.
 */
export function methodOptions(capabilities: Capabilities | undefined): MethodOption[] {
  return (['single', 'fleet', 'split'] as const).map((id) => {
    const meta = METHOD_META[id];
    if (id === 'single') {
      const enabled = capabilities ? capabilities.single?.enabled !== false : true;
      return { id, ...meta, enabled, ...(enabled ? {} : { reason: '지금 쓸 수 없습니다' }) };
    }
    const entry = id === 'fleet' ? capabilities?.fleet : capabilities?.split;
    if (!capabilities) return { id, ...meta, enabled: false, reason: UNCHECKED_REASON };
    const enabled = entry?.enabled === true;
    return { id, ...meta, enabled, ...(enabled ? {} : { reason: entry?.reason ?? UNCHECKED_REASON }) };
  });
}

/**
 * 세션 백엔드로 고를 값. capabilities의 backends가 **둘 이상일 때만** 돌려주고, 없거나 하나뿐이면 빈 목록이다(고를 게 없다).
 * 백엔드 고르기는 "자세히" 안에서만 보인다.
 */
export function backendOptions(capabilities: Capabilities | undefined): string[] {
  const list = capabilities?.backends;
  if (!Array.isArray(list)) return [];
  const values = list.filter((value): value is string => typeof value === "string" && value.length > 0);
  return values.length >= 2 ? values : [];
}

const BACKEND_LABEL: Record<string, string> = {
  api: "Claude API",
  "claude-code": "Claude Code",
  codex: "Codex",
  commandcode: "Command Code",
  opencode: "OpenCode",
  demo: "데모",
};

/** 백엔드 id를 화면에 보여 줄 이름으로 */
export function backendLabel(id: string): string {
  return BACKEND_LABEL[id] ?? id;
}

/** 고른 백엔드가 자기 모델 목록을 내려주는 CLI인지(Command Code·OpenCode). 아니면 모델을 고르지 않는다 */
export function modelsBackendFor(backend: string | undefined): "commandcode" | "opencode" | undefined {
  return backend === "commandcode" || backend === "opencode" ? backend : undefined;
}

/** 프로젝트가 하나뿐이면 그 id를 자동으로 고른다. 여럿이거나 없으면 빈 문자열(사용자가 고른다) */
export function initialProjectId(projects: ReadonlyArray<{ id: string; error?: string }>): string {
  const usable = projects.filter((project) => !project.error);
  return usable.length === 1 ? usable[0]!.id : '';
}

/** 모델 목록에서 "쓸 수 있는" 모델(설정됨·활성·도구 지원)만 순서대로 */
export interface ModelOptionLike {
  id: string;
  configured: boolean;
  enabled?: boolean;
  capabilities: string[];
}

function usableModels(models: readonly ModelOptionLike[]): ModelOptionLike[] {
  return models.filter((model) => model.configured && model.enabled !== false && model.capabilities.includes('tools'));
}

/** 여러 명 비교의 기본 모델(2~4개 중 앞의 count개). 화면에서 고르지 않고 기본값만 쓴다 */
export function defaultFleetModels(models: readonly ModelOptionLike[], count = 2): string[] {
  return usableModels(models).slice(0, Math.max(1, count)).map((model) => model.id);
}

/** 나눠서 병렬의 기본 계획 모델. 없으면 빈 문자열 */
export function defaultPlanModel(models: readonly ModelOptionLike[]): string {
  return usableModels(models)[0]?.id ?? '';
}

export interface EntryInput {
  method: EntryMethod;
  projectId: string;
  text: string;
  workspace: 'copy' | 'local';
  /** 한 명 방식에서 고른 백엔드. 안 고르면 서버 기본(백엔드가 둘 이상일 때만 채운다) */
  backend?: string;
  /** 한 명 방식에서 고른 CLI 모델(Command Code·OpenCode에서만) */
  model?: string;
  /** 여러 명 비교에 쓸 모델 id들(2~4) */
  fleetModelIds: string[];
  /** 나눠서 병렬의 계획 모델 id */
  planModelId: string;
  /**
   * 서버 모드(capabilities.mode). api일 때만 화면이 모델 레지스트리에서 후보·계획 모델을 고른다.
   * 구독 CLI 모드에는 레지스트리 모델이 없으므로 비워 보내 서버 기본(Fleet 기본 후보, 로컬 CLI 계획)을 쓴다
   */
  mode?: string;
}

export type EntryResult = { ok: true; href: string } | { ok: false; error: string; sessionId?: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type PostResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

async function post(fetcher: FetchLike, url: string, payload: unknown): Promise<PostResult> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : '요청을 보내지 못했습니다' };
  return { ok: true, body: data };
}

/**
 * 방식에 맞는 API를 부르고 이동할 주소를 돌려준다. 한 명은 세션을 만든 뒤 그 세션에 요청을 보낸다.
 * 실패하면 이유를 돌려준다(한 명은 세션을 만든 뒤 실패했으면 그 세션 id도 함께 돌려준다).
 */
export async function submitEntry(fetcher: FetchLike, input: EntryInput): Promise<EntryResult> {
  if (!input.projectId) return { ok: false, error: '프로젝트를 고르세요' };
  if (!input.text.trim()) return { ok: false, error: '요청을 입력하세요' };

  if (input.method === 'single') {
    // 고른 백엔드·모델을 그대로 싣는다. 안 고르면 서버가 정한 기본을 쓴다(키를 넣지 않는다)
    const created = await post(fetcher, '/api/sessions', {
      projectId: input.projectId,
      workspace: input.workspace,
      ...(input.backend ? { backend: input.backend } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    if (!created.ok) return created;
    const id = typeof created.body.id === 'string' ? created.body.id : undefined;
    if (!id) return { ok: false, error: '세션을 만들지 못했습니다' };
    const sent = await post(fetcher, `/api/sessions/${id}/messages`, { text: input.text, intent: 'build' });
    return sent.ok ? { ok: true, href: `/sessions/${id}` } : { ok: false, error: sent.error, sessionId: id };
  }

  const apiMode = input.mode === undefined || input.mode === 'api';
  if (input.method === 'fleet') {
    if (apiMode && input.fleetModelIds.length < 2) return { ok: false, error: '여러 명 비교에는 모델이 2개 이상 필요합니다' };
    const created = await post(fetcher, '/api/fleets', { projectId: input.projectId, request: input.text, ...(apiMode ? { modelIds: input.fleetModelIds } : {}) });
    return created.ok ? { ok: true, href: detailHref('/fleets', created.body) } : created;
  }

  if (apiMode && !input.planModelId) return { ok: false, error: '계획에 쓸 모델을 고를 수 없습니다' };
  const created = await post(fetcher, '/api/task-plans', { projectId: input.projectId, request: input.text, ...(apiMode ? { modelId: input.planModelId } : {}) });
  return created.ok ? { ok: true, href: detailHref('/task-plans', created.body) } : created;
}

/** 만든 비교·계획을 바로 연다. 응답에 id가 없으면 목록 화면(가장 최근 것이 먼저 열린다)으로 간다 */
function detailHref(base: '/fleets' | '/task-plans', body: Record<string, unknown>): string {
  return typeof body.id === 'string' && body.id ? `${base}?id=${encodeURIComponent(body.id)}` : base;
}

/** 진행 중 목록에 쓸 최소 항목. /api/agents의 AgentItem과, 그것을 요청 단위로 묶은 작업 항목(work-list) 모두 이 모양이다 */
export interface InboxSource {
  title: string;
  projectName: string;
  href: string;
  state: string;
  attention?: string;
  lastActivityAt: string;
}

/** 개입 필요 먼저, 그다음 작업 중, 그다음 최근 활동 순(작업 화면과 같은 규칙) */
export function sortInbox<T extends InboxSource>(items: readonly T[]): T[] {
  const rank = (item: InboxSource) => (item.attention ? 0 : item.state === 'working' ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/** 진행 중 목록에 보여 줄 앞의 몇 개 */
export function inboxPreview<T extends InboxSource>(items: readonly T[], limit = 5): T[] {
  return sortInbox(items).slice(0, limit);
}
