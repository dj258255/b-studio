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

interface EmptySessionLike {
  lastRequest?: string;
}

/**
 * 한 번도 요청을 보내지 않은 세션(`lastRequest` 없음)은 "아직 보낸 요청이 없습니다"만 보여 여러 개가 있으면
 * 서로 구별되지 않는다 — 목록은 이미 최근 순으로 왔으므로(`recentSessionsFor`) 그 중 가장 최근 것 하나만
 * 남기고 나머지 빈 세션은 뺀다. 가장 단순하면서도 "최근 세션" 목록의 목적(다시 들어갈 세션을 찾는 것)에
 * 맞는 선택이다 — 더 오래된 빈 세션은 어차피 내용이 없어 다시 찾아 들어갈 이유가 적다.
 */
export function collapseEmptySessions<T extends EmptySessionLike>(sessions: readonly T[]): T[] {
  let keptEmpty = false;
  return sessions.filter((session) => {
    if (session.lastRequest) return true;
    if (keptEmpty) return false;
    keptEmpty = true;
    return true;
  });
}

// numeric: 'always'로 "어제"·"그저께" 같은 관용구 대신 "1일 전"·"2일 전"처럼 분·시간 표시와 같은 모양으로 통일한다
const RELATIVE_TIME = new Intl.RelativeTimeFormat('ko', { numeric: 'always' });

/** ISO 시각을 "3분 전"·"어제" 같은 한국어 상대 시간으로. 파싱할 수 없으면 빈 문자열(안 보여준다) */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSeconds = Math.round((then - now.getTime()) / 1000);
  if (diffSeconds > -60) return '방금';
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes > -60) return RELATIVE_TIME.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffSeconds / 3600);
  if (diffHours > -24) return RELATIVE_TIME.format(diffHours, 'hour');
  const diffDays = Math.round(diffSeconds / 86400);
  return RELATIVE_TIME.format(diffDays, 'day');
}

/** 목록에서 세션을 구별하는 용도의 짧은 id(앞 8자) */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}
