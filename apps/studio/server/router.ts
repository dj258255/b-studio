/**
 * app 아래 route.ts의 경로 규칙(Next App Router와 같은 꼴)을 맞추는 작은 라우터.
 * `[id]`는 한 세그먼트, `[...path]`는 하나 이상, `[[...slug]]`는 없어도 되는 나머지, `(묶음)` 폴더는 주소에 들어가지 않는다.
 * 같은 주소에 여럿이 맞으면 고정 세그먼트 → 동적 세그먼트 → 나머지 세그먼트 차례로 앞선다
 */

/** 라우트 모듈. 메서드 이름(GET, POST …)으로 핸들러를 내보낸다 */
export type RouteModule = Record<string, unknown>;

export interface RouteEntry {
  /** `/api/sessions/[id]` 꼴 */
  pattern: string;
  /** 처음 불릴 때 모듈을 불러온다(시작을 빠르게 하고, 쓰지 않는 라우트의 의존성을 불러오지 않는다) */
  load: () => Promise<RouteModule>;
}

type Segment = { kind: 'static'; value: string } | { kind: 'dynamic'; name: string } | { kind: 'rest'; name: string; optional: boolean };

export interface CompiledRoute extends RouteEntry {
  segments: Segment[];
}

export interface RouteMatch {
  route: CompiledRoute;
  params: Record<string, string | string[]>;
}

/** `api/sessions/[id]/route.ts`(app 기준 상대 경로) → `/api/sessions/[id]` */
export function routePathOf(relative: string): string {
  const parts = relative.split(/[\\/]/).slice(0, -1);
  const kept = parts.filter((part) => !(part.startsWith('(') && part.endsWith(')')));
  return `/${kept.join('/')}`;
}

function parseSegment(part: string): Segment {
  const optionalRest = /^\[\[\.\.\.(.+)\]\]$/.exec(part);
  if (optionalRest) return { kind: 'rest', name: optionalRest[1]!, optional: true };
  const rest = /^\[\.\.\.(.+)\]$/.exec(part);
  if (rest) return { kind: 'rest', name: rest[1]!, optional: false };
  const dynamic = /^\[(.+)\]$/.exec(part);
  if (dynamic) return { kind: 'dynamic', name: dynamic[1]! };
  return { kind: 'static', value: part };
}

const RANK: Record<Segment['kind'], number> = { static: 0, dynamic: 1, rest: 2 };

/** 세그먼트를 앞에서부터 견주어 더 구체적인 라우트가 먼저 오게 한다 */
function compareRoutes(a: CompiledRoute, b: CompiledRoute): number {
  const length = Math.max(a.segments.length, b.segments.length);
  for (let i = 0; i < length; i++) {
    const left = a.segments[i];
    const right = b.segments[i];
    if (!left || !right) return left ? -1 : 1;
    const diff = RANK[left.kind] - RANK[right.kind];
    if (diff !== 0) return diff;
  }
  return 0;
}

export function compileRoutes(entries: readonly RouteEntry[]): CompiledRoute[] {
  return entries
    .map((entry) => ({ ...entry, segments: entry.pattern.split('/').filter(Boolean).map(parseSegment) }))
    .sort(compareRoutes);
}

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

function matchSegments(segments: readonly Segment[], parts: readonly string[]): Record<string, string | string[]> | undefined {
  const params: Record<string, string | string[]> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment.kind === 'rest') {
      const rest = parts.slice(i);
      if (rest.length === 0) return segment.optional ? params : undefined;
      params[segment.name] = rest;
      return params;
    }
    const part = parts[i];
    if (part === undefined) return undefined;
    if (segment.kind === 'static') {
      if (segment.value !== part) return undefined;
    } else {
      params[segment.name] = part;
    }
  }
  return parts.length === segments.length ? params : undefined;
}

/** 주소 경로(`/api/x/1`)에 맞는 라우트와 params. 퍼센트 인코딩을 풀지 못하면 맞추지 않는다 */
export function matchRoute(routes: readonly CompiledRoute[], pathname: string): RouteMatch | undefined {
  const parts: string[] = [];
  for (const raw of pathname.split('/').filter(Boolean)) {
    const part = decode(raw);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  for (const route of routes) {
    const params = matchSegments(route.segments, parts);
    if (params) return { route, params };
  }
  return undefined;
}
