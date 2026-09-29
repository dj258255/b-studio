/**
 * 개발 화면 머리의 프로젝트 메뉴(ADR-070)가 쓰는 순수 로직.
 *
 * 새로 시작 화면(`/start`)을 없애면서, 다른 프로젝트로 바꾸기·최근 세션 보기를 개발 화면 머리의 팝오버로 옮겼다.
 * 목록 거르기·자르기만 여기서 떼어 테스트하고, 팝오버 자체(열고 닫기·불러오기)는 컴포넌트에 둔다.
 */

interface MenuProjectLike {
  id: string;
  error?: string;
}

/**
 * 팝오버에 보여 줄 프로젝트. studio.yaml 오류 등으로 열 수 없는 프로젝트는 뺀다 — 다만 지금 보는 프로젝트는
 * (열려 있으므로 오류가 있을 리 없지만) 혹시라도 있다면 목록에서 사라져 못 돌아오지 않도록 남겨 둔다.
 */
export function selectableProjects<T extends MenuProjectLike>(projects: readonly T[], currentId: string): T[] {
  return projects.filter((project) => !project.error || project.id === currentId);
}

interface RecentSessionLike {
  projectId: string;
}

/** 이 프로젝트의 세션만, 최근 순으로 앞의 몇 개만 남긴다(목록은 이미 최근 활동 순으로 온다) */
export function recentSessionsFor<T extends RecentSessionLike>(sessions: readonly T[], projectId: string, limit: number): T[] {
  return sessions.filter((session) => session.projectId === projectId).slice(0, limit);
}
