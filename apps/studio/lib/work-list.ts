/**
 * 작업 화면의 목록 규칙(순수 함수). `/api/agents`의 목록은 에이전트 단위(세션·레인·비교 참가자)라,
 * 여러 명 비교 하나에 참가자가 셋이면 세 줄이 된다. 사람은 "요청 하나"를 단위로 보므로 같은 비교·계획에 속한 항목을 한 줄로 묶는다.
 *
 * 서버 모듈에서는 타입만 가져온다(값을 가져오면 서버 코드가 브라우저 번들에 섞인다).
 */
import type { AgentAttention, AgentItem, AgentState } from './server/agents-overview';
import { MAX_SPLIT } from './split';

/** 홈의 방식 이름과 같게 쓴다 */
export type WorkMode = 'single' | 'fleet' | 'split';

export const WORK_MODE_LABEL: Record<WorkMode, string> = { single: '한 명', fleet: '여러 명 비교', split: '나눠서 병렬' };

/** 개입 사유 우선순위. 서버(agents-overview의 ATTENTION_PRIORITY)와 같은 순서여야 한다(테스트로 묶는다) */
export const WORK_ATTENTION_PRIORITY: readonly AgentAttention[] = ['question', 'approval', 'gate_failed', 'error', 'budget'];

/** 묶은 줄의 대표 상태. 움직이는 것을 먼저 보여 준다 */
const STATE_PRIORITY: readonly AgentState[] = ['working', 'booting', 'error', 'idle', 'dormant', 'stopped'];

type Usage = NonNullable<AgentItem['tokens']>;

export interface WorkItem {
  /** 한 명이면 `session:<id>`, 묶음이면 `fleet:<id>`·`plan:<id>` */
  key: string;
  mode: WorkMode;
  title: string;
  projectName: string;
  /** 한 명이면 세션 화면, 묶음이면 비교·병렬 화면에서 그 작업 */
  href: string;
  owner?: string;
  state: AgentState;
  attention?: AgentAttention;
  lastActivityAt: string;
  /** 구성원 토큰 합. 아무도 토큰이 없으면 없다 */
  tokens?: Usage;
  /** 구성원(한 명이면 자기 자신 하나) */
  members: AgentItem[];
  /** 나란히 볼 수 있는 세션 id. 승인 대기 계획처럼 세션이 아직 없으면 비어 있다 */
  sessionIds: string[];
}

/** 목록 탭. 방식(한 명·비교·병렬)으로는 나누지 않는다 — 방식은 줄마다 작은 표시로만 보인다(ADR-069) */
export type WorkTab = 'attention' | 'working' | 'all';

/** 에이전트 항목을 작업 단위로 묶고, 개입 필요 → 작업 중 → 최근 활동 순으로 세운다 */
export function groupWork(items: readonly AgentItem[]): WorkItem[] {
  const groups = new Map<string, AgentItem[]>();
  for (const item of items) {
    const key = item.group ? `${item.group.kind}:${item.group.id}` : `session:${item.id}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([key, members]) => toWork(key, members)).sort(compareWork);
}

function toWork(key: string, members: AgentItem[]): WorkItem {
  const first = members[0]!;
  const group = first.group;
  const mode: WorkMode = !group ? 'single' : group.kind === 'fleet' ? 'fleet' : 'split';
  const attention = WORK_ATTENTION_PRIORITY.find((candidate) => members.some((member) => member.attention === candidate));
  const state = STATE_PRIORITY.find((candidate) => members.some((member) => member.state === candidate)) ?? first.state;
  const lastActivityAt = members.map((member) => member.lastActivityAt).reduce((latest, at) => (at > latest ? at : latest));
  const tokens = sumTokens(members);
  return {
    key,
    mode,
    title: first.title,
    projectName: first.projectName,
    href: group?.href ?? first.href,
    ...(first.owner ? { owner: first.owner } : {}),
    state,
    ...(attention ? { attention } : {}),
    lastActivityAt,
    ...(tokens ? { tokens } : {}),
    members,
    // 승인 대기 계획(`plan:<id>`)은 세션이 아니라 나란히 볼 수 없다
    sessionIds: members.map((member) => member.id).filter((id) => !id.startsWith('plan:')),
  };
}

function sumTokens(members: readonly AgentItem[]): Usage | undefined {
  const withTokens = members.filter((member) => member.tokens);
  if (withTokens.length === 0) return undefined;
  return withTokens.reduce<Usage>(
    (total, member) => ({
      inputTokens: total.inputTokens + member.tokens!.inputTokens,
      outputTokens: total.outputTokens + member.tokens!.outputTokens,
      cacheReadTokens: total.cacheReadTokens + member.tokens!.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + member.tokens!.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

function compareWork(a: WorkItem, b: WorkItem): number {
  const rank = (work: WorkItem) => (work.attention ? 0 : work.state === 'working' ? 1 : 2);
  return rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt);
}

export function filterWork(works: readonly WorkItem[], tab: WorkTab): WorkItem[] {
  if (tab === 'all') return [...works];
  if (tab === 'attention') return works.filter((work) => work.attention);
  return works.filter((work) => work.state === 'working' || work.state === 'booting');
}

/** 탭마다 개수. 탭 이름 옆에 보여 준다 */
export function workCounts(works: readonly WorkItem[]): Record<WorkTab, number> {
  return {
    attention: works.filter((work) => work.attention).length,
    working: works.filter((work) => work.state === 'working' || work.state === 'booting').length,
    all: works.length,
  };
}

/** 처음 여는 탭. 개입이 필요한 것이 있으면 그것부터, 없으면 전체 */
export function initialWorkTab(works: readonly WorkItem[]): WorkTab {
  return works.some((work) => work.attention) ? 'attention' : 'all';
}

/**
 * 고른 작업들의 세션을 나란히 보기로 연다. 고른 순서대로 세션을 모으고 중복을 빼며, 상한(MAX_SPLIT)을 넘는 것은 버리고 몇 개인지 알린다
 */
export function splitSelection(works: readonly WorkItem[], selectedKeys: readonly string[]): { ids: string[]; dropped: number } {
  const ids: string[] = [];
  for (const key of selectedKeys) {
    const work = works.find((candidate) => candidate.key === key);
    for (const id of work?.sessionIds ?? []) if (!ids.includes(id)) ids.push(id);
  }
  return { ids: ids.slice(0, MAX_SPLIT), dropped: Math.max(0, ids.length - MAX_SPLIT) };
}

/** 지우기 API 주소. key(`session:<id>`·`fleet:<id>`·`plan:<id>`)의 종류마다 다른 라우트를 부른다 */
export function deleteHref(key: string): string {
  const index = key.indexOf(':');
  const kind = index === -1 ? 'session' : key.slice(0, index);
  const id = index === -1 ? key : key.slice(index + 1);
  if (kind === 'fleet') return `/api/fleets/${encodeURIComponent(id)}/delete`;
  if (kind === 'plan') return `/api/task-plans/${encodeURIComponent(id)}/delete`;
  return `/api/sessions/${encodeURIComponent(id)}/delete`;
}

/**
 * 지금 지울 수 없으면 그 이유(버튼 title·안내 문구에 쓴다), 지울 수 있으면 undefined.
 * 한 명이면 세션 자체가 중지·대기(샌드박스 꺼짐) 상태여야 한다(서버가 실행 중이면 409로 거부한다).
 * 비교·병렬은 구성원 하나라도 작업 중·준비 중이면 막는다(그 밖의 상태는 지울 때 서버가 먼저 멈추고 지운다)
 */
export function deleteBlockReason(work: WorkItem): string | undefined {
  if (work.mode === 'single') {
    // 켜지 못한(error) 세션은 서버가 정리하고 지운다
    return work.state === 'stopped' || work.state === 'dormant' || work.state === 'error' ? undefined : '세션이 아직 실행 중입니다. 먼저 멈춘 뒤 지울 수 있습니다';
  }
  const active = work.members.some((member) => member.state === 'working' || member.state === 'booting');
  return active ? '진행 중인 참가자가 있습니다. 끝나거나 멈춘 뒤 지울 수 있습니다' : undefined;
}

/** 묶음 줄의 구성원 요약. 예: "참가자 3명 · 작업 중 2" / "레인 2개 · 대기 2" */
export function membersSummary(work: WorkItem): string | undefined {
  if (work.mode === 'single') return undefined;
  const sessions = work.members.filter((member) => !member.id.startsWith('plan:'));
  if (sessions.length === 0) return '계획 승인 대기';
  const unit = work.mode === 'fleet' ? `참가자 ${sessions.length}명` : `레인 ${sessions.length}개`;
  const working = sessions.filter((member) => member.state === 'working').length;
  return working > 0 ? `${unit} · 작업 중 ${working}` : unit;
}

/** 작업 줄의 체크박스를 켤 수 있는지. 세션이 아직 없는 작업(계획 승인 대기 등)은 고를 수 없다 */
export function isSelectable(work: WorkItem): boolean {
  return work.sessionIds.length > 0;
}

/** 지금 보이는 목록 기준 "전체 선택" 상태. 고를 수 있는 것이 없으면 none(체크박스를 끈다) */
export function selectAllState(shown: readonly WorkItem[], selectedKeys: readonly string[]): 'all' | 'some' | 'none' | 'empty' {
  const selectable = shown.filter(isSelectable);
  if (selectable.length === 0) return 'empty';
  const picked = selectable.filter((work) => selectedKeys.includes(work.key)).length;
  return picked === 0 ? 'none' : picked === selectable.length ? 'all' : 'some';
}

/**
 * "전체 선택"을 눌렀을 때의 새 선택. 보이는 것이 모두 골라져 있으면 보이는 것만 풀고, 아니면 보이는 것 중 고를 수 있는 것을 모두 더한다.
 * 다른 탭에서 고른 것은 건드리지 않는다
 */
export function toggleSelectAll(shown: readonly WorkItem[], selectedKeys: readonly string[]): string[] {
  const keys = shown.filter(isSelectable).map((work) => work.key);
  if (selectAllState(shown, selectedKeys) === 'all') return selectedKeys.filter((key) => !keys.includes(key));
  return [...selectedKeys, ...keys.filter((key) => !selectedKeys.includes(key))];
}
