import type { RepositoryListState } from '@b-studio/agent';
import { StudioError } from './errors';

/** `?state=` 쿼리 값을 검증한다. 생략하면 열림만 본다(기본값) */
export function parseRepositoryListState(value: string | null): RepositoryListState {
  if (value === null || value === '') return 'open';
  if (value === 'all' || value === 'open' || value === 'closed') return value;
  throw new StudioError(400, 'state는 all, open, closed 중 하나여야 합니다');
}
