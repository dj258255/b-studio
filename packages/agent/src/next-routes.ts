import { native, encodeNative, decodeNative } from '@b-studio/sandbox';
import { AUTO_PAGE_DEFAULT, AUTO_PAGE_MAX } from '@b-studio/spec';

/**
 * 이번 실행에서 바뀐 파일 목록에서 "게이트가 스스로 열어 볼 Next.js 페이지"를 찾는다(순수 함수).
 *
 * 왜 필요한가: 게이트의 화면 확인은 studio.yaml에 적어 둔 페이지만 열어서, 이번 실행이 **새로 만든 페이지**가
 * 500을 내도 통과했습니다(E1~E4 내내 반복된 원인, 예: E2의 order-summary). 여기서는 선언 대신 바뀐 파일에서
 * 경로를 유도한다.
 *
 * 범위(한계):
 *  - `routesFromChangedFiles`는 **바뀐 page 파일만** 본다. 컴포넌트·유틸·layout만 바뀐 실행은 `routesFromCandidates`가 맡는다 —
 *    게이트가 서비스 소스의 import를 거꾸로 따라가(import-graph.ts, ADR-154) 찾은 "바뀐 파일을 쓰는 page"를 거리순으로 받아
 *    같은 규칙으로 경로를 만든다. 그 추적의 한계(정규식 기반 근사, 별칭·동적 import 범위, 깊이·파일 수·시간 상한)는 import-graph.ts 머리 주석 참고.
 *  - layout·template·loading·error·not-found가 바뀌면 그 폴더 아래의 page를 대상으로 삼는다(폴더가 얕은 page 먼저, `maxPages` 안에서).
 *  - app 라우터(`app/**`·`src/app/**`)만 본다. pages 라우터는 다루지 않는다.
 *  - 파일이 있다는 것만 본다(빌드·타입 검사는 게이트의 다른 단계가 맡는다).
 *
 * 경로 고르기는 Rust(`crates/bstudio-guard/src/next_routes.rs`, ADR-191 3단계 3h)가 한다. 여기에는 타입과, 같은 이름·시그니처로 네이티브 모듈을
 * 부르는 얇은 껍데기만 남았다. `maxPages`의 기본값(`AUTO_PAGE_DEFAULT`)과 상한(`AUTO_PAGE_MAX`)은 spec이 정하고, 상한은 호출 때 인자로 넘긴다.
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
  /** import 역추적으로 찾은 경로면 이 page를 열게 한 바뀐 파일(프로젝트 루트 기준). page 파일 자체가 바뀐 것이면 없다 */
  cause?: string;
  /** import 역추적으로 찾은 경로면 바뀐 파일에서 page까지의 import 단계 수(1 이상) */
  distance?: number;
}

export interface SkippedNextRoute {
  file: string;
  reason: string;
}

export interface NextRoutes {
  routes: NextRoute[];
  skipped: SkippedNextRoute[];
}

/** 값이 없는 id류 세그먼트에 기본으로 채우는 값(ADR-078). autoPageChecks.sampleIdFrom이 없거나 실패하면 이 값을 쓴다 */
export const DEFAULT_DYNAMIC_ROUTE_FALLBACK = '1';

/**
 * 세그먼트 이름이 id처럼 보이는지(ADR-078). 그런 이름만 fallbackValue로 채운다 — `slug`처럼 '1'이 말이 안 되는 이름은 그대로 건너뛴다.
 * "grid"처럼 우연히 "id"로 끝나는 이름을 잘못 채우지 않으려고 camelCase 경계(대문자 I)나 구분자(_·-)를 요구한다
 */
export function isIdLikeSegment(name: string): boolean {
  return native.nextRoutesIsIdLikeSegment(name);
}

/**
 * 바뀐 파일에서 열어 볼 페이지를 고른다.
 *  - 서비스 폴더(`servicePath`) 밖의 파일은 보지 않는다
 *  - 동적 세그먼트는 `sampleParams`에 값이 있을 때만 채운다. 없고 `fallbackValue`도 없으면 skipped에 이유와 함께 남긴다.
 *    `fallbackValue`를 주면(ADR-078) `id`처럼 보이는 세그먼트(isIdLikeSegment)만 그 값으로 채우고 `route.usedFallbackParams`에 이름을 남긴다 —
 *    `slug`처럼 id로 보이지 않는 이름은 fallbackValue가 있어도 그대로 건너뛴다(값을 짐작할 근거가 없다)
 *  - 경로 기준으로 중복을 없애고 정렬한 뒤 `maxPages`까지만 돌려준다(넘은 것은 skipped). 정렬은 UTF-16 코드 단위 순서다
 */
export function routesFromChangedFiles(
  files: readonly string[],
  servicePath: string,
  sampleParams: Readonly<Record<string, string>> = {},
  maxPages: number = AUTO_PAGE_DEFAULT,
  fallbackValue?: string,
): NextRoutes {
  return decodeNative<NextRoutes>(
    native.nextRoutesFromChangedFiles([...files], servicePath, encodeNative(sampleParams), maxPages, AUTO_PAGE_MAX, fallbackValue ?? null),
  );
}

/** import 역추적이 찾은 "열어 볼 page" 후보. 파일 경로는 모두 서비스 폴더 기준이다 */
export interface RouteCandidate {
  page: string;
  /** 이 page를 열게 한 바뀐 파일 */
  cause: string;
  /** 바뀐 파일에서 page까지의 import 단계 수. 0이면 바뀐 page 자체 */
  distance: number;
  /** 같은 거리끼리의 순서(작을수록 먼저) */
  tie?: number;
}

/**
 * import 역추적으로 모은 후보에서 열어 볼 페이지를 고른다. 우선순위: (a) 바뀐 page 자체(거리 0), (b) 바뀐 파일을 직접 import하는 page(거리 1),
 * (c) 거리가 먼 page 순 — 같은 거리에서는 `tie`, 그다음 파일 경로 순(UTF-16 코드 단위 순서). 경로 하나는 한 번만 열고(가장 가까운 후보), `maxPages`를 넘는 것은 skipped에 남긴다.
 *  - 상한을 넘은 거리 0 후보는 `routesFromChangedFiles`처럼 페이지마다 한 줄로 남긴다
 *  - 상한을 넘은 거리 1 이상 후보는 바뀐 파일마다 한 줄로 묶어 어떤 경로를 못 열었는지 적는다(공용 파일이 수십 페이지를 끌어와도 결과가 길어지지 않게)
 * 돌려주는 `file`·`cause`는 프로젝트 루트 기준이다.
 */
export function routesFromCandidates(
  candidates: readonly RouteCandidate[],
  servicePath: string,
  sampleParams: Readonly<Record<string, string>> = {},
  maxPages: number = AUTO_PAGE_DEFAULT,
  fallbackValue?: string,
): NextRoutes {
  return decodeNative<NextRoutes>(
    native.nextRoutesFromCandidates(encodeNative(candidates), servicePath, encodeNative(sampleParams), maxPages, AUTO_PAGE_MAX, fallbackValue ?? null),
  );
}
