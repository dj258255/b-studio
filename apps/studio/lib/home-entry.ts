/**
 * 대화의 넘기기(ADR-068)가 쓰는 순수 로직: 방식에 맞는 API를 불러 비교·계획을 만들고 이동할 주소를 돌려준다.
 *
 * 예전 새로 시작 화면(`/start`)의 입구도 이 함수를 썼지만, 그 화면은 없앴다(ADR-070) — 다른 프로젝트로 시작하는 일은
 * 개발 화면 머리의 프로젝트 메뉴(`lib/project-menu.ts`)로 옮겼다. 방식(한 명/비교/병렬)을 사람이 고르는 목록도 없다(ADR-069).
 * 실제 네트워크는 `submitEntry`에 넘기는 fetch 구현으로만 만진다(테스트는 가짜 fetch를 넘긴다).
 */

export type EntryMethod = 'single' | 'fleet' | 'split';

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
  /** 나눠서 병렬의 계획 모델 id. API 모드에서 사람이 새로 시작 화면 없이 직접 고를 방법이 없어져(ADR-070) 지금은 항상 빈 문자열이다 */
  planModelId: string;
  /**
   * 세션에서 이어받을 모델·노력 단계(대화의 제안 카드를 눌러 나눠서 병렬로 넘길 때만 있다, ADR-068).
   * API 모드면 모델 레지스트리 id(비어 있으면 계획을 만들 수 없다), 로컬 CLI 모드면 그 CLI의 별칭(빈 문자열 = 계정 기본)이다
   */
  sessionModelId?: string;
  sessionEffort?: string;
  /**
   * 서버 모드(capabilities.mode). api일 때만 화면이 모델 레지스트리에서 후보·계획 모델을 고른다.
   * 구독 CLI 모드에는 레지스트리 모델이 없으므로 비워 보내 서버 기본(Fleet 기본 후보, 로컬 CLI 계획)을 쓴다
   */
  mode?: string;
  /**
   * 세션의 넘기기(ADR-068)로 나눠서 병렬을 만들 때 그 세션 id. 있으면(method가 split일 때만 의미가 있다)
   * 레인·통합 세션이 프로젝트 원본이 아니라 이 세션의 최신 체크포인트에서 시작한다(ADR-096, 요구사항·이슈
   * 발행 기록을 이어받는다). 홈에서 새로 시작할 때는 없다
   */
  sourceSessionId?: string;
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

  // 세션에서 이어받은 모델(sessionModelId)이 있으면 그것으로 만든다(API 모드든 로컬 CLI 모드든) —
  // 세션에서 제안을 수락해 넘긴 계획이 세션과 다른(서버 기본) 모델·노력 단계로 도는 문제를 막는다.
  // 없으면(세션 없이 이 화면에서 바로 만들 때) 예전처럼 API 모드에서만 planModelId를 요구한다
  const modelId = input.sessionModelId ?? (apiMode ? input.planModelId : undefined);
  if (apiMode && !modelId) return { ok: false, error: '계획에 쓸 모델을 고를 수 없습니다' };
  const created = await post(fetcher, '/api/task-plans', {
    projectId: input.projectId,
    request: input.text,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(input.sessionEffort ? { effort: input.sessionEffort } : {}),
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
  });
  return created.ok ? { ok: true, href: detailHref('/task-plans', created.body) } : created;
}

/** 만든 비교·계획을 바로 연다. 응답에 id가 없으면 목록 화면(가장 최근 것이 먼저 열린다)으로 간다 */
function detailHref(base: '/fleets' | '/task-plans', body: Record<string, unknown>): string {
  return typeof body.id === 'string' && body.id ? `${base}?id=${encodeURIComponent(body.id)}` : base;
}
