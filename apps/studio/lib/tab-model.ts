/**
 * 개발 화면 탭 구조(ADR-087). 화면·API 말고도 열세 개까지 늘어났던 위 탭을 코드·요구사항·실행·저장소 네 묶음으로
 * 합쳤다 — 각 묶음은 하위 탭을 갖고, 마지막으로 본 하위 탭을 localStorage에 기억한다.
 *
 * 이 파일은 렌더링 없이 테스트하는 순수 함수·상수만 담는다(PreviewPanel이 위 탭을, 여기 상수로 하위 탭을 그린다).
 * localStorage 접근은 실패해도(사생활 보호 모드 등) 예외를 내지 않고 조용히 첫 하위 탭으로 돌아간다.
 */
import type { ExternalApiView, ServiceView } from './studio-events';

export interface SubTabOption {
  id: string;
  label: string;
}

export const CODE_SUB_TABS = [
  { id: 'files', label: '파일' },
  { id: 'history', label: '변경 기록' },
] as const satisfies readonly SubTabOption[];
export type CodeSubTab = (typeof CODE_SUB_TABS)[number]['id'];

export const REQUIREMENTS_SUB_TABS = [
  { id: 'spec', label: '명세' },
  { id: 'tests', label: '테스트' },
] as const satisfies readonly SubTabOption[];
export type RequirementsSubTab = (typeof REQUIREMENTS_SUB_TABS)[number]['id'];

export const RUN_SUB_TABS = [
  { id: 'logs', label: '로그' },
  { id: 'resources', label: '리소스' },
  { id: 'deploy', label: '배포' },
] as const satisfies readonly SubTabOption[];
export type RunSubTab = (typeof RUN_SUB_TABS)[number]['id'];

export const REPOSITORY_SUB_TABS = [
  { id: 'issues', label: '이슈·PR' },
  { id: 'presubmit', label: '올리기 전 점검' },
] as const satisfies readonly SubTabOption[];
export type RepositorySubTab = (typeof REPOSITORY_SUB_TABS)[number]['id'];

/** 하위 탭을 가진 상위 탭 묶음. localStorage 키·기본값 계산에 쓴다 */
export const SUB_TAB_GROUPS = {
  code: CODE_SUB_TABS,
  requirements: REQUIREMENTS_SUB_TABS,
  run: RUN_SUB_TABS,
  repository: REPOSITORY_SUB_TABS,
} as const;

// "문서" 탭(ADR-094)은 하위 탭을 두지 않는다 — 문서 목록·미리보기·편집이 한 화면 안에서 함께 움직이고(트리에서 고르면
// 바로 미리보기·편집이 바뀐다), "코드" 탭의 파일/변경 기록처럼 서로 다른 내용을 번갈아 보여줄 하위 화면이 없다.
// 코드 탭의 하위 탭으로 넣는 대신 독립된 위 탭으로 둔 이유: 문서 쓰기는 코드를 "보는" 작업이 아니라 조사 결과를
// 저장소 문서로 정리하는 별도 작업 흐름이라(ADR-094의 연구 → 문서화 → 요구사항 흐름), 요구사항 탭과 같은 급의
// 눈에 띄는 자리가 필요하다 — 코드 탭 안에 묻으면 "문서 쓰기"가 "코드 읽기"의 부속 기능처럼 보인다.

export type SubTabGroup = keyof typeof SUB_TAB_GROUPS;

/** 묶음의 첫 하위 탭(기본값이자 서버 렌더 값) */
export function defaultSubTab(group: SubTabGroup): string {
  return SUB_TAB_GROUPS[group][0].id;
}

/** localStorage에 하위 탭을 저장하는 키. 묶음마다 하나씩 둬 다른 묶음의 기억을 건드리지 않는다 */
export function subTabStorageKey(group: SubTabGroup): string {
  return `b-studio:subtab:${group}`;
}

/**
 * 묶음이 마지막으로 본 하위 탭을 읽는다. storage가 없거나(서버 렌더) 읽기에 실패하거나(사생활 보호 모드 등)
 * 저장값이 지금 이 묶음의 하위 탭 목록에 없으면(예전 값·다른 묶음 값) 첫 하위 탭으로 돌아간다
 */
export function readSubTab(storage: Pick<Storage, 'getItem'> | undefined, group: SubTabGroup): string {
  try {
    const saved = storage?.getItem(subTabStorageKey(group));
    const options = SUB_TAB_GROUPS[group] as readonly SubTabOption[];
    return saved && options.some((option) => option.id === saved) ? saved : defaultSubTab(group);
  } catch {
    return defaultSubTab(group);
  }
}

/** 고른 하위 탭을 저장한다. 저장에 실패해도(사생활 보호 모드 등) 이번 화면의 상태는 호출자가 그대로 반영한다 */
export function writeSubTab(storage: Pick<Storage, 'setItem'> | undefined, group: SubTabGroup, subTab: string): void {
  try {
    storage?.setItem(subTabStorageKey(group), subTab);
  } catch {
    // 저장하지 못해도 화면 전환 자체는 그대로 둔다
  }
}

// ---------------------------------------------------------------------------
// 위 탭(상위 탭) 목록을 세션 스냅샷에서 만드는 순수 함수
// ---------------------------------------------------------------------------

export type TopTab =
  | { kind: 'service'; id: string; label: string; service: ServiceView }
  | { kind: 'external'; id: string; label: string; external: ExternalApiView }
  | { kind: 'group'; id: SubTabGroup; label: string }
  | { kind: 'docs'; id: 'docs'; label: string }
  | { kind: 'status'; id: 'status'; label: string }
  | { kind: 'tokens'; id: 'tokens'; label: string };

/**
 * 개발 화면의 위 탭 목록을 만든다. 화면·API는 서비스마다(로그 전용 서비스는 뺀다), 사내 API는 등록한 것마다,
 * 나머지는 코드·요구사항·실행·저장소·문서·현황·토큰 일곱 자리로 고정한다(ADR-087, 문서는 ADR-094, 현황은
 * ADR-0XX에서 더했다). "현황"은 코드·요구사항·저장소·문서를 각각 들여다보지 않고도 "지금 어디까지 왔는가"를
 * 한 화면에서 읽을 수 있게 그 탭들의 데이터를 다시 모아 보여 주는 자리라, 모으는 대상인 저장소·문서 뒤에 둔다.
 * 서비스 개수와 무관하게 결정론적이라 렌더링 없이 테스트한다(PreviewPanel이 이 목록으로 그린다).
 */
export function buildTopTabs(services: readonly ServiceView[], externals: readonly ExternalApiView[] = []): TopTab[] {
  return [
    ...services
      .filter((service) => service.preview !== 'logs')
      .map((service): TopTab => ({ kind: 'service', id: service.name, label: `${service.preview === 'browser' ? '화면' : 'API'} (${service.name})`, service })),
    ...externals.map((external): TopTab => ({ kind: 'external', id: `external:${external.name}`, label: `사내 API (${external.name})`, external })),
    { kind: 'group', id: 'code', label: '코드' },
    { kind: 'group', id: 'requirements', label: '요구사항' },
    { kind: 'group', id: 'run', label: '실행' },
    { kind: 'group', id: 'repository', label: '저장소' },
    { kind: 'docs', id: 'docs', label: '문서' },
    { kind: 'status', id: 'status', label: '현황' },
    { kind: 'tokens', id: 'tokens', label: '토큰' },
  ];
}

// ---------------------------------------------------------------------------
// 예전(묶기 전) 단일 레벨 탭 id → 새 (상위 묶음, 하위 탭) 매핑
// ---------------------------------------------------------------------------

/** 2026-09까지 개발 화면이 쓰던, 묶기 전의 단일 레벨 탭 id */
export type LegacyTabId = 'design' | 'requirements' | 'tests' | 'code' | 'history' | 'deploy' | 'logs' | 'resources' | 'repository' | 'submission' | 'tokens';

export interface MappedTab {
  /** "screen"은 화면(서비스별) 탭 안의 하위 탭이라 SubTabGroup(이 파일에서 PreviewPanel이 직접 그리는 묶음)에는 없다 */
  group: SubTabGroup | 'screen' | 'tokens';
  subTab?: string;
}

/**
 * 묶기 전 개발 화면이 쓰던 탭 id를 새 (상위 묶음, 하위 탭)으로 옮긴다.
 * 코드 곳곳(예: "테스트" 하위 탭의 file:line 링크가 "코드" 탭을 여는 것)이 예전 id로 탭 전환을 부를 수 있어
 * 렌더링 없이 테스트할 수 있는 순수 함수로 남겨 둔다.
 */
export function mapLegacyTab(id: LegacyTabId): MappedTab {
  switch (id) {
    case 'design':
      return { group: 'screen', subTab: 'design' };
    case 'requirements':
      return { group: 'requirements', subTab: 'spec' };
    case 'tests':
      return { group: 'requirements', subTab: 'tests' };
    case 'code':
      return { group: 'code', subTab: 'files' };
    case 'history':
      return { group: 'code', subTab: 'history' };
    case 'deploy':
      return { group: 'run', subTab: 'deploy' };
    case 'logs':
      return { group: 'run', subTab: 'logs' };
    case 'resources':
      return { group: 'run', subTab: 'resources' };
    case 'repository':
      return { group: 'repository', subTab: 'issues' };
    case 'submission':
      return { group: 'repository', subTab: 'presubmit' };
    case 'tokens':
      return { group: 'tokens' };
  }
}
