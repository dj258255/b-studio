import { describe, expect, it } from 'vitest';
import { AUTO_PAGE_DEFAULT, AUTO_PAGE_MAX } from '@b-studio/spec';
import {
  isIdLikeSegment,
  routesFromCandidates,
  routesFromChangedFiles,
  type NextRoute,
  type NextRoutes,
  type RouteCandidate,
  type SkippedNextRoute,
} from './next-routes';
import {
  buildProjectStatus,
  type ProjectStatusEstimate,
  type ProjectStatusInput,
  type ProjectStatusRequirementRef,
  type ProjectStatusView,
} from './project-status';
import { detectStuckLoading, type StuckLoadingEvidence } from './stuck-loading';

/**
 * next-routes·project-status·stuck-loading을 Rust로 옮기면서(ADR-191 3단계 3h) 옛 TS 구현을 아래 `legacy*`에 그대로 두고,
 * 같은 무작위 입력을 옛 구현과 새 껍데기에 넣어 결과를 JSON.stringify 글자(키 순서 포함)로 견준다.
 * `legacy*`는 옮기기 전 본문이다(`export`만 뗐다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * `next-routes`의 정렬(`localeCompare`)만 의도한 차이다(Rust는 UTF-16 코드 단위 순서). 그래서 옛 구현을 두 벌로 만든다:
 *  - `legacyLocale`: 옛 그대로(`localeCompare`). 새 결과와 달라지는 경우를 세는 데 쓴다((a) 글자, (b) 열어 볼 경로 집합, (c) 건너뜀 집합).
 *  - `legacyU16`: 비교만 UTF-16 코드 단위 순서로 바꾼 것. 새 껍데기와 **글자까지 같아야** 한다.
 * 상한을 넘은 페이지가 routes에도 skipped(상한 사유)에도 없이 사라지는 경우(조용히 사라짐)는 옛 것과 새 것 모두 0이어야 한다.
 *
 * 크기는 환경 변수로 바꾼다: ROUTES_STATUS_DIFF_SEEDS(쉼표 목록), ROUTES_STATUS_DIFF_ITERATIONS, ROUTES_STATUS_DIFF_REPORT=1(분포 출력)
 */
function makeLegacyRoutes(compare: (a: string, b: string) => number, cap: number) {
  /** `page.tsx`처럼 경로를 만드는 파일. app 바로 아래이거나 그 하위 폴더일 수 있다 */
  const PAGE_FILE = /^(?:src\/)?app\/(.*\/)?page\.(?:tsx|jsx|ts|js|mdx)$/;
  /** 인터셉트 라우트: (.)photo, (..)photo, (..)(..)photo, (...)photo — 표시가 세그먼트 앞에 붙는다 */
  const INTERCEPT_SEGMENT = /^\(\.{1,2}\)+/;
  /** 라우트 그룹: (marketing) */
  const GROUP_SEGMENT = /^\(.+\)$/;
  /** 단순 동적 세그먼트: [id] */
  const DYNAMIC_SEGMENT = /^\[([^[\]]+)\]$/;
  /** 값이 없는 id류 세그먼트에 기본으로 채우는 값(ADR-078). autoPageChecks.sampleIdFrom이 없거나 실패하면 이 값을 쓴다 */
  const DEFAULT_DYNAMIC_ROUTE_FALLBACK = '1';

  /**
   * 세그먼트 이름이 id처럼 보이는지(ADR-078). 그런 이름만 fallbackValue로 채운다 — `slug`처럼 '1'이 말이 안 되는 이름은 그대로 건너뛴다.
   * "grid"처럼 우연히 "id"로 끝나는 이름을 잘못 채우지 않으려고 camelCase 경계(대문자 I)나 구분자(_·-)를 요구한다
   */
  function isIdLikeSegment(name: string): boolean {
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

  /** 서비스 기준 page 파일 경로(`app/orders/[id]/page.tsx`)에서 열 경로를 만든다. 만들 수 없으면 이유를 돌려준다 */
  function routeFromPage(
    relative: string,
    sampleParams: Readonly<Record<string, string>>,
    fallbackValue: string | undefined,
  ): { path: string; usedFallbackParams: string[] } | { reason: string } | undefined {
    const match = PAGE_FILE.exec(relative);
    if (!match) return undefined;
    const folder = (match[1] ?? '').replace(/\/$/, '');
    const segments = folder === '' ? [] : folder.split('/');
    const parts: string[] = [];
    const usedFallback: string[] = [];
    for (const segment of segments) {
      const classified = classify(segment);
      if (classified.kind === 'skip') return { reason: classified.reason };
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
        return { reason: `동적 세그먼트 '${classified.name}'의 값이 없습니다 — autoPageChecks.sampleParams에 넣으세요` };
      }
      parts.push(segment);
    }
    return { path: `/${parts.join('/')}`, usedFallbackParams: usedFallback };
  }

  /**
   * 바뀐 파일에서 열어 볼 페이지를 고른다.
   *  - 서비스 폴더(`servicePath`) 밖의 파일은 보지 않는다
   *  - 동적 세그먼트는 `sampleParams`에 값이 있을 때만 채운다. 없고 `fallbackValue`도 없으면 skipped에 이유와 함께 남긴다.
   *    `fallbackValue`를 주면(ADR-078) `id`처럼 보이는 세그먼트(isIdLikeSegment)만 그 값으로 채우고 `route.usedFallbackParams`에 이름을 남긴다 —
   *    `slug`처럼 id로 보이지 않는 이름은 fallbackValue가 있어도 그대로 건너뛴다(값을 짐작할 근거가 없다)
   *  - 경로 기준으로 중복을 없애고 정렬한 뒤 `maxPages`까지만 돌려준다(넘은 것은 skipped)
   */
  function routesFromChangedFiles(
    files: readonly string[],
    servicePath: string,
    sampleParams: Readonly<Record<string, string>> = {},
    maxPages: number = AUTO_PAGE_DEFAULT,
    fallbackValue?: string,
  ): NextRoutes {
    const prefix = normalizePath(servicePath);
    const limit = Math.max(1, Math.min(Math.floor(maxPages), cap));
    const routes = new Map<string, NextRoute>();
    const skipped: SkippedNextRoute[] = [];

    for (const file of [...new Set(files.map(normalizePath))].sort()) {
      // 서비스 폴더 밖의 파일은 이 서비스의 페이지가 아니다
      const relative = prefix === '' || prefix === '.' ? file : file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : undefined;
      if (relative === undefined) continue;
      const built = routeFromPage(relative, sampleParams, fallbackValue);
      if (built === undefined) continue;
      if ('reason' in built) {
        skipped.push({ file, reason: built.reason });
        continue;
      }
      const { path, usedFallbackParams } = built;
      if (!routes.has(path)) routes.set(path, { path, file, ...(usedFallbackParams.length > 0 ? { usedFallbackParams } : {}) });
    }

    const sorted = [...routes.values()].sort((a, b) => compare(a.path, b.path));
    for (const route of sorted.slice(limit)) {
      skipped.push({ file: route.file, reason: `한 번에 열어 보는 페이지 상한(${limit}개)을 넘었습니다 — autoPageChecks.maxPages를 늘리세요` });
    }
    return { routes: sorted.slice(0, limit), skipped };
  }

  /** 상한 때문에 못 연 페이지를 한 줄로 남길 때 이름을 몇 개까지 적을지 */
  const OVERFLOW_NAMES = 8;

  /**
   * import 역추적으로 모은 후보에서 열어 볼 페이지를 고른다. 우선순위: (a) 바뀐 page 자체(거리 0), (b) 바뀐 파일을 직접 import하는 page(거리 1),
   * (c) 거리가 먼 page 순 — 같은 거리에서는 `tie`, 그다음 파일 경로 순. 경로 하나는 한 번만 열고(가장 가까운 후보), `maxPages`를 넘는 것은 skipped에 남긴다.
   *  - 상한을 넘은 거리 0 후보는 `routesFromChangedFiles`처럼 페이지마다 한 줄로 남긴다
   *  - 상한을 넘은 거리 1 이상 후보는 바뀐 파일마다 한 줄로 묶어 어떤 경로를 못 열었는지 적는다(공용 파일이 수십 페이지를 끌어와도 결과가 길어지지 않게)
   * 돌려주는 `file`·`cause`는 프로젝트 루트 기준이다.
   */
  function routesFromCandidates(
    candidates: readonly RouteCandidate[],
    servicePath: string,
    sampleParams: Readonly<Record<string, string>> = {},
    maxPages: number = AUTO_PAGE_DEFAULT,
    fallbackValue?: string,
  ): NextRoutes {
    const prefix = normalizePath(servicePath);
    const limit = Math.max(1, Math.min(Math.floor(maxPages), cap));
    const toProject = (inService: string): string => (prefix === '' || prefix === '.' ? inService : `${prefix}/${inService}`);
    const ordered = [...candidates].sort((a, b) => a.distance - b.distance || (a.tie ?? 0) - (b.tie ?? 0) || compare(a.page, b.page));

    const routes: NextRoute[] = [];
    const skipped: SkippedNextRoute[] = [];
    const seen = new Set<string>();
    const overflow = new Map<string, { paths: string[] }>();
    for (const candidate of ordered) {
      const built = routeFromPage(candidate.page, sampleParams, fallbackValue);
      if (built === undefined) continue;
      const file = toProject(candidate.page);
      const cause = toProject(candidate.cause);
      if ('reason' in built) {
        skipped.push({ file, reason: candidate.distance > 0 ? `${built.reason} (${cause} 변경으로 찾은 페이지)` : built.reason });
        continue;
      }
      if (seen.has(built.path)) continue;
      seen.add(built.path);
      if (routes.length < limit) {
        routes.push({
          path: built.path,
          file,
          ...(built.usedFallbackParams.length > 0 ? { usedFallbackParams: built.usedFallbackParams } : {}),
          ...(candidate.distance > 0 ? { cause, distance: candidate.distance } : {}),
        });
      } else if (candidate.distance === 0) {
        skipped.push({ file, reason: `한 번에 열어 보는 페이지 상한(${limit}개)을 넘었습니다 — autoPageChecks.maxPages를 늘리세요` });
      } else {
        const entry = overflow.get(cause) ?? { paths: [] };
        entry.paths.push(built.path);
        overflow.set(cause, entry);
      }
    }
    for (const [cause, entry] of overflow) {
      const shown = entry.paths.slice(0, OVERFLOW_NAMES).join(', ');
      const rest = entry.paths.length > OVERFLOW_NAMES ? ` 외 ${entry.paths.length - OVERFLOW_NAMES}개` : '';
      skipped.push({
        file: cause,
        reason: `${cause} 변경을 쓰는 페이지 ${entry.paths.length}개를 한 번에 열어 보는 페이지 상한(${limit}개) 때문에 열지 못했습니다: ${shown}${rest} — autoPageChecks.maxPages를 늘리면 더 엽니다`,
      });
    }
    return { routes, skipped };
  }

  return { routesFromChangedFiles, routesFromCandidates, isIdLikeSegment };
}

const utf16 = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const legacyLocale = makeLegacyRoutes((a, b) => a.localeCompare(b), AUTO_PAGE_MAX);
const legacyU16 = makeLegacyRoutes(utf16, AUTO_PAGE_MAX);
/** 상한을 풀어 "열 수 있는 경로가 모두 몇 개인가"를 센다(조용히 사라짐 검사의 기준) */
const legacyAll = makeLegacyRoutes(utf16, 1e9);

const legacyStatus = (() => {
  function buildCurrentWork(input: ProjectStatusInput): ProjectStatusView['currentWork'] {
    const items = (input.lanes ?? []).map((lane) => `레인 ${lane.id}(${lane.label}): ${lane.status}`);
    if (input.running) return { summary: input.currentRequestSummary?.trim() || '요청을 처리하는 중입니다', items };
    if (items.length > 0) return { summary: '작업 분해 레인이 진행 중입니다', items };
    return { summary: '지금 처리 중인 요청이 없습니다', items };
  }

  function buildPurpose(requirements: readonly ProjectStatusRequirementRef[]): ProjectStatusView['purpose'] {
    const items = requirements
      .filter((requirement) => requirement.priority === 'must' || requirement.priority === 'should')
      .map((requirement) => ({ id: requirement.id, title: requirement.title, ...(requirement.issue !== undefined ? { issue: requirement.issue } : {}) }));
    return { items };
  }

  function buildEta(estimates: readonly ProjectStatusEstimate[] | undefined): ProjectStatusView['eta'] {
    const withEstimate = (estimates ?? []).filter((estimate) => estimate.estimateMinutes !== undefined);
    if (withEstimate.length === 0) return { hasEstimate: false, summary: '추정 없음 — 작업마다 예상 시간을 적어 주세요' };
    const totalEstimate = withEstimate.reduce((sum, estimate) => sum + (estimate.estimateMinutes ?? 0), 0);
    return { hasEstimate: true, summary: `작업 ${withEstimate.length}개에 예상 시간이 있습니다. 합계 ${totalEstimate}분` };
  }

  /** 상태별 개수. 요구사항이 없으면 빈 객체 */
  function tallyByStatus(requirements: readonly ProjectStatusRequirementRef[]): Record<string, number> {
    const byStatus: Record<string, number> = {};
    for (const requirement of requirements) byStatus[requirement.status] = (byStatus[requirement.status] ?? 0) + 1;
    return byStatus;
  }

  function buildVerification(requirements: readonly ProjectStatusRequirementRef[]): ProjectStatusView['verification'] {
    const byStatus = tallyByStatus(requirements);
    if (requirements.length === 0) return { summary: '저장된 요구사항이 없어 검증 기록을 집계할 수 없습니다', byStatus };
    const verified = byStatus['검증됨'] ?? 0;
    return { summary: `${requirements.length}개 중 ${verified}개 검증됨`, byStatus };
  }

  function buildRisks(input: ProjectStatusInput): string[] {
    const risks: string[] = [];
    if (input.openQuestion) risks.push(`되묻는 질문이 멈춰 있습니다: ${input.openQuestion}`);
    const needsRecheck = input.requirements.filter((requirement) => requirement.status === '재확인 필요');
    if (needsRecheck.length > 0) risks.push(`재확인 필요 ${needsRecheck.length}개: ${needsRecheck.map((requirement) => `[${requirement.id}] ${requirement.title}`).join(', ')}`);
    const failed = input.requirements.filter((requirement) => requirement.status === '실패');
    if (failed.length > 0) risks.push(`실패 ${failed.length}개: ${failed.map((requirement) => `[${requirement.id}] ${requirement.title}`).join(', ')}`);
    if (input.manualSteps.length > 0) risks.push(`사람이 할 일이 ${input.manualSteps.length}개 남아 있습니다(에이전트가 하지 않습니다)`);
    if (input.failedServices.length > 0) risks.push(`서비스 실패: ${input.failedServices.join(', ')}`);
    if (input.reviewState?.state === 'stopped') risks.push('PR 자동 리뷰가 멈췄습니다 — 확인이 필요합니다');
    if (input.reviewState?.state === 'capped') risks.push(`PR 자동 리뷰가 라운드 상한(${input.reviewState.rounds})에 도달했습니다`);
    return risks;
  }

  function buildEstimateVsActual(estimates: readonly ProjectStatusEstimate[] | undefined): ProjectStatusView['estimateVsActual'] {
    return (estimates ?? []).map((estimate) => ({
      id: estimate.id,
      label: estimate.label,
      ...(estimate.estimateMinutes !== undefined ? { estimateMinutes: estimate.estimateMinutes } : {}),
      ...(estimate.actualMinutes !== undefined ? { actualMinutes: estimate.actualMinutes } : {}),
      ...(estimate.estimateMinutes !== undefined && estimate.actualMinutes !== undefined
        ? { deltaMinutes: estimate.actualMinutes - estimate.estimateMinutes }
        : {}),
      ...(estimate.note ? { note: estimate.note } : {}),
    }));
  }

  /** 세션·요구사항·체크포인트·레인 데이터를 "현황" 화면 모양으로 모은다. 모두 이미 있는 데이터를 재배열할 뿐, 새로 재지 않는다 */
  function buildProjectStatus(input: ProjectStatusInput): ProjectStatusView {
    return {
      currentWork: buildCurrentWork(input),
      purpose: buildPurpose(input.requirements),
      eta: buildEta(input.estimates),
      deliverables: { checkpoints: input.checkpoints, ...(input.pullRequestUrl ? { pullRequestUrl: input.pullRequestUrl } : {}) },
      risks: { items: buildRisks(input) },
      verification: buildVerification(input.requirements),
      estimateVsActual: buildEstimateVsActual(input.estimates),
      links: input.links,
    };
  }

  return { buildProjectStatus };
})();

const legacyStuck = (() => {
  /** 한 줄이 "로딩 문구뿐"인지 보는 패턴. 줄 전체가 맞아야 하므로 ^...$ 로 감싼다(부분 일치는 걸지 않는다) */
  const LOADING_LINE_PATTERNS: readonly RegExp[] = [
    /^loading(\s*data)?\.{0,3}$/i,
    /^please\s+wait\.{0,3}$/i,
    /^one\s+moment(\s+please)?\.{0,3}$/i,
    /^fetching(\s*data)?\.{0,3}$/i,
    /^(데이터를?\s*)?불러오는\s*중(입니다)?\.{0,3}$/,
    /^로딩\s*중(입니다)?\.{0,3}$/,
    /^로딩\.{0,3}$/,
    /^잠시만\s*기다려\s*주세요\.{0,3}$/,
    /^잠시만\s*기다려\s*주십시오\.{0,3}$/,
  ];

  /** 줄이 로딩 문구뿐인지. 앞뒤 공백·스피너 기호(•…) 정도는 지우고 비교한다 */
  function isLoadingLine(line: string): boolean {
    const trimmed = line.replace(/^[•·\s]+|[•·\s]+$/g, '').trim();
    if (trimmed.length === 0) return false;
    return LOADING_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  /**
   * 렌더링된(또는 SSR) 본문 글자가 로딩 상태에서 멈춘 것으로 보이면 사람이 읽을 한국어 사유를 돌려주고, 아니면 undefined.
   * `evidence`를 생략하면(HTTP 모드처럼 실패한 요청을 모를 때) 빈 화면 판정은 하지 않는다(보수적으로 본다).
   */
  function detectStuckLoading(text: string, evidence?: StuckLoadingEvidence): string | undefined {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    const lines = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      const hasSupportingEvidence = evidence !== undefined && evidence.failedRequests + evidence.consoleErrors + evidence.pageErrors > 0;
      if (!hasSupportingEvidence) return undefined;
      return '화면에 표시된 내용이 없습니다(스켈레톤이거나 데이터를 못 받아 빈 상태로 멈췄을 수 있습니다) — 실패한 요청·콘솔 오류·스크립트 예외를 함께 보세요';
    }

    if (lines.every((line) => isLoadingLine(line))) {
      const shown = normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
      return `화면이 로딩 문구만 보여 준 채 멈췄습니다: "${shown}"`;
    }
    return undefined;
  }

  return { detectStuckLoading };
})();


// ---------------------------------------------------------------------------
// 차등 시험
// ---------------------------------------------------------------------------

/** 선형 합동은 입력이 쏠려(ADR-191 2b-1) mulberry32를 쓴다 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const chance = (rng: Rng, p: number): boolean => rng() < p;
const between = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

const SEEDS = (process.env['ROUTES_STATUS_DIFF_SEEDS'] ?? '1,7,42,2026').split(',').map(Number);
const ITERATIONS = Number(process.env['ROUTES_STATUS_DIFF_ITERATIONS'] ?? 3000);
const REPORT = process.env['ROUTES_STATUS_DIFF_REPORT'] === '1';

/** 짝 없는 서로게이트를 U+FFFD로 바꾼 글자(`String.prototype.toWellFormed`) */
function wellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

function outcome(fn: () => unknown): string {
  try {
    const value = fn();
    return value === undefined ? 'undefined' : JSON.stringify(value);
  } catch {
    return 'THROW';
  }
}

function hist(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function show(map: Map<string, number>): string {
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true })).map(([k, v]) => `${k}:${v}`).join(' ');
}

// ── next-routes 입력 ─────────────────────────────────────────────────────

/** 대소문자만 다른 이름, Next.js 폴더 이름, 한글·é(합쳐 쓴 것·풀어 쓴 것), 보이지 않는 글자, 줄 끝 글자를 섞는다 */
const NAMES = [
  'about', 'About', 'ABOUT', 'a', 'A', 'b', 'B', 'Zeta', 'zeta', 'é', 'e', 'E', 'f', 'Éa', 'ä', 'ä', 'z', '한글', '가', '나', '다', '주문',
  '_private', '_x', '@slot', '@modal', '(group)', '(marketing)', '(shop)', '[id]', '[slug]', '[orderId]', '[user_id]', '[order-id]', '[ID]', '[Id]',
  '[grid]', '[...rest]', '[[...rest]]', '(.)photo', '(..)photo', '(..)(..)x', '[a', 'a]', '[]', '[[id]]', '()', '(a\nb)', 'x-y', 'x_y', 'x.y', '1', '10', '2',
  'a b', 'a​b', 'ab', 'Ab', 'aB', 'ａ', 'ß', 'ss', 'i', 'I', 'ı', 'İ', 'id', 'api', 'orders', 'dashboard', 'settings', 'a%b', 'a b',
];
const EXTENSIONS = ['tsx', 'tsx', 'tsx', 'ts', 'jsx', 'js', 'mdx'];
const PREFIXES = ['', '.', 'apps/web', './apps//web/', 'apps\\web', 'web', 'a b', 'é', 'apps/web/'];

function segments(rng: Rng): string {
  const depth = chance(rng, 0.12) ? 0 : between(rng, 1, 3);
  return Array.from({ length: depth }, () => pick(rng, NAMES)).join(pick(rng, ['/', '/', '/', '/', '//', '\\']));
}

function prefixOf(servicePath: string): string {
  const normalized = servicePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return normalized === '' || normalized === '.' ? '' : `${normalized}/`;
}

function pageFile(rng: Rng, prefix: string): string {
  const folder = segments(rng);
  return `${prefix}${chance(rng, 0.25) ? 'src/' : ''}app/${folder === '' ? '' : `${folder}/`}page.${pick(rng, EXTENSIONS)}`;
}

function sampleParamsOf(rng: Rng): Record<string, string> {
  return pick(rng, [
    {}, {}, { id: '7' }, { id: '7', slug: 's' }, { orderId: 'o 1', user_id: '', slug: 'x/y' }, { id: '한글' }, { ID: '1' }, { 'order-id': '5' },
    { a: '1' }, { Id: 'x#y' }, { grid: 'g' }, { rest: 'r' },
  ] as Record<string, string>[]);
}

function maxPagesOf(rng: Rng): number | undefined {
  if (chance(rng, 0.15)) return undefined;
  return pick(rng, [1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 8, 10, 11, 15, 0, -3, 2.7, 0.5, NaN, Infinity, -Infinity, 1e9, 9.999]);
}

function changedFilesInput(rng: Rng) {
  const servicePath = pick(rng, PREFIXES);
  const prefix = prefixOf(servicePath);
  const count = chance(rng, 0.05) ? 0 : between(rng, 1, 26);
  const files: string[] = [];
  for (let n = 0; n < count; n++) {
    const roll = rng();
    if (roll < 0.68) files.push(pageFile(rng, prefix));
    else if (roll < 0.76) files.push(pageFile(rng, 'other/'));
    else if (roll < 0.88) files.push(`${prefix}${pick(rng, ['app/layout.tsx', 'app/route.ts', 'app/a/page.css', 'app/page.vue', 'pages/index.tsx', 'src/app/loading.tsx', 'app/a/pagex.tsx', 'xapp/page.tsx', 'lib/page.ts'])}`);
    else if (files.length > 0) files.push(pick(rng, ['./', '', './/']) + files[between(rng, 0, files.length - 1)]!.replaceAll('/', pick(rng, ['/', '//', '\\'])));
    else files.push(`${prefix}app/page.tsx`);
  }
  return { files, servicePath, sampleParams: sampleParamsOf(rng), maxPages: maxPagesOf(rng), fallbackValue: pick(rng, [undefined, undefined, '1', 'x y', '', '한글']) };
}

function candidatesInput(rng: Rng) {
  const servicePath = pick(rng, PREFIXES);
  const count = chance(rng, 0.05) ? 0 : between(rng, 1, 32);
  const sharedCause = pick(rng, ['components/Button.tsx', 'lib/db.ts', 'app/layout.tsx', 'a\\b.ts']);
  const candidates: RouteCandidate[] = [];
  const pool = Array.from({ length: between(rng, 3, 20) }, () => pageFile(rng, ''));
  for (let n = 0; n < count; n++) {
    const candidate: Record<string, unknown> = {
      page: chance(rng, 0.9) ? pick(rng, pool) : pick(rng, ['app/layout.tsx', 'lib/x.ts', 'app/page.tsx']),
      cause: chance(rng, 0.6) ? sharedCause : pick(rng, ['components/Card.tsx', 'lib/auth.ts', 'app/a/page.tsx', 'é/ü.ts']),
      distance: chance(rng, 0.3) ? 0 : pick(rng, [1, 1, 1, 2, 2, 3, 4]),
    };
    const odd = rng();
    if (odd < 0.012) candidate['distance'] = NaN;
    else if (odd < 0.02) candidate['distance'] = Infinity;
    else if (odd < 0.03) candidate['distance'] = -1;
    else if (odd < 0.04) candidate['distance'] = 0.5;
    else if (odd < 0.05) delete candidate['distance'];
    const tieRoll = rng();
    if (tieRoll < 0.45) candidate['tie'] = between(rng, 0, 3);
    else if (tieRoll < 0.5) candidate['tie'] = null;
    else if (tieRoll < 0.505) candidate['tie'] = NaN;
    candidates.push(candidate as unknown as RouteCandidate);
  }
  return { candidates, servicePath, sampleParams: sampleParamsOf(rng), maxPages: maxPagesOf(rng), fallbackValue: pick(rng, [undefined, undefined, '1', 'x y', '', '한글']) };
}

// ── 결과 분석 ────────────────────────────────────────────────────────────

/** routes에 든 것 + skipped의 상한 사유가 센 것 = 상한 없이 열 수 있는 경로 수여야 한다(아니면 조용히 사라진 것) */
function accounted(result: NextRoutes): number {
  let total = result.routes.length;
  for (const entry of result.skipped) {
    if (!entry.reason.includes('상한(')) continue;
    const grouped = /변경을 쓰는 페이지 (\d+)개를/.exec(entry.reason);
    total += grouped ? Number(grouped[1]) : 1;
  }
  return total;
}

const pathSet = (result: NextRoutes): string => JSON.stringify(result.routes.map((route: NextRoute) => route.path).sort());
const skippedSet = (result: NextRoutes): string => JSON.stringify(result.skipped.map((entry) => JSON.stringify(entry)).sort());

interface RoutesTally {
  runs: number;
  strictDiff: number;
  threw: number;
  textDiff: number;
  pathSetDiff: number;
  skippedDiff: number;
  vanishOld: number;
  vanishNew: number;
  capped: number;
  limitNaN: number;
  nonFiniteDistance: number;
  nonFiniteStrictDiff: number;
  routesHist: Map<string, number>;
  skippedHist: Map<string, number>;
  first: string[];
}

function newRoutesTally(): RoutesTally {
  return {
    runs: 0, strictDiff: 0, threw: 0, textDiff: 0, pathSetDiff: 0, skippedDiff: 0, vanishOld: 0, vanishNew: 0, capped: 0, limitNaN: 0,
    nonFiniteDistance: 0, nonFiniteStrictDiff: 0, routesHist: new Map(), skippedHist: new Map(), first: [],
  };
}

function bucket(n: number): string {
  return n === 0 ? '0' : n <= 2 ? '1-2' : n <= 5 ? '3-5' : n <= 10 ? '6-10' : '11+';
}

function compareRoutes(
  tally: RoutesTally,
  label: string,
  input: unknown,
  oldLocale: () => NextRoutes,
  oldU16: () => NextRoutes,
  all: () => NextRoutes,
  actual: () => NextRoutes,
  maxPages: number | undefined,
  weird: boolean,
): void {
  tally.runs++;
  const expected = outcome(oldU16);
  const got = outcome(actual);
  if (expected === 'THROW' || got === 'THROW') tally.threw++;
  if (expected !== got) {
    tally.strictDiff++;
    if (weird) tally.nonFiniteStrictDiff++;
    if (tally.first.length < 3) tally.first.push(`${label} ${JSON.stringify(input)}\n  옛(UTF-16)=${expected}\n  새=${got}`);
    return;
  }
  if (weird) tally.nonFiniteDistance++;
  const newResult = actual();
  const locale = oldLocale();
  const universe = all().routes.length;
  if (accounted(newResult) !== universe) tally.vanishNew++;
  if (accounted(locale) !== universe) tally.vanishOld++;
  if (JSON.stringify(locale) !== got) {
    tally.textDiff++;
    if (pathSet(locale) !== pathSet(newResult)) tally.pathSetDiff++;
    if (skippedSet(locale) !== skippedSet(newResult)) tally.skippedDiff++;
  }
  const limit = Math.max(1, Math.min(Math.floor(maxPages ?? AUTO_PAGE_DEFAULT), AUTO_PAGE_MAX));
  if (Number.isNaN(limit)) tally.limitNaN++;
  else if (universe > limit) tally.capped++;
  hist(tally.routesHist, bucket(newResult.routes.length));
  hist(tally.skippedHist, bucket(newResult.skipped.length));
}

function runRoutes(name: string, make: (rng: Rng, tally: RoutesTally) => void): RoutesTally {
  const total = newRoutesTally();
  for (const seed of SEEDS) {
    const rng = mulberry32(seed * 1000 + name.length);
    const tally = newRoutesTally();
    for (let n = 0; n < ITERATIONS; n++) make(rng, tally);
    for (const key of ['runs', 'strictDiff', 'threw', 'textDiff', 'pathSetDiff', 'skippedDiff', 'vanishOld', 'vanishNew', 'capped', 'limitNaN', 'nonFiniteDistance', 'nonFiniteStrictDiff'] as const) total[key] += tally[key];
    for (const [k, v] of tally.routesHist) total.routesHist.set(k, (total.routesHist.get(k) ?? 0) + v);
    for (const [k, v] of tally.skippedHist) total.skippedHist.set(k, (total.skippedHist.get(k) ?? 0) + v);
    total.first.push(...tally.first);
    if (REPORT) {
      console.log(
        `[차등] ${name} 시드 ${seed}: 비교 ${tally.runs}, 새≠옛(UTF-16) ${tally.strictDiff}, 옛(localeCompare)≠새 글자 ${tally.textDiff}, 경로집합 ${tally.pathSetDiff}, 건너뜀집합 ${tally.skippedDiff}, 사라짐 옛 ${tally.vanishOld}·새 ${tally.vanishNew}, 상한에 걸림 ${tally.capped}, 상한 NaN ${tally.limitNaN}`,
      );
    }
  }
  if (REPORT) console.log(`[분포] ${name} routes 개수 ${show(total.routesHist)} | skipped 개수 ${show(total.skippedHist)} | 상한에 걸림 ${((total.capped / total.runs) * 100).toFixed(1)}% | 비정상 distance 입력 ${total.nonFiniteDistance}`);
  return total;
}

describe('차등 시험(3h): 옛 TS 구현과 Rust 껍데기는 같은 입력에 같은 글자를 낸다', () => {
  it('isIdLikeSegment', () => {
    const rng = mulberry32(5);
    let runs = 0;
    let yes = 0;
    for (const seed of SEEDS) {
      const r = mulberry32(seed + 100);
      for (let n = 0; n < ITERATIONS * 4; n++) {
        const name = chance(r, 0.5)
          ? pick(r, NAMES).replace(/^\[|\]$/g, '')
          : (pick(r, ['', 'i', 'd', 'ID', 'Id', 'iD', 'id', 'x', 'a', 'Z', '1', '_', '-', 'İ', 'ı', 'K', 'o', 'rder', 'user', 'order', 'grid', 'valid', 'a1', '0', 'ｉ', 'Ⅰ'])) +
            pick(r, ['', 'id', 'Id', 'ID', '_id', '-id', '_ID', '-Id', 'iD', 'ıd', 'İd', 'i', 'd', 'x']) +
            (chance(r, 0.05) ? '\n' : '');
        runs++;
        const expected = legacyU16.isIdLikeSegment(name);
        if (expected) yes++;
        expect(isIdLikeSegment(name), JSON.stringify(name)).toBe(expected);
      }
    }
    void rng;
    expect(yes).toBeGreaterThan(runs * 0.1);
    expect(yes).toBeLessThan(runs * 0.9);
    if (REPORT) console.log(`[차등] isIdLikeSegment: 비교 ${runs}, 참 ${yes}`);
  });

  it('routesFromChangedFiles', () => {
    const total = runRoutes('routesFromChangedFiles', (rng, tally) => {
      const i = changedFilesInput(rng);
      const call = (impl: { routesFromChangedFiles: typeof legacyU16.routesFromChangedFiles }) => (): NextRoutes =>
        impl.routesFromChangedFiles(i.files, i.servicePath, i.sampleParams, i.maxPages, i.fallbackValue);
      compareRoutes(
        tally, 'changed', i, call(legacyLocale), call(legacyU16), () => legacyAll.routesFromChangedFiles(i.files, i.servicePath, i.sampleParams, 1e9, i.fallbackValue),
        () => routesFromChangedFiles(i.files, i.servicePath, i.sampleParams, i.maxPages, i.fallbackValue), i.maxPages, false,
      );
    });
    expect(total.first.join('\n---\n')).toBe('');
    expect(total.strictDiff).toBe(0);
    expect(total.vanishOld).toBe(0);
    expect(total.vanishNew).toBe(0);
    // 대소문자·악센트가 섞인 이름은 localeCompare와 UTF-16 순서가 실제로 다르게 정렬한다
    expect(total.textDiff).toBeGreaterThan(total.runs * 0.005);
    expect(total.capped).toBeGreaterThan(total.runs * 0.15);
    expect(total.limitNaN).toBeGreaterThan(0);
  });

  it('routesFromCandidates', () => {
    const total = runRoutes('routesFromCandidates', (rng, tally) => {
      const i = candidatesInput(rng);
      const weird = i.candidates.some((c) => {
        const d = (c as { distance?: number }).distance;
        const t = (c as { tie?: number | null }).tie;
        return d === undefined || !Number.isFinite(d) || (typeof t === 'number' && Number.isNaN(t));
      });
      const call = (impl: { routesFromCandidates: typeof legacyU16.routesFromCandidates }) => (): NextRoutes =>
        impl.routesFromCandidates(i.candidates, i.servicePath, i.sampleParams, i.maxPages, i.fallbackValue);
      compareRoutes(
        tally, 'candidates', i, call(legacyLocale), call(legacyU16), () => legacyAll.routesFromCandidates(i.candidates, i.servicePath, i.sampleParams, 1e9, i.fallbackValue),
        () => routesFromCandidates(i.candidates, i.servicePath, i.sampleParams, i.maxPages, i.fallbackValue), i.maxPages, weird,
      );
    });
    expect(total.first.join('\n---\n')).toBe('');
    expect(total.strictDiff).toBe(0);
    expect(total.vanishOld).toBe(0);
    expect(total.vanishNew).toBe(0);
    expect(total.capped).toBeGreaterThan(total.runs * 0.15);
    expect(total.limitNaN).toBeGreaterThan(0);
  });

  it('대조 장치(경로): 상한·정렬 비교·글자 하나만 달라도 잡는다', () => {
    const rng = mulberry32(9);
    let limitCaught = 0;
    let orderCaught = 0;
    let runs = 0;
    const brokenLimit = makeLegacyRoutes(utf16, AUTO_PAGE_MAX + 1);
    const brokenOrder = makeLegacyRoutes((a, b) => utf16(b, a), AUTO_PAGE_MAX);
    for (let n = 0; n < 600; n++) {
      const i = changedFilesInput(rng);
      const good = outcome(() => routesFromChangedFiles(i.files, i.servicePath, i.sampleParams, 20, i.fallbackValue));
      runs++;
      // (1) 상한을 하나 늘린 옛 구현
      if (outcome(() => brokenLimit.routesFromChangedFiles(i.files, i.servicePath, i.sampleParams, 20, i.fallbackValue)) !== good) limitCaught++;
      // (2) 정렬을 뒤집은 옛 구현
      if (outcome(() => brokenOrder.routesFromChangedFiles(i.files, i.servicePath, i.sampleParams, 20, i.fallbackValue)) !== good) orderCaught++;
    }
    expect(limitCaught).toBeGreaterThan(20);
    expect(orderCaught).toBeGreaterThan(50);
    expect(runs).toBe(600);
  });
});

// ── project-status 입력 ──────────────────────────────────────────────────

const STATUSES = ['미착수', '작업 중', '검증됨', '검증됨', '재확인 필요', '실패', '5', '10', '1', 'abc', '', '검증됨 '];
const TEXTS = ['', ' ', '  요청 요약 ', '요약\n두 줄', 'a'.repeat(5), ' 　x﻿', 'é한글', '\t'];

function statusInput(rng: Rng): ProjectStatusInput {
  const input: Record<string, unknown> = {
    projectName: pick(rng, ['p', '프로젝트']),
    running: chance(rng, 0.45),
    requirements: Array.from({ length: chance(rng, 0.15) ? 0 : between(rng, 1, 9) }, (_v, n) => {
      const requirement: Record<string, unknown> = {
        id: chance(rng, 0.97) ? `R${n + 1}` : (pick(rng, [7, null]) as unknown),
        title: pick(rng, ['로그인', 'Cart', 'a, b', '제목 [x]', '']),
        priority: pick(rng, ['must', 'must', 'should', 'could', 'docs']),
        status: pick(rng, STATUSES),
      };
      const issueRoll = rng();
      if (issueRoll < 0.3) requirement['issue'] = between(rng, 1, 999);
      else if (issueRoll < 0.35) requirement['issue'] = null;
      else if (issueRoll < 0.37) requirement['issue'] = NaN;
      return requirement;
    }),
    manualSteps: Array.from({ length: chance(rng, 0.5) ? 0 : between(rng, 1, 4) }, () => pick(rng, ['npm 배포', 'DNS', ''])),
    checkpoints: Array.from({ length: chance(rng, 0.4) ? 0 : between(rng, 1, 3) }, (_v, n) => ({
      shortSha: `abc${n}`, message: pick(rng, ['m', '한글']), createdAt: '2026-01-01', ...(chance(rng, 0.2) ? { extra: { b: 1, a: [1, null] }, '2': 1, '1': 2 } : {}),
    })),
    failedServices: Array.from({ length: chance(rng, 0.7) ? 0 : between(rng, 1, 3) }, () => pick(rng, ['api', 'web', 'db'])),
    links: chance(rng, 0.95) ? { roadmap: 'r', changelog: 'c', docsIndex: 'd' } : { docsIndex: 'd', roadmap: 'r', '2': 'x', changelog: 'c', '1': 'y' },
  };
  if (chance(rng, 0.5)) input['currentRequestSummary'] = pick(rng, TEXTS);
  if (chance(rng, 0.35)) input['lanes'] = Array.from({ length: between(rng, 0, 3) }, (_v, n) => ({ id: `L${n}`, label: pick(rng, ['백엔드', 'fe']), status: pick(rng, ['대기', '진행 중', '완료']) }));
  if (chance(rng, 0.3)) input['openQuestion'] = pick(rng, ['', '어느 DB?', ' ']);
  if (chance(rng, 0.4)) input['pullRequestUrl'] = pick(rng, ['', 'https://x/1']);
  if (chance(rng, 0.55)) input['reviewState'] = { state: pick(rng, ['running', 'passed', 'capped', 'capped', 'stopped', 'resolved']), rounds: pick(rng, [0, 1, 3, 5, NaN, Infinity, 2.5]) };
  if (chance(rng, 0.1)) input['reviewState'] = null;
  if (chance(rng, 0.65)) {
    input['estimates'] = Array.from({ length: between(rng, 0, 4) }, (_v, n) => {
      const estimate: Record<string, unknown> = { id: `T${n}`, label: pick(rng, ['빌드', '테스트']) };
      const e = rng();
      if (e < 0.55) estimate['estimateMinutes'] = pick(rng, [0, 5, 30, 2.5, 0.1, 0.2, 1e21, NaN, Infinity, -3]);
      else if (e < 0.62) estimate['estimateMinutes'] = null;
      const a = rng();
      if (a < 0.55) estimate['actualMinutes'] = pick(rng, [0, 7, 30, 12.5, 0.3, NaN, -1]);
      else if (a < 0.62) estimate['actualMinutes'] = null;
      if (chance(rng, 0.4)) estimate['note'] = pick(rng, ['', '지연', '한글 메모']);
      return estimate;
    });
  }
  return input as unknown as ProjectStatusInput;
}

describe('차등 시험(3h): 현황 집계', () => {
  it('buildProjectStatus', () => {
    const dist = { runs: 0, differ: 0, running: 0, lanes: 0, hasEstimate: 0, risks: new Map<string, number>(), verified: new Map<string, number>(), statusKeys: new Map<string, number>(), first: [] as string[] };
    for (const seed of SEEDS) {
      const rng = mulberry32(seed * 1000 + 17);
      for (let n = 0; n < ITERATIONS; n++) {
        const input = statusInput(rng);
        const expected = outcome(() => legacyStatus.buildProjectStatus(input));
        const got = outcome(() => buildProjectStatus(input));
        dist.runs++;
        if (expected !== got) {
          dist.differ++;
          if (dist.first.length < 3) dist.first.push(`${JSON.stringify(input)}\n  옛=${expected}\n  새=${got}`);
          continue;
        }
        const view = legacyStatus.buildProjectStatus(input);
        if (input.running) dist.running++;
        if (view.eta.hasEstimate) dist.hasEstimate++;
        if ((input.lanes ?? []).length > 0) dist.lanes++;
        hist(dist.risks, String(view.risks.items.length));
        hist(dist.verified, view.verification.summary.replace(/^\d+개 중 (\d+)개.*$/, '검증 $1').replace('저장된 요구사항이 없어 검증 기록을 집계할 수 없습니다', '없음'));
        hist(dist.statusKeys, String(Object.keys(view.verification.byStatus).length));
      }
    }
    if (REPORT) {
      console.log(
        `[차등] buildProjectStatus: 비교 ${dist.runs}, 다름 ${dist.differ}, 처리 중 ${((dist.running / dist.runs) * 100).toFixed(0)}%, 레인 있음 ${((dist.lanes / dist.runs) * 100).toFixed(0)}%, 예상 있음 ${((dist.hasEstimate / dist.runs) * 100).toFixed(0)}%`,
      );
      console.log(`[분포] 위험 항목 수 ${show(dist.risks)} | 검증 ${show(dist.verified)} | 상태 종류 수 ${show(dist.statusKeys)}`);
    }
    expect(dist.first.join('\n---\n')).toBe('');
    expect(dist.differ).toBe(0);
    expect(dist.running).toBeGreaterThan(dist.runs * 0.3);
    expect(dist.running).toBeLessThan(dist.runs * 0.6);
    expect(dist.hasEstimate).toBeGreaterThan(dist.runs * 0.2);
    expect(dist.risks.size).toBeGreaterThanOrEqual(4);
  });

  it('대조 장치(현황): 키 순서·숫자 하나만 달라도 잡는다', () => {
    const rng = mulberry32(3);
    let reorder = 0;
    let digit = 0;
    for (let n = 0; n < 300; n++) {
      const input = statusInput(rng);
      const good = outcome(() => buildProjectStatus(input));
      if (good.replace('"eta":', '"zeta":') !== good) reorder++;
      const moved = good.replace(/(\d+)개 중 (\d+)개 검증됨/, (_m, a: string, b: string) => `${a}개 중 ${Number(b) + 1}개 검증됨`);
      if (moved !== outcome(() => legacyStatus.buildProjectStatus(input))) digit++;
    }
    expect(reorder).toBeGreaterThan(100);
    expect(digit).toBeGreaterThan(50);
  });
});

// ── stuck-loading 입력 ───────────────────────────────────────────────────

const LOADING_LINES = [
  'Loading', 'loading...', 'LOADING', 'Loading data', 'loading   DATA...', 'Loadingdata', 'Please wait', 'please   wait...', 'Please wait....', 'One moment',
  'one moment please', 'One  Moment  Please...', 'Fetching', 'fetching data', 'Fetching   Data.', '불러오는 중', '불러오는중입니다', '데이터 불러오는 중입니다...', '데이터를불러오는 중',
  '로딩 중', '로딩중입니다', '로딩...', '로딩', '잠시만 기다려 주세요', '잠시만기다려주세요...', '잠시만 기다려 주십시오', '• Loading...', '· 로딩 중 ·', '••Please wait',
  ' Loading ', '　로딩 중﻿', 'LOADİNG', 'loaſing', 'ｌｏａｄｉｎｇ', 'Loading Dock 안내', 'Loading....', 'Loading data now', '로딩 중입니다!!', '불러오는 중입니다....', 'Please wait please',
];
const OTHER_LINES = ['안녕하세요', 'Dashboard', '주문 내역', 'Total: 3', '', ' ', '   ', '\t', '•', '··', '• • •', '잠시만', '로딩 완료', 'Loaded', 'wait', '©'];

function stuckText(rng: Rng): string {
  const mode = rng();
  const lines: string[] = [];
  const count = chance(rng, 0.08) ? 0 : between(rng, 1, 5);
  for (let n = 0; n < count; n++) {
    if (mode < 0.62) lines.push(pick(rng, LOADING_LINES));
    else if (mode < 0.8) lines.push(chance(rng, 0.7) ? pick(rng, LOADING_LINES) : pick(rng, OTHER_LINES));
    else lines.push(pick(rng, OTHER_LINES));
  }
  const sep = pick(rng, ['\n', '\n', '\r\n', '\n\n', '\n \n', ' ', '\r']);
  let text = lines.join(sep);
  if (chance(rng, 0.12)) text += '\n' + pick(rng, ['😀', 'x'.repeat(70), '가'.repeat(61), 'Loading' + '.'.repeat(3) + ' '.repeat(60)]);
  if (chance(rng, 0.1)) text = pick(rng, ['', ' '.repeat(80)]) + text;
  if (chance(rng, 0.07)) text = 'x'.repeat(between(rng, 55, 62)) + pick(rng, ['😀', '가', 'é', '😀😀']) + text;
  return text;
}

function evidenceOf(rng: Rng): StuckLoadingEvidence | undefined {
  const roll = rng();
  if (roll < 0.35) return undefined;
  const value = () => pick(rng, [0, 0, 0, 1, 2, 5, NaN, Infinity, -1, 0.5]);
  const e: Record<string, unknown> = { failedRequests: value(), consoleErrors: value(), pageErrors: value() };
  if (chance(rng, 0.1)) delete e[pick(rng, ['failedRequests', 'consoleErrors', 'pageErrors'])];
  if (chance(rng, 0.04)) e['pageErrors'] = null;
  return e as unknown as StuckLoadingEvidence;
}

describe('차등 시험(3h): 로딩 멈춤 판정', () => {
  it('detectStuckLoading', () => {
    const dist = { runs: 0, differ: 0, stuck: 0, emptyText: 0, emptyStuck: 0, loneSurrogate: 0, first: [] as string[] };
    for (const seed of SEEDS) {
      const rng = mulberry32(seed * 1000 + 31);
      for (let n = 0; n < ITERATIONS * 4; n++) {
        const text = stuckText(rng);
        const evidence = evidenceOf(rng);
        const expected = legacyStuck.detectStuckLoading(text, evidence);
        const got = detectStuckLoading(text, evidence);
        dist.runs++;
        // 의도한 차이가 아닌 것: 60번째 코드 단위가 서로게이트 쌍의 한가운데면 옛 TS는 짝 없는 서로게이트가 든 글자를 낸다(Rust는 U+FFFD)
        const lone = expected !== undefined && expected !== wellFormed(expected);
        if (lone) dist.loneSurrogate++;
        const normalizedExpected = expected === undefined ? undefined : wellFormed(expected);
        if (normalizedExpected !== got) {
          dist.differ++;
          if (dist.first.length < 3) dist.first.push(`${JSON.stringify(text)} ${JSON.stringify(evidence)}\n  옛=${JSON.stringify(expected)}\n  새=${JSON.stringify(got)}`);
        }
        if (expected !== undefined) dist.stuck++;
        if (text.trim() === '') {
          dist.emptyText++;
          if (expected !== undefined) dist.emptyStuck++;
        }
      }
    }
    if (REPORT) console.log(`[차등] detectStuckLoading: 비교 ${dist.runs}, 다름 ${dist.differ}, 멈춤 판정 참 ${dist.stuck}(${((dist.stuck / dist.runs) * 100).toFixed(1)}%) 거짓 ${dist.runs - dist.stuck}, 빈 글자 ${dist.emptyText} 중 참 ${dist.emptyStuck}, 서로게이트 절단 ${dist.loneSurrogate}`);
    expect(dist.first.join('\n---\n')).toBe('');
    expect(dist.differ).toBe(0);
    expect(dist.stuck).toBeGreaterThan(dist.runs * 0.2);
    expect(dist.stuck).toBeLessThan(dist.runs * 0.75);
    expect(dist.emptyStuck).toBeGreaterThan(0);
    expect(dist.emptyStuck).toBeLessThan(dist.emptyText);
  });

  it('대조 장치(멈춤): 판정이 뒤집히면 잡는다', () => {
    const rng = mulberry32(4);
    let flipped = 0;
    for (let n = 0; n < 400; n++) {
      const text = stuckText(rng);
      const evidence = evidenceOf(rng);
      const got = detectStuckLoading(text, evidence);
      const inverted = got === undefined ? '' : undefined;
      if (inverted !== legacyStuck.detectStuckLoading(text, evidence)) flipped++;
    }
    expect(flipped).toBeGreaterThan(300);
  });
});
