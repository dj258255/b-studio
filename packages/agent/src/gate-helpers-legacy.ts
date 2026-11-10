// 차등 시험의 기준: ADR-191 3단계 3r에서 Rust로 옮기기 전의 TS 구현을 그대로 복사한 것이다(gate.ts의 순수 보조 판정).
// 고치지 않는다. 시험(gate-helpers-differential.test.ts, gate-helpers-vectors.test.ts, surrogate-boundary.test.ts)만 불러 쓰고 제품 코드는 불러 쓰지 않는다.
// export만 덧붙였고(함수 본문은 그대로), 옮기지 않고 TS에 남긴 readJsonPath·withoutInRunValues는 여기에 없다.
import type { AutoPageChecks, ConcurrencyExpect, WorkflowPageCheck } from '@b-studio/spec';
import { SPEC_FILE } from '@b-studio/spec';
import type { ViewportTextFinding, ViewportTextReport } from './browser-check';
import type { CompareResult } from './visual-compare';
import type { WorkflowCheck } from './workflow';


/**
 * Next.js가 오류 화면을 대신 그릴 때 나오는 문구. 상태 코드가 200이어도 본문이 오류 화면이면 실패로 본다.
 * 자동으로 연 페이지에만 적용한다(선언한 pageChecks는 사람이 기대 문구를 적어 두므로 그대로 둔다).
 *  - "Application error: a server-side exception has occurred" — App Router가 서버 컴포넌트 예외를 만나면(프로덕션) 대신 그리는 화면
 *  - "Unhandled Runtime Error" — 클라이언트 예외를 Next.js 개발 오버레이가 보여 줄 때의 제목
 */
export const NEXT_ERROR_MARKERS = ['Application error: a server-side exception has occurred', 'Unhandled Runtime Error'] as const;
/** Next.js 기본 404 화면. 약속한 응답이 404가 아니면 실패로 본다(없는 라우트를 열어 본 셈이다) */
export const NEXT_NOT_FOUND_MARKER = 'This page could not be found';

/** 자동으로 연 페이지의 본문에서 찾은 오류 표지. 없으면 undefined */
export function nextErrorMarker(text: string, expectStatus: number): string | undefined {
  const found = NEXT_ERROR_MARKERS.find((marker) => text.includes(marker));
  if (found) return found;
  if (expectStatus !== 404 && text.includes(NEXT_NOT_FOUND_MARKER)) return NEXT_NOT_FOUND_MARKER;
  return undefined;
}

/**
 * `workflow.autoPageChecks` 설정을 선언형 pageChecks와 같은 모양으로 바꾼다.
 * 같은 `#checkPage` 경로로 돌리기 위한 것이라, 설정에 없는 값은 pageChecks의 기본값과 같게 둔다.
 */
export function autoPageCheck(config: AutoPageChecks, routePath: string): WorkflowPageCheck {
  return {
    service: config.service,
    path: routePath,
    mode: config.mode,
    expectStatus: config.expectStatus,
    allowConsoleErrors: false,
    noHorizontalScroll: false,
    ...(config.viewport ? { viewport: config.viewport } : {}),
  };
}

export function formatFailedChecks(checks: readonly WorkflowCheck[]): string {
  if (checks.length === 0) return '';
  const lines = checks.map((check) => `- [${check.stage}] ${check.name} (시도 ${check.attempts}회)${check.detail ? `\n${check.detail}` : ''}`);
  return `\n\n워크플로 검사 실패:\n${lines.join('\n')}`;
}

/** 디자인 비교 실패 문구. 비율과 허용치, 비교한 크기를 함께 적는다 */
export function compareDetail(comparison: CompareResult, max: number): string {
  return `디자인 차이 ${(comparison.ratio * 100).toFixed(1)}% (허용 ${(max * 100).toFixed(1)}%, 비교 ${comparison.width}×${comparison.height})`;
}

/** 동시 요청 확인의 기대를 사람이 읽는 한 줄로. then 값은 따로 적으므로 여기 넣지 않는다 */
export function describeConcurrencyExpect(expect: ConcurrencyExpect): string {
  const parts: string[] = [];
  if (expect.successCount?.exactly !== undefined) parts.push(`정확히 ${expect.successCount.exactly}`);
  else if (expect.successCount?.atMost !== undefined) parts.push(`최대 ${expect.successCount.atMost}`);
  if (expect.allStatusIn) parts.push(`상태 ${expect.allStatusIn.join('/')}`);
  return parts.join(', ');
}

/** api에서 꺼낸 값. 화면 글자와 비교한다 */

export interface ApiValue {
  service: string;
  jsonPath: string;
  value: string | number;
}

/** api 값이 화면 글자에 있는지. 숫자는 원문과 천 단위 구분(12,000) 표기를 둘 다 인정한다 */
export function containsApiValue(text: string, value: string | number): boolean {
  if (typeof value === 'number') return text.includes(String(value)) || text.includes(value.toLocaleString('en-US'));
  return text.includes(value);
}

/** api 값이 화면에 없을 때의 문구. 화면이 다른 필드 이름을 읽고 있을 수 있음을 알린다 */
export function missingApiValue(api: ApiValue, pagePath: string): string {
  return `${api.service}의 ${api.jsonPath} 값 '${String(api.value)}'이 ${pagePath} 화면에 없습니다 — 화면이 다른 필드 이름을 읽고 있을 수 있습니다`;
}

/** expectInViewport 실패 한 건의 문구. 어느 글자가 어떻게 안 보이는지와 창 크기를 적는다 */
export function viewportProblemText(finding: ViewportTextFinding, width: number, height: number): string {
  const size = `(창 ${width}x${height})`;
  const problem = finding.problem;
  const head = `'${finding.text}'이 첫 화면에 다 보이지 않습니다 — `;
  if (!problem) return `${head}보이지 않는 이유를 알 수 없습니다${size}`;
  switch (problem.kind) {
    case 'absent':
      return `${head}화면에 없습니다${size}`;
    case 'hidden':
      return `${head}숨겨져 있습니다(display:none·visibility:hidden, 투명하거나 크기가 거의 없음)${size}`;
    case 'covered':
      return `${head}${problem.by}에 덮여 있습니다${size}`;
    case 'scrolled':
      return `${head}잴 때 창이 ${problem.px}px 스크롤돼 있어 첫 화면이 아닙니다. 화면을 내리는 steps 없이 재세요${size}`;
    case 'clipped': {
      const side = { bottom: '아래로', top: '위로', right: '오른쪽으로', left: '왼쪽으로' }[problem.side];
      return `${head}${problem.by} 안에서 ${side} ${problem.px}px 잘렸습니다${size}`;
    }
    case 'below':
      return `${head}창 아래로 ${problem.px}px 넘칩니다${size}`;
    case 'above':
      return `${head}창 위로 ${problem.px}px 넘칩니다${size}`;
    case 'right':
      return `${head}창 오른쪽으로 ${problem.px}px 넘칩니다${size}`;
    case 'left':
      return `${head}창 왼쪽으로 ${problem.px}px 넘칩니다${size}`;
  }
}

/** expectInViewport 판정. 러너가 재지 못했거나 일부 글자의 결과가 빠졌으면 통과로 보지 않는다 */
export function viewportProblems(expected: readonly string[], report: ViewportTextReport | undefined): string[] {
  if (!report) return [`${expected.map((value) => `'${value}'`).join(', ')}가 첫 화면에 보이는지 재지 못했습니다`];
  return expected.flatMap((text) => {
    const finding = report.findings.find((entry) => entry.text === text);
    if (!finding) return [`'${text}'이 첫 화면에 보이는지 재지 못했습니다`];
    return finding.visible ? [] : [viewportProblemText(finding, report.width, report.height)];
  });
}

/** expectAllText 실패 문구. 빠진 문구만 적는다 */
export function missingAllText(values: readonly string[]): string {
  return `화면에 ${values.map((value) => `'${value}'`).join(', ')}가 없습니다`;
}

/** expectAnyText 실패 문구. 적은 문구 중 어느 것도 없을 때 */
export function missingAnyText(values: readonly string[]): string {
  return `화면에 ${values.map((value) => `'${value}'`).join(', ')} 중 어느 것도 없습니다`;
}

/** 추정한 id로 연 동적 경로가 404·500을 돌려줬을 때의 문구(ADR-078). id가 실제로 없을 수도 있다는 것과 고치는 방법을 함께 적는다 */
/** 추정한 id로 연 화면이 상태 코드가 아닌 이유(실패한 요청, 멈춘 로딩 등)로 실패했을 때 붙이는 안내 */
export function dynamicProbeDataHint(probedId: string): string {
  return `이 화면은 추정한 id(${probedId})로 열었습니다 — 그 id의 데이터가 없어서 생긴 실패일 수 있습니다. 실제로 있는 값을 studio.yaml의 autoPageChecks.sampleParams(예: { id: "..." })나 sampleIdFrom으로 알려주면 그 값으로 엽니다`;
}

/** sampleParams로 알려 준 값으로 연 화면의 `이름=값` 목록. 동적 세그먼트가 없거나 쓴 값이 없으면 undefined */

/** 실행 중에 다시 읽은 설정에서 받아들인 sample 값 */
export interface LatestSampleValues {
  config: AutoPageChecks;
  notes: string[];
  /** 이번 실행 중에 새로 받아들인 sampleParams의 키 */
  inRunKeys: Set<string>;
  /** 이번 실행 중에 새 sampleIdFrom을 받아들였는지(추정 id가 그 값에서 온다) */
  inRunSampleIdFrom: boolean;
}


/** page 파일 경로의 단순 동적 세그먼트 `[id]` 이름들. next-routes.ts가 경로를 만들 때와 같은 규칙(폴더 이름 전체가 `[이름]`)으로 뽑는다 */
export function dynamicNames(pageFile: string): string[] {
  return pageFile
    .split('/')
    .map((segment) => /^\[([^[\]]+)\]$/.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** 실행 중에 받아들였다가 고정 경로와 겹쳐 되돌리는 값 */
export interface ShadowedValue {
  name: string;
  value: string;
  viaSampleIdFrom: boolean;
  reason: string;
}

/** 받아들인 값을 알리는 문구. 되돌린 값이 빠진 마지막 상태에서 만든다 */
export function acceptedNotes(latest: LatestSampleValues): string[] {
  const notes: string[] = [];
  const params = [...latest.inRunKeys].map((key) => `${key}=${latest.config.sampleParams?.[key]}`);
  if (params.length > 0) notes.push(`${SPEC_FILE}의 autoPageChecks.sampleParams(${params.join(', ')})를 이번 실행에서 바로 반영했습니다`);
  const from = latest.config.sampleIdFrom;
  if (latest.inRunSampleIdFrom && from) notes.push(`${SPEC_FILE}의 autoPageChecks.sampleIdFrom(${from.service} ${from.path})을 이번 실행에서 바로 반영했습니다`);
  return notes;
}


export function usesInRunValue(route: { file: string; usedFallbackParams?: readonly string[] }, latest: LatestSampleValues): boolean {
  if (dynamicNames(route.file).some((name) => latest.inRunKeys.has(name))) return true;
  return latest.inRunSampleIdFrom && (route.usedFallbackParams?.length ?? 0) > 0;
}

export function sampledValues(pageFile: string, sampleParams: Readonly<Record<string, string>> | undefined): string | undefined {
  const names = [...pageFile.matchAll(/\[(?:\.\.\.)?([A-Za-z0-9_-]+)\]/g)].map((match) => match[1]!);
  const used = names.filter((name) => sampleParams?.[name]);
  return used.length > 0 ? used.map((name) => `${name}=${sampleParams![name]}`).join(', ') : undefined;
}


/** HTTP 확인 응답 본문(HTML)에서 태그를 걷어내 로딩 문구 판정에 쓸 평문을 만든다. 자바스크립트는 실행하지 않는다 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
