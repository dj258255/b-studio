/**
 * 요구사항(docs/requirements.md) → GitHub 이슈 발행·동기화(ADR-092).
 *
 * 한 방향(파일 → 이슈)이다: `docs/requirements.md`가 언제나 원본이고, 이슈는 그 내용을 보여 주는 거울이다.
 * 추적 이슈 하나("요구사항: <프로젝트>")와 must·should 요구사항마다 하위 이슈 하나를 만든다(task-plans.ts의
 * `publishPlanIssues`가 작업 계획에 쓰는 "추적 이슈 + 하위 이슈" 패턴을 그대로 재사용했다). could·docs는
 * 추적 이슈의 체크리스트 항목으로만 남는다(하위 이슈를 만들지 않는다).
 *
 * 이 파일은 순수 함수만 담는다(파일 IO·네트워크 없음) — studio의 `apps/studio/lib/server/requirement-issues.ts`가
 * `packages/agent/src/repository.ts`의 이슈 API 호출과 세션 작업 복사본 읽기/쓰기를 맡고, 여기 함수들은
 * 입력(요구사항·원격 이슈 스냅샷)을 받아 "무엇을 할지"(발행 계획)와 "본문에 무엇을 쓸지"만 계산한다.
 *
 * `requirements.ts`의 `Requirement`가 이미 `rev`·`hash`·`ears`·`scenarios`·`nfr`·`trace` 필드를 갖고 있다(ADR-090).
 * 이 모듈은 그 타입을 그대로 쓰지 않고 구조적으로 호환되는 별도 타입(`RequirementForIssues`)을 선언해 두는데,
 * 이유는 결합을 낮추기 위해서다(이슈 발행은 요구사항 추적과 독립적으로 테스트·재사용하고 싶다) — 필드 이름·모양은
 * `Requirement`와 반드시 같아야 한다(예전에 `ears`를 string, `nfr`을 string[]로 잘못 선언해 두었던 적이 있다 —
 * `Requirement`는 `ears: {pattern, statement}`, `nfr: {metric, threshold, condition, method}`다. 모양이 어긋나면
 * 이슈 본문에 EARS·시나리오·NFR이 전부 빠진 채로 발행된다, 버그 리포트 참고).
 *
 * 문안·판정은 Rust(`crates/bstudio-guard/src/requirement_issues.rs`, ADR-191 3단계 3c)가 한다. 여기에는 타입과, 같은 이름·시그니처로 네이티브 모듈을 부르는 얇은 껍데기만 남았다.
 */
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
import type { Ears, Nfr, RequirementKind, RequirementPriority, RequirementStatus, Scenario } from './requirements';

// ---------------------------------------------------------------------------
// 타입: `Requirement`(requirements.ts)와 같은 모양이되, 결합을 낮추려고 구조적으로만 호환시킨다
// ---------------------------------------------------------------------------

/** 요구사항 ↔ 이슈·다른 요구사항의 관계. requirements.ts의 Trace와 이름을 맞췄다 */
export interface RequirementTrace {
  issue?: number;
  dependsOn?: readonly string[];
  /** 옛 항목을 가리키는 요구사항 id 하나(재추출로 쪼개질 때). requirements.ts의 Trace와 모양을 맞춘다(배열이 아니다) */
  supersedes?: string;
}

/** 마지막으로 이 요구사항을 이슈로 발행했을 때의 기록. requirements.ts의 JSON 블록에 관대하게 얹는 필드다 */
export interface RequirementPublishedRecord {
  issue: number;
  /** requirementContentHash가 그때 계산한 값(우리가 이슈에 쓴 내용의 해시 — "우리가 저장한 해시") */
  hash: string;
  /** ISO 8601 */
  at: string;
}

/**
 * 이 모듈이 다루는 요구사항의 최소 모양. `Requirement`(requirements.ts)와 필드 이름·모양을 반드시 맞춘다.
 * 이 모듈은 그 필드들이 없어도(undefined) 안전하게 동작한다(EARS·시나리오·NFR이 없으면 그 절을 아예 쓰지 않는다).
 */
export interface RequirementForIssues {
  id: string;
  title: string;
  kind: string;
  priority: string;
  acceptance: readonly string[];
  rev?: number;
  hash?: string;
  ears?: Ears;
  scenarios?: readonly Scenario[];
  nfr?: Nfr;
  trace?: RequirementTrace;
  published?: RequirementPublishedRecord;
}

/** 안정적인 짧은 내용 해시(충돌 감지·변경 감지용이지 보안용이 아니다 — sha256 앞 12자로 충분하다) */
export function contentHash(text: string): string {
  return native.reqIssueContentHash(text);
}

export const REQUIREMENT_LABEL = native.reqIssueLabel();

/**
 * 요구사항을 이슈 본문에 쓸 관리형 영역의 "내용" 부분(헤더·꼬리 마커 없이). EARS·시나리오·NFR 절은 값이 있을 때만 쓴다.
 * 한 줄 표기(`- EARS(pattern): …`, `- NFR: 지표 … · …`)는 docs/requirements.md의 몸통 줄과 같은 모양이라 draftManagedRequirement가 그대로 되읽는다
 */
export function buildRegionContent(requirement: RequirementForIssues): string {
  return native.reqIssueBuildRegionContent(encodeNative(requirement));
}

/** buildRegionContent가 만드는 내용만으로 계산한 해시. 이 값이 발행 계획(create/update/conflict)의 판단 기준이다 */
export function requirementContentHash(requirement: RequirementForIssues): string {
  return native.reqIssueRequirementContentHash(encodeNative(requirement));
}

/** 요구사항을 하위 이슈 본문 전체(관리형 영역 하나로 이뤄진다)로 렌더링한다 */
export function buildManagedRegion(requirement: RequirementForIssues, rev: number): string {
  return native.reqIssueBuildManagedRegion(encodeNative(requirement), rev);
}

export interface ParsedManagedRegion {
  id: string;
  rev: number;
  hash: string;
  content: string;
}

/** 이슈 본문에서 관리형 영역을 다시 읽는다. 마커가 없거나 짝이 안 맞으면 undefined */
export function parseManagedRegion(body: string): ParsedManagedRegion | undefined {
  const found = native.reqIssueParseManagedRegion(body);
  return found ? decodeNative<ParsedManagedRegion>(found) : undefined;
}

export function subIssueTitle(requirement: Pick<RequirementForIssues, 'id' | 'title'>): string {
  return native.reqIssueSubIssueTitle(encodeNative({ id: requirement.id, title: requirement.title }));
}

/** subIssueTitle이 붙인 "[R4] " 접두어에서 요구사항 id를 뽑는다. 저장소 탭 이슈 목록이 R-id 칩을 보여줄 때 쓴다 */
export function requirementIdFromIssueTitle(title: string): string | undefined {
  return native.reqIssueIdFromTitle(title) ?? undefined;
}

export function trackingIssueTitle(projectNameOrSpecTitle: string): string {
  return native.reqIssueTrackingTitle(projectNameOrSpecTitle);
}

/**
 * 이미 발행한 추적 이슈를 저장소에서 찾는다. 발행 기록은 세션 작업 복사본에만 있어 다른 세션에서 다시 발행하면 없다 —
 * `b-studio:req` 라벨과 정확한 제목으로 찾는다. 열린 것을 먼저, 그중 가장 먼저 만든(번호가 작은) 것을 고른다
 */
export function findTrackingIssue(
  issues: ReadonlyArray<{ number: number; title: string; labels: readonly string[]; state: 'open' | 'closed'; url?: string }>,
  projectName: string,
): { issue: number; url?: string } | undefined {
  const found = native.reqIssueFindTrackingIssue(
    encodeNative(issues.map((issue) => ({ number: issue.number, title: issue.title, labels: issue.labels, state: issue.state, url: issue.url }))),
    projectName,
  );
  return found ? decodeNative<{ issue: number; url?: string }>(found) : undefined;
}

/** 라벨 집합: b-studio:req, kind:<종류>, priority:<우선순위>, status:<상태>(그대로 한글). 없으면 저장소에 만든다(라벨 생성은 허용된 동작이다) */
export function requirementLabelSet(requirement: Pick<RequirementForIssues, 'kind' | 'priority'>, status: RequirementStatus): string[] {
  return native.reqIssueLabelSet(encodeNative({ kind: requirement.kind, priority: requirement.priority }), status);
}

export function buildSubIssueBody(requirement: RequirementForIssues, rev: number): string {
  return buildManagedRegion(requirement, rev);
}

export interface TrackingRow {
  requirement: Pick<RequirementForIssues, 'id' | 'title' | 'kind' | 'priority'>;
  status: RequirementStatus;
  issue?: number;
  checklistOnly: boolean;
}

/**
 * 추적 이슈 본문: 요구사항마다 표 한 줄(종류·우선순위·상태·하위 이슈 링크) + could·docs만 담는 체크리스트 절.
 * `updatedAt`을 주면 첫 줄에 마지막 갱신 시각을 적는다
 */
export function buildTrackingIssueBody(projectName: string, rows: readonly TrackingRow[], options: { updatedAt?: string } = {}): string {
  return native.reqIssueBuildTrackingBody(projectName, encodeNative(rows), options.updatedAt);
}

export type RequirementPlanAction = 'create' | 'update' | 'unchanged' | 'conflict' | 'reverify' | 'closed_but_requirement_exists';

/** 원격 이슈 하나의 스냅샷(발행 계획 계산에 필요한 최소 정보). 실제 조회는 studio의 orchestrator가 한다 */
export interface RemoteIssueSnapshot {
  number: number;
  state: 'open' | 'closed';
  body: string;
}

export interface RequirementPlanInput {
  requirement: RequirementForIssues;
  status: RequirementStatus;
}

export interface RequirementPlanEntry {
  id: string;
  action: RequirementPlanAction;
  issue?: number;
  /** 지금 요구사항 내용으로 계산한 해시(이번에 발행하면 이 값을 published.hash로 저장한다) */
  localHash: string;
  /** 원격 이슈 본문의 관리형 영역에서 다시 계산한 해시(이슈가 없거나 관리형 영역이 없으면 없다) */
  remoteHash?: string;
  /** could 우선순위이거나 docs 종류 — 하위 이슈를 만들지 않고 추적 이슈의 체크리스트에만 넣는다 */
  checklistOnly: boolean;
  /** 미리보기 화면이 그대로 보여줄 한 줄 설명 */
  note: string;
}

function remoteSnapshots(remoteIssues: readonly RemoteIssueSnapshot[]): string {
  return encodeNative(remoteIssues.map((issue) => ({ number: issue.number, state: issue.state, body: issue.body })));
}

/** trace.issue가 있으면 그 번호로, 없으면 관리형 영역의 id 마커로 찾는다(재발행의 멱등성 — 기록을 잃어도 이슈로 다시 찾는다) */
export function findExistingRemoteIssue(requirement: RequirementForIssues, remoteIssues: readonly RemoteIssueSnapshot[]): RemoteIssueSnapshot | undefined {
  const position = native.reqIssueFindExistingRemote(encodeNative(requirement), remoteSnapshots(remoteIssues));
  return position < 0 ? undefined : remoteIssues[position];
}

/**
 * 발행 계획을 계산한다(순수 함수 — 네트워크 호출 없음). 충돌 판정은 "지금 로컬 내용"이 아니라
 * "우리가 마지막으로 발행했을 때 쓴 해시"(requirement.published.hash)를 기준으로 삼는다:
 * 원격 이슈의 관리형 영역을 다시 해시했을 때 그 값과 다르면 누군가 GitHub에서 직접 고친 것이다
 * (헤더의 hash= 속성은 손으로 안 고치므로 헤더를 믿지 않고 내용을 다시 해시해 비교한다).
 */
export function planRequirementPublish(inputs: readonly RequirementPlanInput[], remoteIssues: readonly RemoteIssueSnapshot[]): RequirementPlanEntry[] {
  return decodeNative<RequirementPlanEntry[]>(native.reqIssuePlan(encodeNative(inputs), remoteSnapshots(remoteIssues)));
}

export interface RequirementPlanSummary {
  total: number;
  /** 하위 이슈를 실제로 새로 만드는 항목 수(체크리스트 전용은 빼고 센다 — could·docs는 하위 이슈를 만들지 않는다) */
  create: number;
  update: number;
  unchanged: number;
  conflict: number;
  reverify: number;
  closedButRequirementExists: number;
  /**
   * could 우선순위·docs 종류라 하위 이슈 없이 추적 이슈 체크리스트로만 남는 항목 수. 이 항목은 매번 action이 'create'로 계산되지만
   * 실제로는 아무것도 새로 만들지 않으므로 `create`에 넣지 않고 따로 센다
   */
  checklistOnly: number;
}

export function summarizeRequirementPlan(entries: readonly RequirementPlanEntry[]): RequirementPlanSummary {
  return decodeNative<RequirementPlanSummary>(native.reqIssueSummarizePlan(encodeNative(entries.map((entry) => ({ action: entry.action, checklistOnly: entry.checklistOnly })))));
}

export type ConflictResolution = 'import' | 'overwrite' | 'ignore';

export interface RequirementEvidenceRow {
  scenario: string;
  test?: string;
  result: string;
  commit?: string;
  gate?: string;
}

/** 하위 이슈에 고정할 상태 댓글 본문(표: 시나리오 | 테스트 | 결과 | 커밋 | 게이트). 매번 이 댓글을 통째로 다시 만들어 편집한다 */
export function buildStatusComment(requirementId: string, status: RequirementStatus, rows: readonly RequirementEvidenceRow[]): string {
  return native.reqIssueBuildStatusComment(requirementId, status, encodeNative(rows));
}

/** 이 댓글이 우리의 고정 상태 댓글인지(requirementId를 주면 그 요구사항 것인지까지) */
export function isStatusComment(body: string, requirementId?: string): boolean {
  return native.reqIssueIsStatusComment(body, requirementId);
}

/** 댓글 목록에서 이 요구사항의 고정 상태 댓글을 찾는다(없으면 새로 만든다 — studio orchestrator가 처리) */
export function findPinnedStatusComment<T extends { body: string }>(comments: readonly T[], requirementId: string): T | undefined {
  // `RegExp.test(body)`가 본문을 문자열로 바꾸던 것(undefined → "undefined")과 같게 넘긴다
  const position = native.reqIssueFindPinnedStatusComment(
    comments.map((comment) => String(comment.body)),
    requirementId,
  );
  return position < 0 ? undefined : comments[position];
}

export interface ImplementedRequirementRef {
  id: string;
  rev?: number;
  issue?: number;
  status: RequirementStatus;
}

export function implementsTrailer(ref: Pick<ImplementedRequirementRef, 'id' | 'rev'>): string {
  return native.reqIssueImplementsTrailer(encodeNative({ id: ref.id, rev: ref.rev }));
}

/** 세션 커밋 제목("요청: [R4] …" 등)에서 "[R4]" 형태로 언급된 요구사항 id를 순서대로, 중복 없이 뽑는다 */
export function extractRequirementMentions(texts: readonly string[]): string[] {
  return native.reqIssueExtractMentions([...texts]);
}

/**
 * PR 본문에 덧붙일 절을 만든다: 검증됨 + 이슈가 있는 요구사항만 `Closes #n`(병합되면 자동으로 닫는다),
 * 구현한 요구사항 전부 `Implements: Rn`(또는 `Rn@revN`).
 *
 * `includeCloses: false`를 주면 `Implements:` 줄만 돌려준다 — 같은 이슈 번호를 본문 맨 위에서 이미 `Closes #n`으로 적었을 때 중복을 막는다
 */
export function buildRequirementsAddendum(refs: readonly ImplementedRequirementRef[], options: { includeCloses?: boolean } = {}): string {
  return native.reqIssueBuildAddendum(encodeNative(refs), Boolean(options.includeCloses ?? true));
}

/** AI 리뷰 라운드 프롬프트에 덧붙일 압축 목록: 이 PR이 구현한 요구사항의 제목·시나리오 */
export function buildReviewRequirementsContext(entries: readonly Pick<RequirementForIssues, 'id' | 'title' | 'scenarios'>[]): string {
  return native.reqIssueBuildReviewContext(encodeNative(entries.map((entry) => ({ id: entry.id, title: entry.title, scenarios: entry.scenarios }))));
}

/** 사용자가 직접 `.github/ISSUE_TEMPLATE/requirement.yml`로 저장해 쓸 수 있는 GitHub 이슈 폼 내용 */
export function buildRequirementIssueFormYaml(): string {
  return native.reqIssueFormYaml();
}

export interface RequirementIssueDraft {
  title: string;
  kind: string;
  priority: string;
  acceptance: string[];
  /** 구조화된 값을 하나라도 못 찾아 기본값으로 대신했다 — 화면이 "검토해 주세요"로 안내한다 */
  guessed: boolean;
}

/** 이슈 폼(requirement.yml)으로 만든 이슈 본문을 요구사항 초안으로 파싱한다. 폼 구획을 하나도 못 찾으면 undefined */
export function parseRequirementIssueForm(title: string, body: string): RequirementIssueDraft | undefined {
  const found = native.reqIssueParseIssueForm(title, body);
  return found ? decodeNative<RequirementIssueDraft>(found) : undefined;
}

/**
 * 이슈 하나(제목+본문)를 요구사항 초안으로 가져온다. 순서대로 시도한다:
 *  1) 우리가 이미 발행한 이슈(관리형 영역이 있다) — 종류·우선순위·인수 조건을 그대로 되읽는다(정확한 왕복)
 *  2) `requirement.yml` 이슈 폼으로 만든 이슈 — 폼 구획을 읽는다
 *  3) 평문 이슈 — 글머리 기호를 인수 조건으로 보고, 종류·우선순위는 기본값(api·must)으로 두고 "검토해 주세요"로 표시한다
 */
export function draftRequirementFromIssue(title: string, body: string): RequirementIssueDraft {
  return decodeNative<RequirementIssueDraft>(native.reqIssueDraftFromIssue(title, body));
}

/**
 * 관리형 영역에서 되읽은 완전한 요구사항 초안. `draftRequirementFromIssue`와 달리 관리형 영역이 있을 때만 값을 돌려주고
 * (없으면 undefined — 호출하는 쪽이 모델 추출로 넘어간다), id·rev·EARS·시나리오·NFR까지 전부 되읽는다.
 */
export interface ManagedRequirementDraft {
  id: string;
  rev: number;
  title: string;
  kind: string;
  priority: string;
  acceptance: string[];
  ears?: Ears;
  scenarios?: Scenario[];
  nfr?: Nfr;
}

/** 이슈 하나(제목+본문)가 b-studio의 관리형 영역을 담고 있으면 모델 호출 없이 완전한 요구사항으로 되읽는다 */
export function draftManagedRequirement(title: string, body: string): ManagedRequirementDraft | undefined {
  const found = native.reqIssueDraftManaged(title, body);
  return found ? decodeNative<ManagedRequirementDraft>(found) : undefined;
}

/** 추적 이슈 본문 표의 `#N` 링크에서 하위 이슈 번호를 순서대로, 중복 없이 뽑는다(Gitea는 하위 이슈 API가 없어 표를 읽는다) */
export function extractTrackingSubIssueNumbers(body: string): number[] {
  return decodeNative<number[]>(native.reqIssueExtractTrackingNumbers(body));
}

/** `draftManagedRequirement`가 돌려준 초안을 docs/requirements.md에 저장할 수 있는 `RequirementForIssues`(=Requirement 호환) 모양으로 바꾼다 */
export function managedRequirementToRequirement(draft: ManagedRequirementDraft): RequirementForIssues & { id: string; rev: number; kind: RequirementKind; priority: RequirementPriority } {
  return decodeNative<RequirementForIssues & { id: string; rev: number; kind: RequirementKind; priority: RequirementPriority }>(native.reqIssueManagedToRequirement(encodeNative(draft)));
}

export class RequirementEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequirementEndpointError';
  }
}

/** repository.ts의 이슈·라벨·댓글 호출이 실제로 fetch하기 직전에 부른다. 허용 목록(이슈·하위 이슈·댓글·라벨, owner/repo 뒤부터) 밖이면 네트워크를 타지 않고 던진다 */
export function assertAllowedRequirementEndpoint(pathname: string): void {
  if (!native.reqIssueIsAllowedEndpoint(pathname)) {
    throw new RequirementEndpointError(`요구사항 발행기가 허용되지 않은 API 경로를 부르려 했습니다(협업자·권한·설정·웹훅 등은 절대 부르지 않습니다): ${pathname}`);
  }
}
