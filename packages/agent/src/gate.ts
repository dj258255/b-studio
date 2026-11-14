import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeNative, encodeLoneSurrogates, encodeNative, native, type Sandbox, type StartOptions } from '@b-studio/sandbox';
import { loadProject, SPEC_FILE, SpecError, type AutoPageChecks, type ConcurrencyExpect, type LoadedProject, type WorkflowPageCheck, type WorkflowPageCompare, type WorkflowSpec, type WorkflowStage } from '@b-studio/spec';
import { BrowserUnavailableError, runInBrowser, StepFailedError, type BrowserFrame, type BrowserPageResult, type BrowserPageStep, type BrowserRunner, type ViewportTextFinding, type ViewportTextReport } from './browser-check';
import { ChangeTracker, rejectedChangeFeedback, type Fingerprinter } from './change-tracker';
import { browserPageEvidence, finishEvidence, httpPageEvidence, type PageEvidenceContext } from './check-evidence';
import { DECLARED_CHECKS_CHECK, describeDeclaredCheckChange, diffDeclaredChecks, hasDeclaredCheckChange, weakenedDeclarations, withDeclaredChecks } from './declared-checks';
import type { AgentEvent } from './loop';
import { servicesForFiles } from './services';
import { detectStuckLoading } from './stuck-loading';
import { GATE_HOST, runGateCheck, type GateHost } from './gate-check';
import { captureBaselines, serviceUrl, type ContractFetcher, type VerificationReport } from './verify';
import { missingVerificationStages, protectedPathsFor, reviewChanges, type WorkflowCheck, type WorkflowCompare, type WorkflowStepCheck } from './workflow';
import type { OpenApiDocument } from './contract-diff';
import { compareScreenshot, VisualCompareError, type CompareResult } from './visual-compare';
import { MANUAL_VERIFICATION_CHECK, reviewRequirementRecords } from './requirement-integrity';
import { REQUIREMENTS_FILE } from './requirements';
import { readProjectFileSync, readRegularFileBytesSync, type Workspace } from './workspace';

export type GateOutcome =
  | { kind: 'pass' }
  /** 모델에게 돌려줄 게이트 결과. 고친 뒤 다시 턴을 끝내게 한다 */
  | { kind: 'retry'; feedback: string }
  | { kind: 'exhausted'; summary: string };

/** recheckGateOnMaxTurns의 결과. pass면 summary를 'done' 요약으로, 아니면 'failed' 요약으로 쓴다 */
export interface MaxTurnsRecheck {
  pass: boolean;
  summary: string;
}

/**
 * 턴 상한에 걸렸을 때 바로 실패로 끝내지 않고, 지금까지의 변경이 검증 게이트를 통과하는지 한 번 더 확인한다(ADR-131).
 * 턴 상한에 걸린 시점은 모델이 마지막 도구 호출 뒤 자기 입으로 "끝났다"고 말할 기회를 얻지 못했을 수 있어,
 * 실제로는 요청이 끝나 있을 수도 있다 — 되돌리기 전에 한 번은 플랫폼이 직접 확인한다.
 * 게이트가 없으면(질문 모드·지연 기동이 아직 아무것도 바꾸지 않은 세션) 확인할 것이 없어 바로 실패로 본다.
 * 통과(pass)든 실패든 다른 실패 사유(오류·중지)와 달리 재시도 횟수를 넘겼는지는 따지지 않는다 —
 * 어차피 턴이 남지 않아 모델에게 피드백을 돌려줄 수 없으므로, pass가 아니면 모두 실패로 끝낸다.
 */
export async function recheckGateOnMaxTurns(gate: VerificationGate | undefined, maxTurns: number, onEvent: (event: AgentEvent) => void): Promise<MaxTurnsRecheck> {
  const limitMessage = `최대 턴 수(${maxTurns})를 넘었습니다`;
  if (!gate) return { pass: false, summary: limitMessage };
  const outcome = await gate.check();
  if (outcome.kind !== 'pass') return { pass: false, summary: limitMessage };
  gate.passedAtTurnLimit = true;
  if (gate.verified) onEvent({ type: 'stage', stage: 'checkpoint', source: 'platform' });
  return { pass: true, summary: `${limitMessage}. 다만 지금까지의 변경이 검증 게이트를 통과해 체크포인트로 남깁니다(요청의 일부만 끝났을 수 있습니다).` };
}

/**
 * 검증 범위. full은 지금과 같고, light(가볍게 확인)는 서비스 재시작·준비 판정·계약만 돌린다.
 * 작은 변경에서 빠른 피드백을 받으려는 것이라, 건너뛴 단계는 배포 조건(releaseRequires)이 자연히 막는다.
 */
export type VerifyMode = 'full' | 'light';

/** browser_check에서 화면 경로를 불러오는 함수. 테스트에서 네트워크 없이 바꿔 끼운다 */
export type PageFetcher = (url: string, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

const PAGE_TIMEOUT_MS = 30_000;
/** 샌드박스·도커 쪽 실패 뒤 한 번 다시 해 보기 전에 기다리는 시간 */
const PLATFORM_RETRY_DELAY_MS = 1_500;
/** 테스트 하나가 기다릴 시간. 시간 상한은 선언한 검사 실행의 `declaredExec` 콜백(`gate-check.ts`)이 이 값으로 신호를 연다 */
export const TEST_TIMEOUT_MS = 10 * 60_000;
/** 동시 요청 확인에서 요청 하나가 기다릴 시간 */
const REQUEST_TIMEOUT_MS = 15_000;
/** 같은 값이 Rust(`gate_declared.rs`의 `CHECK_CONCURRENCY`·`OUTPUT_TAIL_LINES`)에 있다. 이 TS 쪽은 옛 구현(`declared-legacy.ts`)이 쓴다 */
export const CHECK_CONCURRENCY = 2;
export const OUTPUT_TAIL_LINES = 30;
/** 평가 자산 지문이 담을 수 있는 파일 수 상한. 넘으면 실패하고 선언을 좁히라고 알린다 */
const MAX_EVALUATION_ASSET_FILES = 2_000;
/** 평가 자산이 바뀌었을 때 사유에 나열할 파일 수 상한 */
const MAX_EVALUATION_ASSET_LIST = 20;
/** 검사하는 동안 바뀐 도구 밖 파일을 사유에 나열할 수 상한 */
const MAX_OUTSIDE_CHANGE_LIST = 20;

/**
 * Next.js가 오류 화면을 대신 그릴 때 나오는 문구. 상태 코드가 200이어도 본문이 오류 화면이면 실패로 본다.
 * 자동으로 연 페이지에만 적용한다(선언한 pageChecks는 사람이 기대 문구를 적어 두므로 그대로 둔다).
 *  - "Application error: a server-side exception has occurred" — App Router가 서버 컴포넌트 예외를 만나면(프로덕션) 대신 그리는 화면
 *  - "Unhandled Runtime Error" — 클라이언트 예외를 Next.js 개발 오버레이가 보여 줄 때의 제목
 */
export const NEXT_ERROR_MARKERS = ['Application error: a server-side exception has occurred', 'Unhandled Runtime Error'] as const;
/** Next.js 기본 404 화면. 약속한 응답이 404가 아니면 실패로 본다(없는 라우트를 열어 본 셈이다) */
export const NEXT_NOT_FOUND_MARKER = 'This page could not be found';

/**
 * 자동으로 연 페이지의 본문에서 찾은 오류 표지. 없으면 undefined. 판정은 Rust가 한다(ADR-191 3r). 위 두 상수는 그 목록의 사본이고 시험이 같은지 본다.
 * 표지는 모두 ASCII라 본문의 짝 없는 서로게이트가 경계에서 U+FFFD가 되어도 "표시 있음"이 "없음"으로 바뀌지 않는다(성질 시험: surrogate-boundary.test.ts)
 */
export function nextErrorMarker(text: string, expectStatus: number): string | undefined {
  return native.gateNextErrorMarker(text, expectStatus) ?? undefined;
}

/**
 * `workflow.autoPageChecks` 설정을 선언형 pageChecks와 같은 모양으로 바꾼다.
 * 같은 `#checkPage` 경로로 돌리기 위한 것이라, 설정에 없는 값은 pageChecks의 기본값과 같게 둔다.
 */
export function autoPageCheck(config: AutoPageChecks, routePath: string): WorkflowPageCheck {
  return decodeNative<WorkflowPageCheck>(native.gateAutoPageCheck(encodeNative({ service: config.service, mode: config.mode, expectStatus: config.expectStatus, viewport: config.viewport }), routePath));
}

export const fetchPage: PageFetcher = async (url, signal) => {
  const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  const response = await fetch(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  return { status: response.status, text: await response.text() };
};

/** 게이트가 세션 서비스에 직접 보내는 요청. 동시 요청 확인에서 테스트가 네트워크 없이 바꿔 끼운다 */
export type ServiceRequest = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text: string }>;

export const requestService: ServiceRequest = async (url, init) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    method: init.method,
    ...(init.headers ? { headers: init.headers } : {}),
    // GET·HEAD에는 본문을 보낼 수 없다
    ...(init.body !== undefined && init.method !== 'GET' ? { body: init.body } : {}),
    redirect: 'manual',
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  return { status: response.status, text: await response.text() };
};

export interface GateOptions {
  project: LoadedProject;
  sandbox: Sandbox;
  workspace: Workspace;
  allowBreaking: boolean;
  maxVerifyAttempts: number;
  /** 샌드박스·도커 쪽 실패 뒤 다시 해 보기 전에 기다리는 시간(테스트에서 줄인다) */
  platformRetryDelayMs?: number;
  /** 검증 범위(기본 full). light면 재시작·준비 판정·계약만 돌리고 나머지 단계는 건너뛴다 */
  verify?: VerifyMode;
  /**
   * 사용자가 이 요청에서 확인 선언(tests·pageChecks·concurrencyChecks·loadChecks·autoPageChecks·required)의 변경을 허용했다(ADR-164).
   * 켜면 검증할 때 studio.yaml을 다시 읽어 바뀐 선언으로 돌리고, 무엇이 바뀌었는지 리뷰 단계에 남긴다.
   * 끄면(기본) 실행을 시작할 때의 선언으로 돈다. 사람이 보낸 요청의 옵션으로만 켠다 — 에이전트가 켤 방법은 없다
   */
  allowCheckChanges?: boolean;
  fetcher: ContractFetcher;
  pageFetcher?: PageFetcher;
  browserRunner?: BrowserRunner;
  signal?: AbortSignal;
  onServiceStatus?: StartOptions['onStatus'];
  onEvent: (event: AgentEvent) => void;
  /**
   * 화면 확인 중 찍은 스크린샷(PNG/JPEG)을 저장하고 식별자를 돌려준다. 저장 위치는 호출자가 정한다(agent는 모른다).
   * 넘기면 browser 모드 화면 확인이 capture를 켜고 단계 스크린샷을 WorkflowCheck.steps에 남긴다
   */
  saveArtifact?: (input: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }) => Promise<string>;
  /** 화면 확인 중 받은 실시간 프레임. 미리보기 중계에 쓴다 */
  onBrowserFrame?: (input: { check: string; frame: BrowserFrame }) => void;
  /** 동시 요청 확인이 세션 서비스에 보내는 요청. 넘기지 않으면 실제 fetch를 쓴다 */
  requestService?: ServiceRequest;
  /**
   * 자동 화면 확인의 sample 값(sampleParams·sampleIdFrom)만 같은 실행에서 반영하려고 디스크의 studio.yaml을 다시 읽는 함수(ADR-159).
   * 넘기지 않으면 이번 실행에서 studio.yaml이 바뀐 때만 `loadProject(project.root)`로 읽는다. 넘기면 자동 화면 확인을 계산할 때마다 부른다
   * (테스트가 디스크 없이 바꿔 끼운다). 읽은 설정에서 sample 값 두 개 말고는 쓰지 않는다.
   * 확인 선언의 변경·약화 판정에는 쓰지 않는다 — 그쪽은 언제나 디스크의 파일을 일반 파일 확인과 함께 읽는다(#767)
   */
  reloadProject?: () => Promise<LoadedProject>;
  /**
   * 실행을 시작할 때 **파일에 적힌** workflow(완료 검사 덧입힘 없음). 카드 맥락처럼 `project.spec.workflow`에 완료 검사를
   * 덧입힌 경우, 변경 요약과 약화 판정의 시작 값으로 이 값을 쓴다. 주지 않으면 `project.spec.workflow`를 쓴다
   */
  declarationBaseline?: WorkflowSpec | undefined;
  /**
   * b-studio 도구를 거치지 않고 바뀐 파일(CLI 내장 도구·서비스 안 명령 등). 주면 게이트가 만들 때 한 번,
   * 그리고 check()마다 바뀐 파일 수를 보기 전에 이 목록을 작업 공간에 옮긴다. 게이트가 다룰 수 없는 경로(링크·비밀 파일 등)가
   * 바뀌었으면 검증하지 않고 실패한다. 주지 않으면 지금과 같이 도구가 기록한 변경만 본다
   */
  outsideChanges?: {
    pendingFiles: () => Promise<readonly string[]>;
    fingerprint?: Fingerprinter;
  };
  /**
   * 에이전트 실행 없이 지금 작업 복사본을 처음부터 다시 확인한다(세션의 "다시 검증", #798·ADR-181). 바뀐 파일이 없어도
   * 검증을 건너뛰지 않고, studio.yaml이 바뀐 것처럼 관리 서비스를 모두 다시 띄운 뒤 선언한 확인을 모두 돌린다.
   * 변경 리뷰(보호 경로·변경 크기)는 이번에 바뀐 파일이 없으므로 빈 목록으로 돈다. 호출자는 작업 복사본이 확인할
   * 체크포인트와 같은지 앞뒤로 견줘야 한다 — 게이트는 디스크에 있는 것을 확인할 뿐이다
   */
  recheck?: true;
}

/**
 * 모델이 턴을 끝낼 때마다 도는 검증 게이트.
 * 모델 호출 방식(직접 만든 루프, 로컬 Claude Code)과 무관하게 같은 규칙으로 완료를 판정하도록 루프에서 분리했다.
 * 순서: 재시작·준비 판정·계약 비교 → (선언했다면) 화면 확인·테스트를 병렬로 → 변경 리뷰 → 필수 단계 대조
 */
export class VerificationGate {
  attempts = 0;
  /** 마지막 검증이 샌드박스·도커 쪽 문제로 끝나지 못했으면 그 사유. 재시도 횟수(attempts)에는 세지 않는다 */
  platformFailure: string | undefined;
  /** 마지막 검증 결과 */
  report: VerificationReport | undefined;
  /** 마지막 검증에서 플랫폼이 실행한 화면 확인·테스트·리뷰 결과 */
  checks: WorkflowCheck[] = [];
  /** 마지막 검증에서 통과한 검증 단계 */
  passedStages = new Set<WorkflowStage>();
  /** light에서 건너뛴 필수 검증 단계. workflow.required 대조에서 실패로 보지 않는다(full에서는 빈 배열) */
  skippedStages: WorkflowStage[] = [];
  /** 바뀐 파일을 실제로 검증해 통과했는지. 바뀐 파일이 없어 검증 없이 끝났다면 false라서 체크포인트 단계로 넘어가지 않는다 */
  verified = false;
  /**
   * 가장 최근 check()의 결과. 한 번도 돌지 않았으면 없다. verified는 한 번 통과하면 켜진 채로 남으므로, 그 뒤의 검증이
   * 실패했는지는 이 값으로 본다(질문으로 끝난 실행이 체크포인트를 남겨도 되는지 판정하는 데 쓴다)
   */
  lastOutcome: GateOutcome['kind'] | undefined;
  /**
   * 턴 상한에 닿은 뒤의 재검증(recheckGateOnMaxTurns)을 통과했다. 이때 남기는 체크포인트는 게이트는 통과했지만 모델이
   * 다음 도구를 부르려던 중에 끊긴 상태라, 실행 결과에 "하다 만 것"으로 표시한다(AgentResult.incomplete, ADR-131 덧붙임)
   */
  passedAtTurnLimit = false;
  readonly #options: GateOptions;
  readonly #baselines: ReadonlyMap<string, OpenApiDocument>;
  /** 게이트 재시도 상한. 기본은 생성 시 받은 값이고, 승격이 새 예산을 주면 커진다 */
  #maxAttempts: number;
  #verifiedVersion = 0;
  #failedServices = new Set<string>();
  /** 화면 확인 이름 → 단계 결과. 실패해 예외로 끝나도 실패 단계의 스크린샷을 남기려고 따로 모은다 */
  #pageSteps = new Map<string, WorkflowStepCheck[]>();
  /** 화면 확인 이름 → 디자인 비교 결과. 실패해 예외로 끝나도 결과를 남기려고 따로 모은다 */
  #pageCompares = new Map<string, WorkflowCompare>();
  /** 화면 확인 이름 → 허용 출처 밖이라 막은 요청. 앱의 오류가 아니라 경계에서 막은 것이라 실패로 세지 않고 기록만 한다 */
  #pageBlocked = new Map<string, string[]>();
  /** 화면 확인 이름 → 측정한 로드 시간(ms). 예산을 적은 확인만 재어 결과에 남긴다 */
  #pageLoadMs = new Map<string, number>();
  /** 화면 확인 이름 → 게이트를 막지 않는 참고 문구(ADR-078). HTTP 모드의 로딩 문구 경고처럼, 확정할 수 없지만 알려 둘 만한 것을 담는다 */
  #pageWarnings = new Map<string, string[]>();
  /** 이번 검증에 쓰는 프로젝트. 보통은 실행을 시작할 때의 것이고, 사용자가 선언 변경을 허용한 요청에서만 확인 선언이 지금 파일의 것으로 바뀐다 */
  #project: LoadedProject;
  /** 이번 실행에서 확인 선언이 바뀌었지만 허용되지 않아 쓰지 않은 변경의 요약. 실패 안내에 싣는다 */
  #unadoptedChange: string | undefined;
  /**
   * 실행을 시작할 때의 프로젝트가 선언한 평가 자산 목록. 게이트를 만들 때 고정한다 — 에이전트가 실행 중에 studio.yaml에서
   * 이 선언을 지우거나 줄여도 그 실행의 검사는 시작 때의 목록으로 돈다(ADR-175)
   */
  readonly #evaluationAssets: readonly string[];
  /** 실행을 시작할 때 뜬 평가 자산의 지문. 검사 때 다시 떠서 견주고, 읽을 수 없었으면 그 사유를 담는다 */
  readonly #evaluationAssetBaseline: EvaluationAssetBaseline;
  /** 도구 밖 변경을 작업 공간으로 옮기는 추적기. outsideChanges를 준 경우에만 있다 */
  readonly #outsideTracker: ChangeTracker | undefined;

  private constructor(
    options: GateOptions,
    baselines: ReadonlyMap<string, OpenApiDocument>,
    evaluationAssets: readonly string[],
    evaluationAssetBaseline: EvaluationAssetBaseline,
    outsideTracker: ChangeTracker | undefined,
  ) {
    this.#options = options;
    this.#project = options.project;
    this.#baselines = baselines;
    this.#maxAttempts = options.maxVerifyAttempts;
    this.#evaluationAssets = evaluationAssets;
    this.#evaluationAssetBaseline = evaluationAssetBaseline;
    this.#outsideTracker = outsideTracker;
  }

  /** 계약 비교 기준은 모델이 파일을 바꾸기 전에 잡아야 한다 */
  static async create(options: GateOptions): Promise<VerificationGate> {
    // 요구사항 문서의 실행 전 모습도 같은 이유로 여기서 고정한다(러너가 실행을 시작할 때 이미 불렀다면 그 값이 유지된다)
    options.workspace.snapshotRead(REQUIREMENTS_FILE);
    // 평가 자산의 선언과 지문도 같은 이유로 여기서 고정한다. 에이전트가 명령(run_in_service 등)으로 고친 것도 검사가 잡는다
    const evaluationAssets = options.project.spec.workflow?.evaluationAssets ?? [];
    // 도구 밖 변경의 기준을 여기서 잡는다. 이때 이미 바뀌어 있던 파일은 첫 check()에서 "이번에 바뀐 것"으로 다시 세지 않는다
    const outsideTracker = options.outsideChanges
      ? new ChangeTracker(options.workspace, options.outsideChanges.pendingFiles, {
          tolerateExisting: true,
          ...(options.outsideChanges.fingerprint ? { fingerprint: options.outsideChanges.fingerprint } : {}),
        })
      : undefined;
    if (outsideTracker) await outsideTracker.sync();
    // 보호 경로 파일은 이 실행에서 처음 쓰기 직전에 내용을 고정한다(Workspace.pinBeforeWrite, 이슈 #992). 고정하기 직전에 도구 밖 변경을 먼저 옮겨,
    // 셸이 먼저 고친 파일의 내용을 "실행 시작 때 내용"으로 고정하지 않게 한다. 게이트가 추적기를 갖지 않는 호출부(관문 러너·터미널)는 자기 추적기를 직접 정한다
    options.workspace.watchProtectedPaths(protectedPathsFor(options.project.spec.workflow));
    if (outsideTracker) options.workspace.useOutsideSync(() => outsideTracker.sync());
    const [baselines, evaluationAssetBaseline] = await Promise.all([
      captureBaselines(options.sandbox, options.project, options.fetcher),
      fingerprintEvaluationAssets(options.project.root, evaluationAssets),
    ]);
    return new VerificationGate(options, baselines, evaluationAssets, evaluationAssetBaseline, outsideTracker);
  }

  /**
   * 마지막 sync()가 게이트에 알린 도구 밖 변경의 지문(프로젝트 기준 경로 → 지문). outsideChanges를 준 경우에만 있다.
   * 호출자는 게이트를 통과한 실행의 결과에 실어, 체크포인트를 남기기 전에 스테이징될 내용이 검증한 내용과 같은지 견주는 데 쓴다
   */
  get verifiedFingerprints(): ReadonlyMap<string, string> | undefined {
    return this.#outsideTracker?.tracked;
  }

  /**
   * 요구사항 문서의 검증 기록(사람 확인·재확인 판정 필드)이 이번 실행에서 바뀌었는지 본다(ADR-157).
   * 바뀐 파일 목록이 아니라 디스크의 문서를 직접 견주므로 서비스 안 명령(run_in_service)이나 CLI 러너가 고친 것도 잡는다.
   * 단계와 무관하게 항상 돌린다(가볍게 확인에서도 건너뛰지 않는다) — 파일 하나를 읽고 견주는 것뿐이라 가볍다.
   */
  async #requirementRecordChecks(): Promise<WorkflowCheck[]> {
    const { workspace } = this.#options;
    const before = workspace.snapshotRead(REQUIREMENTS_FILE);
    const after = readProjectFileSync(workspace.root, REQUIREMENTS_FILE);
    // 문서 자리에 링크·FIFO·거대한 파일이 놓였으면 견줄 수 없다. "문서가 없다"로 넘기면 링크 너머의 내용이 나중에 읽혀
    // 검증됨을 만들 수 있으므로 통과시키지 않는다
    if (after.kind === 'irregular') {
      return [
        {
          stage: 'review',
          name: MANUAL_VERIFICATION_CHECK,
          ok: false,
          attempts: 1,
          detail: `${REQUIREMENTS_FILE}을(를) 읽을 수 없어 검증 기록을 견줄 수 없습니다: ${after.reason}. 일반 파일로 되돌리세요`,
        },
      ];
    }
    const beforeText = before.kind === 'text' ? before.content : undefined;
    const afterText = after.kind === 'text' ? after.content : undefined;
    if (beforeText === afterText) return [];
    return reviewRequirementRecords(beforeText, afterText);
  }

  /**
   * 평가 자산(테스트·채점 스크립트·기대값 파일)의 지문이 이번 실행에서 바뀌었는지 본다(ADR-175).
   * 바뀐 파일 목록이 아니라 디스크의 지문을 직접 견주므로 서비스 안 명령(run_in_service)이나 CLI 러너가 고친 것도 잡는다.
   * 선언은 게이트를 만들 때 고정한 목록이라, 에이전트가 실행 중에 studio.yaml에서 지워도 그 실행에는 계속 돈다.
   * 이 실행에 tests가 있으면 평가 자산이 바뀐 순간 그 테스트의 결과를 믿을 수 없으므로 test 단계를 실패시킨다.
   * tests가 없으면(평가 자산만 선언) 테스트를 돌리지 않았으므로 review 단계로 남긴다 — 통과해도 test 단계를 채우지 않는다.
   * 견줄 수 없으면(링크·특수 파일·상한 초과) 통과시키지 않는다. 단계와 무관하게 항상 돌린다.
   */
  async #evaluationAssetChecks(): Promise<WorkflowCheck[]> {
    const assets = this.#evaluationAssets;
    if (assets.length === 0) return [];
    const stage: WorkflowCheck['stage'] = this.#project.spec.workflow?.tests?.length ? 'test' : 'review';
    const baseline = this.#evaluationAssetBaseline;
    const current = await fingerprintEvaluationAssets(this.#options.project.root, assets);
    if (current.kind === 'error') return [evaluationAssetFailure(stage, current.detail)];
    if (baseline.kind === 'error') return [evaluationAssetFailure(stage, baseline.detail)];
    const changed = [...new Set([...baseline.digests.keys(), ...current.digests.keys()])]
      .filter((file) => baseline.digests.get(file) !== current.digests.get(file))
      .sort();
    if (changed.length === 0) return [{ stage, name: 'evaluation-assets', ok: true, attempts: 1 }];
    return [{ stage, name: 'evaluation-assets', ok: false, attempts: 1, detail: describeEvaluationAssetChange(changed) }];
  }

  /**
   * 선언한 검사(테스트)를 돌리는 동안 평가 자산이 바뀌었는지 다시 견준다(TOCTOU). 검사 전에만 견주면 검사가 도는 사이에 바뀐 것을
   * 놓친다(그 뒤의 통과 판정은 고친 자산을 근거로 삼는다). 검사 뒤 디스크의 지문을 다시 떠 기준과 견주고, 다르면 같은
   * evaluation-assets 실패로 결과를 바꾼다. 검사 전에 이미 실패했으면 그대로 둔다(바뀐 파일이 0개라 선언 검사를 건너뛰는
   * 경로에서는 지금처럼 한 번만 견준다).
   * 테스트가 도는 동안 잠깐 바꿨다가 되돌리는 경우는 이 견줌으로 막지 못한다. 컨테이너(서비스, 컨테이너 방식 터미널의 에이전트)에는
   * 평가 자산의 체크포인트 판을 읽기 전용으로 붙여 그 경로를 막는다(ADR-175 덧붙임, #745). 남은 한계: 이 컴퓨터 방식 터미널의
   * 호스트 셸에는 그 마운트가 없어 이 견줌만 남는다.
   */
  async #recheckEvaluationAssets(recordChecks: WorkflowCheck[]): Promise<void> {
    if (this.#evaluationAssets.length === 0) return;
    const index = recordChecks.findIndex((check) => check.name === 'evaluation-assets');
    if (index === -1 || !recordChecks[index]!.ok) return;
    recordChecks[index] = (await this.#evaluationAssetChecks())[0]!;
  }

  /**
   * 선언한 검사(테스트)를 돌리는 동안 도구 밖에서 파일이 바뀌었는지 다시 동기화한다(TOCTOU). 검사 전에만 동기화하면
   * 검사가 바뀐 내용으로 판정해 놓고 지문은 그 전 것을 내게 되어, 검증하지 않은 내용이 체크포인트로 갈 수 있다.
   * 바뀐 파일(또는 게이트가 다룰 수 없는 경로)이 있으면 outside-tool-changes 실패를 더한다. 검사 전에 이미 같은 실패가
   * 있으면 그대로 둔다.
   * 남은 한계: 검사가 도는 동안 바꿨다가 끝나기 전에 되돌리면 앞뒤 지문이 같아 잡지 못한다(#765).
   */
  async #recheckOutsideChanges(recordChecks: WorkflowCheck[]): Promise<void> {
    const elapsed = await this.#outsideTracker?.sync();
    if (!elapsed || (elapsed.changed.length === 0 && elapsed.rejected.length === 0)) return;
    if (recordChecks.some((check) => check.name === 'outside-tool-changes' && !check.ok)) return;
    const files = [...new Set([...elapsed.changed, ...elapsed.rejected])].sort();
    const shown = files.slice(0, MAX_OUTSIDE_CHANGE_LIST);
    const rest = files.length - shown.length;
    const detail =
      elapsed.changed.length > 0
        ? `검사하는 동안 파일이 바뀌었습니다: ${rest > 0 ? `${shown.join(', ')} 외 ${rest}개` : shown.join(', ')}. 테스트나 백그라운드 명령이 추적되는 파일을 고쳐 쓰지 않게 하세요(생성물이면 .gitignore에 넣으세요).`
        : rejectedChangeFeedback(elapsed.rejected);
    recordChecks.push({ stage: 'review', name: 'outside-tool-changes', ok: false, attempts: 1, detail });
  }

  /**
   * 승격이 새 재시도 예산을 줄 때 쓴다. 상한을 "지금까지 시도한 수 + 예산"으로 다시 잡으므로,
   * 남은 횟수에 더하는 게 아니라 그 모델에게 예산만큼의 기회를 새로 준다(E4에서 2번째 실패 뒤 승격하고도
   * 한 번밖에 남지 않았던 문제). 돌려주는 값은 이 호출로 다음 시도가 가능해졌는지다
   */
  grantRetryBudget(budget: number): boolean {
    const next = this.attempts + (Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0);
    if (next > this.#maxAttempts) this.#maxAttempts = next;
    return this.attempts < this.#maxAttempts;
  }

  /**
   * 모델이 턴을 끝낼 때마다 부른다. 마지막 결과를 lastOutcome에 남긴다 — 호출자가 결과를 받아 쓰지 않는 자리(질문을 남기고
   * 멈추기 전에 한 번 돌리는 검증)에서도 "마지막 검증이 통과했는가"를 나중에 물을 수 있어야 한다
   */
  async check(): Promise<GateOutcome> {
    // 검증이 도중에 던지면 앞 검증의 결과가 남아 "마지막 검증이 통과했다"로 읽히지 않게 먼저 비운다(열린 쪽으로 틀리지 않게)
    this.lastOutcome = undefined;
    const outcome = await this.#check();
    this.lastOutcome = outcome.kind;
    return outcome;
  }

  /**
   * check의 순서·분기·결과 조립은 Rust(`crates/bstudio-io/src/gate_check.rs`, ADR-195 4f A5b-1)가 한다: 기록 검사 모으기 → 바뀐 파일 0개 분기 → `run` 단계 → 남은 프로세스(#765) → 서비스 확인(플랫폼
   * 실패면 한 번 더) → `contract_check` 단계 → `verify_result` → 새 부가 서비스 경고 → 플랫폼 실패 `exhausted` → `light` 분기 또는 선언 검사 → 다시 견줌(TOCTOU) → 부하 플랫폼 실패 → 리뷰 → 단계별 통과 집계 →
   * 최종 판정과 `gate_done`(#1155) → 실패 안내(`#failure`) 글. 서비스 안 남은 프로세스 조회의 글 모양과 "확인하지 못하면 managed 전부 다시 띄우기"(#strayServices)도 Rust다.
   * 선언한 검사 실행(이름 짓기·작업 그래프·테스트·동시 요청·부하·결과 조립)도 Rust(`gate_declared.rs`, ADR-195 4f A5b-2)다. 화면 확인의 판정·순서·글 조립도 Rust(`gate_page.rs`, ADR-195 4f A5c-1)다. 자동으로 열 페이지를 고르는 일(실행 중 sample 값 받기·고정 경로 가림 확인·밀려난 화면 되살리기·import 따라가기·동적 기본값·선언과 겹침·이름·건너뜀 check)도 Rust(`gate_auto.rs`, ADR-195 4f A5c-2)다. 작업 공간의 바뀐 파일 목록·studio.yaml 다시 읽기·폴더 읽기·import 그래프 읽기와 브라우저 러너·페이지 요청·스크린샷 저장·디자인 비교·sandbox·HTTP 요청만 `GateHost.declared`로 부른다(`gate-auto.ts`, `gate-check.ts`).
   * 여기는 Rust가 부르는 하위 단계(`GateHost`)를 이 객체의 필드·메서드에 잇는다. 상태 필드는 옛 코드가 바꾸던 자리마다 Rust가 알려 준다.
   */
  #check(): Promise<GateOutcome> {
    return runGateCheck(this.#host());
  }

  /** 차등 시험이 옛 구현(`gate-legacy.ts`)에 같은 하위 단계를 넘기려고 꺼내 간다. 제품 코드는 쓰지 않는다 */
  [GATE_HOST](): GateHost {
    return this.#host();
  }

  #host(): GateHost {
    const gate = this;
    const { sandbox, workspace, signal, onEvent, onServiceStatus, fetcher, allowBreaking } = this.#options;
    return {
      sandbox,
      signal,
      onEvent,
      recheck: this.#options.recheck === true,
      light: this.#options.verify === 'light',
      allowBreaking,
      platformRetryDelayMs: this.#options.platformRetryDelayMs ?? PLATFORM_RETRY_DELAY_MS,
      state: {
        get attempts() {
          return gate.attempts;
        },
        set attempts(value) {
          gate.attempts = value;
        },
        get maxAttempts() {
          return gate.#maxAttempts;
        },
        get report() {
          return gate.report;
        },
        set report(value) {
          gate.report = value;
        },
        get checks() {
          return gate.checks;
        },
        set checks(value) {
          gate.checks = value;
        },
        get passedStages() {
          return gate.passedStages;
        },
        set passedStages(value) {
          gate.passedStages = value;
        },
        get skippedStages() {
          return gate.skippedStages;
        },
        set skippedStages(value) {
          gate.skippedStages = value;
        },
        get verified() {
          return gate.verified;
        },
        set verified(value) {
          gate.verified = value;
        },
        get platformFailure() {
          return gate.platformFailure;
        },
        set platformFailure(value) {
          gate.platformFailure = value;
        },
        get failedServices() {
          return gate.#failedServices;
        },
        set failedServices(value) {
          gate.#failedServices = value;
        },
        get project() {
          return gate.#project;
        },
        get unadoptedChange() {
          return gate.#unadoptedChange;
        },
      },
      verifyOptions: (files, alsoRestart) => ({
        sandbox,
        project: this.#project,
        changedFiles: files,
        baselines: this.#baselines,
        allowBreaking,
        fetcher,
        start: { signal, onStatus: onServiceStatus },
        ...(alsoRestart.length > 0 ? { alsoRestart } : {}),
      }),
      outsideSync: async () => (await this.#outsideTracker?.sync())?.rejected ?? [],
      reviewDeclaredChecks: () => this.#reviewDeclaredChecks(),
      requirementRecordChecks: () => this.#requirementRecordChecks(),
      evaluationAssetChecks: () => this.#evaluationAssetChecks(),
      changedFiles: () => workspace.changedFiles(),
      filesToVerify: () => this.#filesToVerify(),
      markVerifiedVersion: () => {
        this.#verifiedVersion = workspace.version;
      },
      declared: {
        sandbox,
        signal,
        onEvent,
        get project() {
          return gate.#project;
        },
        get requestService() {
          return gate.#options.requestService ?? requestService;
        },
        auto: {
          workspace,
          get reloadProject() {
            return gate.#options.reloadProject;
          },
          projectRoot: this.#options.project.root,
        },
        page: {
          sandbox,
          get pageFetcher() {
            return gate.#options.pageFetcher ?? fetchPage;
          },
          get browserRunner() {
            return gate.#options.browserRunner ?? runInBrowser;
          },
          get saveArtifact() {
            return gate.#options.saveArtifact;
          },
          get onBrowserFrame() {
            return gate.#options.onBrowserFrame;
          },
          serviceOrigins: () => this.#serviceOrigins(),
          saveSteps: (name, steps) => this.#saveSteps(name, steps),
          compareDesign: (compare, name, result, pageSandbox) => this.#compareDesign(compare, name, result, pageSandbox),
          addWarning: (name, message) => this.#addWarning(name, message),
        },
        pageMaps: { steps: this.#pageSteps, compares: this.#pageCompares, blocked: this.#pageBlocked, loadMs: this.#pageLoadMs, warnings: this.#pageWarnings },
      },
      recheckEvaluationAssets: (recordChecks) => this.#recheckEvaluationAssets(recordChecks),
      recheckOutsideChanges: (recordChecks) => this.#recheckOutsideChanges(recordChecks),
      reviewChecks: () => {
        // 쓰기 직전 고정값과 바이트까지 같은 보호 경로 파일은 "쓰고 되돌린 것"이라 보호 경로 확인에서 뺀다(이슈 #992). 고정값이 없으면 바뀐 것으로 본다
        const changed = this.#options.recheck === true ? [] : workspace.changedFiles();
        return reviewChanges(this.#project, changed, workspace.restoredProtectedFiles(changed));
      },
      missingStages: (passed) => missingVerificationStages(this.#project, passed),
    };
  }

  /**
   * 이번 검증에 쓸 확인 선언을 정한다(ADR-164). 기본은 실행을 시작할 때의 선언이다 — 에이전트가 실행 도중에 확인을 지우거나
   * 느슨하게 고쳐 비켜 가지 못하게 한다(ADR-159). 사용자가 이 요청에서 선언 변경을 허용했을 때만 지금 파일의 선언을 쓰고,
   * 무엇이 바뀌었는지 리뷰 단계의 확인으로 남긴다. 허용했는데 파일을 읽지 못하면 옛 선언으로 조용히 통과시키지 않고 실패로 알린다.
   * 허용하지 않았는데 선언이 바뀌어 있으면 그 사실만 기억해 두었다가 실패 안내에 싣는다. 다만 그 변경이 선언을 약하게
   * 바꾼 것이면(확인·보호를 지우거나 느슨하게 고침) 이번 검증은 통과시키지 않고 리뷰 단계에서 실패로 알린다(#767)
   */
  async #reviewDeclaredChecks(): Promise<WorkflowCheck[]> {
    const started = this.#options.project;
    this.#project = started;
    this.#unadoptedChange = undefined;
    const allowed = this.#options.allowCheckChanges === true;
    // 카드 맥락처럼 세션 프로젝트에 완료 검사를 덧입혔으면, 견주는 시작 값은 덧입히기 전 **파일에 적힌** workflow다.
    // 덧입힌 값을 기준으로 삼으면 파일에서 지운 선언이 도로 생겨 차이가 보이지 않는다(#767)
    const baseline = this.#options.declarationBaseline ?? started.spec.workflow;
    const latest = await this.#latestWorkflow(allowed);
    if (!latest) return [];
    if ('error' in latest) {
      // 이번 실행에서 studio.yaml을 읽을 수 없게 바꿨으면 그대로 두지 않는다. 그대로 통과시키면 다음 실행부터
      // 선언 없이 돌게 된다. 허용이 있으면 지금처럼 허용한 변경으로 검증하지 못했다고 알린다
      if (!allowed) {
        return [
          {
            stage: 'review',
            name: 'weakened-declarations',
            ok: false,
            attempts: 1,
            detail: this.#options.sandbox.redact(`${SPEC_FILE}을(를) 읽을 수 없게 바꿨습니다${latest.error}. 되돌리세요.`),
          },
        ];
      }
      return [{ stage: 'review', name: DECLARED_CHECKS_CHECK, ok: false, attempts: 1, detail: `${SPEC_FILE}을(를) 다시 읽지 못해 바뀐 확인 선언으로 검증하지 못했습니다${latest.error}` }];
    }
    // 견주는 판정은 네이티브(ADR-191 3e)라 견줄 수 없는 선언(짝 없는 서로게이트 등)에서 던진다. 던지면 게이트 전체가 거절되고
    // 앞 검증의 결과가 남을 수 있으니, 견주지 못한 것 자체를 이번 검증의 실패로 남긴다(모르면 통과가 아니다)
    let change: ReturnType<typeof diffDeclaredChecks>;
    let weakened: string[];
    let changed: boolean;
    let summary: string;
    let merged: ReturnType<typeof withDeclaredChecks> | undefined;
    try {
      change = diffDeclaredChecks(baseline, latest.workflow);
      weakened = weakenedDeclarations(baseline, latest.workflow);
      changed = hasDeclaredCheckChange(change);
      if (!changed && weakened.length === 0) return [];
      summary = this.#options.sandbox.redact(describeDeclaredCheckChange(change));
      if (allowed) merged = withDeclaredChecks(started.spec.workflow, latest.workflow);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const detail = this.#options.sandbox.redact(
        `${SPEC_FILE}의 확인 선언을 시작할 때의 선언과 견주지 못했습니다(${reason}). 견줄 수 없는 선언으로는 검증을 통과시키지 않습니다 — 되돌리세요.`,
      );
      return [{ stage: 'review', name: allowed ? DECLARED_CHECKS_CHECK : 'weakened-declarations', ok: false, attempts: 1, detail }];
    }
    if (!allowed) {
      // 확인 선언이 바뀐 사실은 지금처럼 실패 안내에 싣는다. 약하게 바꾼 것은 그 자체로 이번 검증을 통과시키지 않는다
      if (changed) this.#unadoptedChange = summary;
      if (weakened.length > 0) {
        const detail = this.#options.sandbox.redact(
          `${SPEC_FILE}의 확인·보호 선언을 약하게 바꿨습니다: ${weakened.join(' · ')}. 되돌리세요. 바꾸는 것이 사용자의 요청이면 되묻기 도구(ask_user)로 '확인 선언 변경 허용'을 켜고 답해 달라고 알리세요.`,
        );
        return [{ stage: 'review', name: 'weakened-declarations', ok: false, attempts: 1, detail }];
      }
      return [];
    }
    this.#project = { ...started, spec: { ...started.spec, workflow: merged } } as LoadedProject;
    // 확인 선언의 삭제·변경은 위 요약에 이미 들어 있다. 여기서는 그 밖에 약해진 실행 정책을 함께 적는다
    const declared = new Set([...change.removed.map((name) => `삭제: ${name}`), ...change.changed.map((name) => `변경: ${name}`)]);
    const policy = weakened.filter((item) => !declared.has(item));
    const detail = [
      ...(changed ? [`사용자가 허용해 바뀐 확인 선언으로 검증했습니다 — ${summary}`] : []),
      ...(policy.length > 0 ? [`${changed ? '약하게 바꾼 실행 정책' : '사용자가 허용해 약하게 바뀐 실행 정책을 받아들였습니다'}: ${policy.join(' · ')}`] : []),
    ].join(' · ');
    return [{ stage: 'review', name: DECLARED_CHECKS_CHECK, ok: true, attempts: 1, detail: this.#options.sandbox.redact(detail) }];
  }

  /**
   * 지금 디스크의 studio.yaml에서 workflow를 읽는다. 읽을 까닭이 없으면(이번 실행에서 바뀌지 않았고 허용도 없으면) undefined.
   * 설정 파일이 일반 파일인지 먼저 본다 — 호스트에서 읽는 파일이라 다른 곳으로 가는 링크로 바뀌어 있으면 그 너머의 내용이
   * 형식 오류 문구를 타고 모델에게 돌아갈 수 있다(#withLatestSampleValues와 같은 규칙). 확인 선언의 변경·약화 판정은
   * reloadProject를 쓰지 않고 이 경로로 읽는다(#767)
   */
  async #latestWorkflow(always: boolean): Promise<{ workflow: LoadedProject['spec']['workflow'] } | { error: string } | undefined> {
    const { workspace } = this.#options;
    const root = this.#options.project.root;
    if (!always && !workspace.changedFiles().includes(SPEC_FILE)) return undefined;
    const file = readProjectFileSync(root, SPEC_FILE);
    if (file.kind !== 'text') return { error: `(${file.kind === 'irregular' ? file.reason : '파일 없음'})` };
    try {
      return { workflow: (await loadProject(root)).spec.workflow };
    } catch (error) {
      // 형식 오류의 항목만 알려 준다. 그 밖의 오류 문구는 어디서 온 내용인지 알 수 없어 싣지 않는다
      return { error: error instanceof SpecError ? `: ${this.#options.sandbox.redact([error.message, ...error.issues].join(' / '))}` : '' };
    }
  }

  #stage(stage: WorkflowStage): void {
    this.#options.onEvent({ type: 'stage', stage, source: 'platform' });
  }

  /** 게이트를 막지 않는 참고 문구를 이름별로 모아 둔다. detail에 붙여 QA 보기·모델 피드백에서 볼 수 있게 한다 */
  #addWarning(name: string, message: string): void {
    const list = this.#pageWarnings.get(name) ?? [];
    list.push(message);
    this.#pageWarnings.set(name, list);
  }

  /**
   * 단계 스크린샷을 저장하고 식별자를 붙인다. 저장은 관측용이라 실패해도 확인 결과를 바꾸지 않고 경고만 남긴다.
   * browser_check의 browser 모드가 아니면 스크린샷이 없어 저장하지 않는다
   */
  async #saveSteps(name: string, steps: readonly BrowserPageStep[]): Promise<WorkflowStepCheck[]> {
    const save = this.#options.saveArtifact;
    const saved: WorkflowStepCheck[] = [];
    for (const [index, step] of steps.entries()) {
      let artifact: string | undefined;
      if (save && step.screenshot) {
        try {
          artifact = await save({ name: `${name} ${index + 1}. ${step.label}`, data: step.screenshot, contentType: 'image/png' });
        } catch (error) {
          console.warn(`화면 확인 스크린샷을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      saved.push({ label: step.label, ok: step.ok, ...(step.detail !== undefined ? { detail: step.detail } : {}), ...(artifact ? { artifact } : {}) });
    }
    return saved;
  }

  /**
   * 마지막 단계 뒤의 뷰포트 화면을 디자인 기준 이미지와 비교한다.
   * 기준 이미지는 project.root 기준으로 읽고, 없거나 읽지 못하면 건너뛰지 않고 확인 실패로 알린다.
   * 비율이 허용치를 넘으면 실패시키되, 비교 이미지는 산출물로 남겨 화면에서 볼 수 있게 한다
   */
  async #compareDesign(compare: WorkflowPageCompare, name: string, result: BrowserPageResult, sandbox: Sandbox): Promise<void> {
    const actual = result.steps.at(-1)?.screenshot;
    if (!actual) throw new Error('디자인 비교에 쓸 뷰포트 스크린샷을 찍지 못했습니다');
    const reference = await readFile(path.join(this.#options.project.root, compare.reference)).catch(() => undefined);
    if (!reference) throw new Error(`디자인 기준 이미지를 읽지 못했습니다: ${compare.reference}`);

    let comparison: CompareResult;
    try {
      comparison = compareScreenshot({ actual, reference, masks: compare.masks, threshold: compare.threshold });
    } catch (error) {
      // 비교 자체가 성립하지 않는 경우(너비 불일치)는 원인을 그대로 알린다
      if (error instanceof VisualCompareError) throw new Error(sandbox.redact(error.message));
      throw error;
    }
    this.#pageCompares.set(name, { ratio: comparison.ratio, max: compare.maxDiffRatio, ...(await this.#saveCompareImages(name, reference, actual, comparison.diff)) });
    if (comparison.ratio > compare.maxDiffRatio) throw new Error(compareDetail(comparison, compare.maxDiffRatio));
  }

  /** 기준·실제·차이 이미지를 저장한다. 저장은 관측용이라 실패해도 비교 결과를 바꾸지 않고 경고만 남긴다 */
  async #saveCompareImages(name: string, reference: Buffer, actual: Buffer, diff: Buffer): Promise<Pick<WorkflowCompare, 'reference' | 'actual' | 'diff'>> {
    const save = this.#options.saveArtifact;
    const saved: Pick<WorkflowCompare, 'reference' | 'actual' | 'diff'> = {};
    if (!save) return saved;
    const images: Array<[keyof typeof saved, string, Buffer]> = [
      ['reference', '디자인', reference],
      ['actual', '실제', actual],
      ['diff', '차이', diff],
    ];
    for (const [key, label, data] of images) {
      try {
        saved[key] = await save({ name: `${name} ${label} 이미지`, data, contentType: 'image/png' });
      } catch (error) {
        console.warn(`디자인 비교 이미지를 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return saved;
  }

  /**
   * 화면 확인이 요청해도 되는 출처. 세션의 모든 managed 서비스가 게이트에서 쓰는 주소(endpoint)의 출처를 모은다.
   * 프론트가 다른 포트의 백엔드를 부르므로 한 서비스만 허용하면 화면이 망가지고, 그 밖의 출처로는 나가지 못하게 한다
   */
  async #serviceOrigins(): Promise<string[]> {
    const { sandbox, project } = this.#options;
    const origins = new Set<string>();
    for (const [name] of project.managed) {
      if (project.offServices?.has(name)) continue;
      try {
        origins.add(new URL((await sandbox.endpoint(name)).url).origin);
      } catch {
        // 아직 준비되지 않았거나 없는 서비스의 주소는 건너뛴다
      }
    }
    return [...origins];
  }

  /** 지난 검증 이후 바뀐 파일 + 지난번에 준비에 실패한 서비스의 파일 (고치지 않았더라도 다시 확인해야 한다) */
  #filesToVerify(): string[] {
    const { project, workspace } = this.#options;
    const files = new Set(workspace.changedSince(this.#verifiedVersion));
    if (this.#failedServices.size > 0) {
      for (const file of workspace.changedFiles()) {
        // studio.yaml·compose는 모든 서비스에 속하므로(servicesForFiles) 첫 서비스만 보지 않고 전부 본다
        if (servicesForFiles(project, [file]).services.some((owner) => this.#failedServices.has(owner))) files.add(file);
      }
    }
    return [...files].sort();
  }
}

/** 평가 자산 지문: 정상이면 경로→sha256, 읽을 수 없었으면 그 사유 */
type EvaluationAssetBaseline = { kind: 'ok'; digests: Map<string, string> } | { kind: 'error'; detail: string };

interface EvaluationAssetScan {
  digests: Map<string, string>;
  count: number;
}

function evaluationAssetFailure(stage: WorkflowCheck['stage'], detail: string): WorkflowCheck {
  return { stage, name: 'evaluation-assets', ok: false, attempts: 1, detail };
}

/** 평가 자산이 바뀌었을 때의 사유. 사람이 고치는 자산이라는 것과 되돌리는 방법을 알린다 (최대 20개까지 나열) */
function describeEvaluationAssetChange(changed: readonly string[]): string {
  const shown = changed.slice(0, MAX_EVALUATION_ASSET_LIST);
  const rest = changed.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} 외 ${rest}개` : shown.join(', ');
  return `평가 자산이 바뀌었습니다: ${list}. 평가 자산은 사람이 고칩니다 — 되돌리고 구현을 고치세요. 평가 자산이 틀렸다고 판단하면 그 까닭을 답에 적어 사람에게 알리세요.`;
}

/**
 * 선언한 평가 자산의 지문을 뜬다(ADR-175). 경로별 sha256이고, 폴더면 그 아래 일반 파일을 모두 담는다.
 * 링크·특수 파일이거나 읽을 수 없으면 실패로 알린다(닫힌 쪽 — 견줄 수 없으면 통과시키지 않는다).
 * 없는 경로는 지문에 넣지 않는다(선언했지만 아직 없는 자산이 새로 생기면 그때 "바뀜"으로 잡힌다).
 */
async function fingerprintEvaluationAssets(root: string, assets: readonly string[]): Promise<EvaluationAssetBaseline> {
  const scan: EvaluationAssetScan = { digests: new Map(), count: 0 };
  for (const asset of assets) {
    const error = await collectEvaluationAsset(root, path.normalize(asset), scan);
    if (error) return { kind: 'error', detail: `${asset}: ${error}` };
  }
  return { kind: 'ok', digests: scan.digests };
}

/** 자산 하나(파일 또는 폴더)를 훑어 지문에 담는다. 문제가 있으면 사유를, 없으면 undefined를 돌려준다 */
async function collectEvaluationAsset(root: string, relative: string, scan: EvaluationAssetScan): Promise<string | undefined> {
  // 상위 폴더가 링크면 그 너머를 보지 않는다(readProjectFileSync와 같은 규칙)
  if (!parentsAreReal(root, relative)) return '상위 폴더가 심볼릭 링크입니다';
  const absolute = path.join(root, relative);
  const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => error);
  if (info instanceof Error) {
    if (info.code === 'ENOENT' || info.code === 'ENOTDIR') return undefined;
    return `읽을 수 없습니다(${info.code ?? '알 수 없는 오류'})`;
  }
  if (info.isSymbolicLink()) return '심볼릭 링크입니다';
  if (!info.isDirectory()) return recordEvaluationFile(absolute, relative, scan);
  return walkEvaluationAssetDir(absolute, relative, scan);
}

/** 폴더 아래의 일반 파일을 모두 지문에 담는다. 링크·특수 파일이 있으면 실패한다 */
async function walkEvaluationAssetDir(dir: string, relative: string, scan: EvaluationAssetScan): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error);
  if (entries instanceof Error) return `폴더를 읽지 못했습니다(${entries.code ?? '알 수 없는 오류'})`;
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childRelative = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) return `${childRelative}: 심볼릭 링크입니다`;
    if (entry.isDirectory()) {
      const error = await walkEvaluationAssetDir(path.join(dir, entry.name), childRelative, scan);
      if (error) return error;
    } else if (entry.isFile()) {
      const error = recordEvaluationFile(path.join(dir, entry.name), childRelative, scan);
      if (error) return error;
    } else {
      return `${childRelative}: 일반 파일도 폴더도 아닙니다`;
    }
  }
  return undefined;
}

/** 일반 파일 하나의 내용을 지문에 담는다. 바이트로 해시한다 — 글자로 바꾸면 서로 다른 바이트가 같은 글자가 되어, 이미지·바이너리 자산을 바꿔도 지문이 같아진다(parser differential). 파일 수 상한을 넘거나 읽을 수 없거나 읽는 도중 바뀌었으면 실패한다 */
function recordEvaluationFile(absolute: string, relative: string, scan: EvaluationAssetScan): string | undefined {
  scan.count += 1;
  if (scan.count > MAX_EVALUATION_ASSET_FILES) return `파일이 ${MAX_EVALUATION_ASSET_FILES}개를 넘습니다 — 선언을 좁히세요`;
  const read = readRegularFileBytesSync(absolute);
  if (read.kind !== 'bytes') return read.kind === 'irregular' ? read.reason : '파일이 없습니다';
  // 확인한 크기만큼 다 읽지 못했으면 지문을 뜨는 동안 파일이 바뀐 것이다. 어중간하게 읽은 바이트를 지문으로 삼지 않는다(닫힌 쪽)
  if (!read.complete) return '읽는 동안 파일이 바뀌었습니다';
  scan.digests.set(relative, createHash('sha256').update(read.content).digest('hex'));
  return undefined;
}

/** 프로젝트 루트 기준 상대 경로의 상위 폴더 중 링크가 있으면 false. 열 수 없으면 true(아래 lstat이 판정한다) */
function parentsAreReal(root: string, relative: string): boolean {
  const parent = path.dirname(relative);
  if (parent === '.') return true;
  try {
    return realpathSync(path.join(root, parent)) === path.join(realpathSync(root), parent);
  } catch {
    return true;
  }
}

export function formatFailedChecks(checks: readonly WorkflowCheck[]): string {
  return native.gateFormatFailedChecks(encodeNative(checks.map((check) => ({ stage: check.stage, name: check.name, attempts: check.attempts, detail: check.detail }))));
}

/** 디자인 비교 실패 문구. 비율과 허용치, 비교한 크기를 함께 적는다 */
export function compareDetail(comparison: CompareResult, max: number): string {
  return native.gateCompareDetail(comparison.ratio, max, comparison.width, comparison.height);
}

/** 동시 요청 확인의 기대를 사람이 읽는 한 줄로. then 값은 따로 적으므로 여기 넣지 않는다 */
export function describeConcurrencyExpect(expect: ConcurrencyExpect): string {
  const count = expect.successCount;
  return native.gateDescribeConcurrencyExpect(encodeNative({ successCount: count ? { exactly: count.exactly, atMost: count.atMost } : undefined, allStatusIn: expect.allStatusIn }));
}

/** api에서 꺼낸 값. 화면 글자와 비교한다 */
/** 근거는 사람이 보는 표시일 뿐이라, 만들다 실패해도 이미 내려진 통과 판정을 뒤집지 않는다(근거 없이 통과로 남는다) */
export function evidenceOrNone(build: () => string[]): string[] {
  try {
    return build();
  } catch {
    return [];
  }
}

export interface ApiValue {
  service: string;
  jsonPath: string;
  value: string | number;
}

/** api 값이 화면 글자에 있는지. 숫자는 원문과 천 단위 구분(12,000) 표기를 둘 다 인정한다 */
export function containsApiValue(text: string, value: string | number): boolean {
  // 숫자의 견줄 글자는 ASCII(와 ∞)뿐이라 본문의 짝 없는 서로게이트가 달라져도 결과가 같다. 글자 값은 두 글자를 단사로 바꿔 보낸다(트러블슈팅 165)
  if (typeof value === 'number') return native.gateContainsApiNumber(text, value);
  return native.gateContainsApiText(encodeLoneSurrogates(text), encodeLoneSurrogates(value));
}

/** api 값이 화면에 없을 때의 문구. 화면이 다른 필드 이름을 읽고 있을 수 있음을 알린다 */
export function missingApiValue(api: ApiValue, pagePath: string): string {
  return native.gateMissingApiValue(api.service, api.jsonPath, typeof api.value === 'string' ? api.value : undefined, typeof api.value === 'number' ? api.value : undefined, pagePath);
}

/** expectInViewport 실패 한 건의 문구. 어느 글자가 어떻게 안 보이는지와 창 크기를 적는다 */
export function viewportProblemText(finding: ViewportTextFinding, width: number, height: number): string {
  return native.gateViewportProblemText(encodeNative({ text: finding.text, visible: finding.visible, problem: finding.problem }), width, height);
}

/**
 * expectInViewport 판정. 러너가 재지 못했거나 일부 글자의 결과가 빠졌으면 통과로 보지 않는다.
 * 글자 짝짓기(찾은 결과가 곧 통과)는 `encodeLoneSurrogates`한 key로 한다: 짝 없는 서로게이트가 경계에서 모두 U+FFFD가 되어 다른 글자를 "찾았다"고 읽지 않게(트러블슈팅 165)
 */
export function viewportProblems(expected: readonly string[], report: ViewportTextReport | undefined): string[] {
  return native.gateViewportProblems(
    encodeNative({
      expected: expected.map((text) => ({ key: encodeLoneSurrogates(text), text })),
      report: report
        ? { width: report.width, height: report.height, findings: report.findings.map((finding) => ({ key: encodeLoneSurrogates(finding.text), text: finding.text, visible: finding.visible, problem: finding.problem })) }
        : null,
    }),
  );
}

/** expectAllText 실패 문구. 빠진 문구만 적는다 */
export function missingAllText(values: readonly string[]): string {
  return native.gateMissingAllText([...values]);
}

/** expectAnyText 실패 문구. 적은 문구 중 어느 것도 없을 때 */
export function missingAnyText(values: readonly string[]): string {
  return native.gateMissingAnyText([...values]);
}

/** 추정한 id로 연 동적 경로가 404·500을 돌려줬을 때의 문구(ADR-078). id가 실제로 없을 수도 있다는 것과 고치는 방법을 함께 적는다 */
/** 추정한 id로 연 화면이 상태 코드가 아닌 이유(실패한 요청, 멈춘 로딩 등)로 실패했을 때 붙이는 안내 */
export function dynamicProbeDataHint(probedId: string): string {
  return native.gateDynamicProbeDataHint(probedId);
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
  // 어느 세그먼트가 `[이름]`인지는 Rust가 정하고, 이름은 원래 글자에서 잘라 쓴다(이름의 짝 없는 서로게이트를 지킨다)
  const segments = pageFile.split('/');
  return native.gateDynamicSegments(pageFile).map((index) => segments[index]!.slice(1, -1));
}

/** 받아들인 값을 알리는 문구. 되돌린 값이 빠진 마지막 상태에서 만든다 */
export function acceptedNotes(latest: LatestSampleValues): string[] {
  const from = latest.config.sampleIdFrom;
  return native.gateAcceptedNotes(SPEC_FILE, [...latest.inRunKeys], Object.entries(latest.config.sampleParams ?? {}), latest.inRunSampleIdFrom, from?.service, from?.path);
}

/** 이 경로가 실행 중에 받아들인 값으로 채워졌는지: 동적 세그먼트가 그 키를 쓰거나, 추정 id가 실행 중에 들어온 sampleIdFrom에서 왔을 때 */
export function usesInRunValue(route: { file: string; usedFallbackParams?: readonly string[] }, latest: LatestSampleValues): boolean {
  // 이름과 키를 같이 단사로 바꿔 보낸다. 다른 이름이 같은 U+FFFD가 되어 "받아들인 값을 쓴다"로 읽히지 않게
  return native.gateUsesInRunValue(encodeLoneSurrogates(route.file), [...latest.inRunKeys].map((key) => encodeLoneSurrogates(key)), latest.inRunSampleIdFrom, route.usedFallbackParams?.length ?? 0);
}

export function sampledValues(pageFile: string, sampleParams: Readonly<Record<string, string>> | undefined): string | undefined {
  return native.gateSampledValues(pageFile, Object.entries(sampleParams ?? {})) ?? undefined;
}

/** sampleParams로 알려 준 값으로 연 화면이 실패했을 때 붙이는 안내. 추정이 아니므로 값이 틀렸을 수 있다는 것과 고치는 곳을 말한다 */
function sampledValueHint(sampled: string): string {
  return `이 화면은 studio.yaml의 autoPageChecks.sampleParams로 알려 준 값(${sampled})으로 열었습니다 — 그 값의 데이터가 실제로 없으면 같은 실패가 납니다. 앱이 실제로 가진 값으로 sampleParams를 고치세요(이 값은 같은 실행에서 바로 반영됩니다)`;
}

function dynamicProbeStatusProblem(probedId: string, status: number | null): string {
  return `동적 경로를 추정한 id(${probedId})로 열었더니 HTTP ${status}을 돌려줬습니다 — id가 실제로 없을 수 있습니다. autoPageChecks.sampleParams나 sampleIdFrom으로 실제 값을 알려주면 더 정확히 확인합니다`;
}

/** HTTP 확인 응답 본문(HTML)에서 태그를 걷어내 로딩 문구 판정에 쓸 평문을 만든다. 자바스크립트는 실행하지 않는다 */
export function stripHtml(html: string): string {
  return native.gateStripHtml(html);
}

/**
 * 응답 JSON에서 값을 꺼낸다. `$.a.b`와 `$[0].a`, `$.items[0].qty` 정도만 지원하고 그 밖은 undefined를 돌려준다.
 * 외부 라이브러리(k6 등) 없이 결과 불변식만 보려는 최소 구현이다
 */
export function readJsonPath(text: string, jsonPath: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const segment of jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean)) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    const key = match[1]!;
    if (key) {
      if (typeof value !== 'object' || value === null) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    for (const index of match[2]!.match(/\d+/g) ?? []) {
      if (!Array.isArray(value)) return undefined;
      value = value[Number(index)];
    }
  }
  return value;
}
