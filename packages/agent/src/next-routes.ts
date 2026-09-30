import { AUTO_PAGE_DEFAULT, AUTO_PAGE_MAX } from '@b-studio/spec';

/**
 * 이번 실행에서 바뀐 파일 목록에서 "게이트가 스스로 열어 볼 Next.js 페이지"를 찾는다(순수 함수).
 *
 * 왜 필요한가: 게이트의 화면 확인은 studio.yaml에 적어 둔 페이지만 열어서, 이번 실행이 **새로 만든 페이지**가
 * 500을 내도 통과했습니다(E1~E4 내내 반복된 원인, 예: E2의 order-summary). 여기서는 선언 대신 바뀐 파일에서
 * 경로를 유도한다.
 *
 * 범위(한계):
 *  - **page 파일만 본다.** 같은 폴더의 layout·loading·error만 바뀐 경우는 열지 않는다 —
 *    그 폴더에 페이지 파일이 실제로 있는지 작업 공간에서 싸게 알 방법이 없고(존재 확인은 비동기 읽기),
 *    그런 변경은 대개 page 파일도 함께 바뀐다. 필요해지면 그때 workspace를 넘겨받아 넓힌다.
 *  - app 라우터(`app/**`·`src/app/**`)만 본다. pages 라우터는 다루지 않는다.
 *  - 파일이 있다는 것만 본다(빌드·타입 검사는 게이트의 다른 단계가 맡는다).
 */

export interface NextRoute {
  /** 열어 볼 경로. `(group)`은 빠지고 동적 세그먼트는 sampleParams 값으로 채워진다 */
  path: string;
  /** 그 경로를 만든 바뀐 파일(프로젝트 루트 기준) */
  file: string;
  /**
   * sampleParams에 값이 없어 fallbackValue로 채운 세그먼트 이름(ADR-078). 비어 있으면 모두 sampleParams로 채운 것이다.
   * 값이 있으면 호출자는 이 경로가 "추정한 id"로 열렸다는 뜻으로, 404·500만 실패로 보는 등 관대하게 판정해야 한다
   */
  usedFallbackParams?: string[];
}

export interface SkippedNextRoute {
  file: string;
  reason: string;
}

export interface NextRoutes {
  routes: NextRoute[];
  skipped: SkippedNextRoute[];
}

/** `page.tsx`처럼 경로를 만드는 파일. app 바로 아래이거나 그 하위 폴더일 수 있다 */
const PAGE_FILE = /^(?:src\/)?app\/(.*\/)?page\.(?:tsx|jsx|ts|js|mdx)$/;
/** 인터셉트 라우트: (.)photo, (..)photo, (..)(..)photo, (...)photo — 표시가 세그먼트 앞에 붙는다 */
const INTERCEPT_SEGMENT = /^\(\.{1,2}\)+/;
/** 라우트 그룹: (marketing) */
const GROUP_SEGMENT = /^\(.+\)$/;
/** 단순 동적 세그먼트: [id] */
const DYNAMIC_SEGMENT = /^\[([^[\]]+)\]$/;
/** 값이 없는 id류 세그먼트에 기본으로 채우는 값(ADR-078). autoPageChecks.sampleIdFrom이 없거나 실패하면 이 값을 쓴다 */
export const DEFAULT_DYNAMIC_ROUTE_FALLBACK = '1';

/**
 * 세그먼트 이름이 id처럼 보이는지(ADR-078). 그런 이름만 fallbackValue로 채운다 — `slug`처럼 '1'이 말이 안 되는 이름은 그대로 건너뛴다.
 * "grid"처럼 우연히 "id"로 끝나는 이름을 잘못 채우지 않으려고 camelCase 경계(대문자 I)나 구분자(_·-)를 요구한다
 */
export function isIdLikeSegment(name: string): boolean {
  if (/^id$/i.test(name)) return true; // id, ID
  if (/[a-z0-9]Id$/.test(name)) return true; // orderId, userId (대문자 I가 있어야 한다 — grid는 빠진다)
  if (/[_-]id$/i.test(name)) return true; // order_id, order-id
  return false;
}

type Segment =
  | { kind: 'group' }
  | { kind: 'static' }
  | { kind: 'dynamic'; name: string }
  | { kind: 'skip'; reason: string };

function classify(segment: string): Segment {
  // 병렬 라우트(@modal)는 같은 URL을 여러 파일이 나눠 그려서 경로 하나로 정할 수 없다
  if (segment.startsWith('@')) return { kind: 'skip', reason: '병렬 라우트(@slot)는 경로를 하나로 정할 수 없어 열지 않습니다' };
  // 인터셉트 라우트((.) (..))는 다른 경로를 가로채는 파일이라 그 자체가 화면 주소가 아니다
  if (INTERCEPT_SEGMENT.test(segment)) return { kind: 'skip', reason: '인터셉트 라우트((.)·(..))는 화면 주소가 아니어서 열지 않습니다' };
  // catch-all([...x])·optional catch-all([[...x]])은 어떤 값이 들어와야 하는지 알 수 없다
  if (/^\[{1,2}\.\.\.[^\]]+\]{1,2}$/.test(segment)) return { kind: 'skip', reason: 'catch-all 라우트([...x])는 열어 볼 값을 정할 수 없어 열지 않습니다' };
  const dynamic = DYNAMIC_SEGMENT.exec(segment);
  if (dynamic) return { kind: 'dynamic', name: dynamic[1]! };
  if (segment.startsWith('[')) return { kind: 'skip', reason: `동적 세그먼트 형식을 알아볼 수 없어 열지 않습니다: ${segment}` };
  // 라우트 그룹((marketing))은 주소에 나타나지 않는다
  if (GROUP_SEGMENT.test(segment)) return { kind: 'group' };
  return { kind: 'static' };
}

/** 윈도 구분자와 `./`를 없애고 `a//b` 같은 중복 슬래시를 하나로 접는다 */
function normalizePath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

/**
 * 바뀐 파일에서 열어 볼 페이지를 고른다.
 *  - 서비스 폴더(`servicePath`) 밖의 파일은 보지 않는다
 *  - 동적 세그먼트는 `sampleParams`에 값이 있을 때만 채운다. 없고 `fallbackValue`도 없으면 skipped에 이유와 함께 남긴다.
 *    `fallbackValue`를 주면(ADR-078) `id`처럼 보이는 세그먼트(isIdLikeSegment)만 그 값으로 채우고 `route.usedFallbackParams`에 이름을 남긴다 —
 *    `slug`처럼 id로 보이지 않는 이름은 fallbackValue가 있어도 그대로 건너뛴다(값을 짐작할 근거가 없다)
 *  - 경로 기준으로 중복을 없애고 정렬한 뒤 `maxPages`까지만 돌려준다(넘은 것은 skipped)
 */
export function routesFromChangedFiles(
  files: readonly string[],
  servicePath: string,
  sampleParams: Readonly<Record<string, string>> = {},
  maxPages: number = AUTO_PAGE_DEFAULT,
  fallbackValue?: string,
): NextRoutes {
  const prefix = normalizePath(servicePath);
  const limit = Math.max(1, Math.min(Math.floor(maxPages), AUTO_PAGE_MAX));
  const routes = new Map<string, NextRoute>();
  const skipped: SkippedNextRoute[] = [];

  for (const file of [...new Set(files.map(normalizePath))].sort()) {
    // 서비스 폴더 밖의 파일은 이 서비스의 페이지가 아니다
    const relative = prefix === '' || prefix === '.' ? file : file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : undefined;
    if (relative === undefined) continue;
    const match = PAGE_FILE.exec(relative);
    if (!match) continue;

    const folder = (match[1] ?? '').replace(/\/$/, '');
    const segments = folder === '' ? [] : folder.split('/');
    const parts: string[] = [];
    const usedFallback: string[] = [];
    let reason: string | undefined;
    for (const segment of segments) {
      const classified = classify(segment);
      if (classified.kind === 'skip') {
        reason = classified.reason;
        break;
      }
      if (classified.kind === 'group') continue;
      if (classified.kind === 'dynamic') {
        const value = sampleParams[classified.name];
        if (value !== undefined && value !== '') {
          parts.push(encodeURIComponent(value));
          continue;
        }
        if (fallbackValue !== undefined && isIdLikeSegment(classified.name)) {
          parts.push(encodeURIComponent(fallbackValue));
          usedFallback.push(classified.name);
          continue;
        }
        reason = `동적 세그먼트 '${classified.name}'의 값이 없습니다 — autoPageChecks.sampleParams에 넣으세요`;
        break;
      }
      parts.push(segment);
    }
    if (reason !== undefined) {
      skipped.push({ file, reason });
      continue;
    }
    const path = `/${parts.join('/')}`;
    if (!routes.has(path)) routes.set(path, { path, file, ...(usedFallback.length > 0 ? { usedFallbackParams: usedFallback } : {}) });
  }

  const sorted = [...routes.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const route of sorted.slice(limit)) {
    skipped.push({ file: route.file, reason: `한 번에 열어 보는 페이지 상한(${limit}개)을 넘었습니다 — autoPageChecks.maxPages를 늘리세요` });
  }
  return { routes: sorted.slice(0, limit), skipped };
}
