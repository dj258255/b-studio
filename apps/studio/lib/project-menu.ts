interface RecentSessionLike {
  projectId: string;
}

/** 이 프로젝트의 세션만, 최근 순으로 앞의 몇 개만 남긴다(목록은 이미 최근 활동 순으로 온다) */
export function recentSessionsFor<T extends RecentSessionLike>(sessions: readonly T[], projectId: string, limit: number): T[] {
  return sessions.filter((session) => session.projectId === projectId).slice(0, limit);
}

// numeric: 'always'로 "어제"·"그저께" 같은 관용구 대신 "1일 전"·"2일 전"처럼 분·시간 표시와 같은 모양으로 통일한다
