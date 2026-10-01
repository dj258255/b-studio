/**
 * 요구사항(docs/requirements.md) → GitHub 이슈 발행·동기화 orchestrator(ADR-092).
 *
 * 순수 계산(발행 계획·본문·해시)은 `@b-studio/agent`의 `requirement-issues.ts`가 맡는다. 이 파일은 그 계산에
 * 필요한 원격 이슈를 실제로 읽고(`listIssues`), 쓰고(`createIssue`·`updateIssue`·`addSubIssue`·`postComment`·
 * `updateComment`·`ensureLabels`), 발행 기록(어떤 요구사항이 몇 번 이슈가 됐는지·마지막으로 쓴 해시)을
 * 세션 작업 복사본의 사이드카 파일에 남긴다.
 *
 * **세션(`sessions.ts`)을 import하지 않는다.** 이 모듈의 함수는 전부 `RequirementIssuesContext`(원격·토큰·
 * 프로젝트 루트)와 순수 데이터(요구사항·상태)만 받는다 — `sessions.ts`가 이 모듈을 부르는 쪽(task-plans.ts가
 * sessions.ts를 부르는 것과 같은 방향)이라, 반대 방향으로 순환 참조가 생기지 않는다.
 *
 * **`docs/requirements.md`를 고치지 않는다.** `Requirement`는 이미 `rev`·`hash`·`ears`·`scenarios`·`nfr`·`trace`
 * 필드를 갖고 있다(ADR-090). 이 모듈은 발행 기록(이슈 번호·rev·발행 해시)만 별도 파일 `docs/requirements.issues.json`에
 * 남기고, 그 밖의 내용(EARS·시나리오·NFR 포함)은 호출하는 쪽이 넘긴 `Requirement`를 그대로 읽는다.
 */
import {
  addSubIssue,
  buildStatusComment,
  buildSubIssueBody,
  buildTrackingIssueBody,
  contentHash,
  createIssue,
  draftRequirementFromIssue,
  ensureLabels,
  findPinnedStatusComment,
  findTrackingIssue,
  listIssueComments,
  listIssues,
  parseManagedRegion,
  planRequirementPublish,
  postComment,
  REQUIREMENT_LABEL,
  requirementContentHash,
  requirementIdFromIssueTitle,
  requirementLabelSet,
  subIssueTitle,
  summarizeRequirementPlan,
  trackingIssueTitle,
  updateComment,
  updateIssue,
  Workspace,
  type ConflictResolution,
  type GateCheckResult,
  type Requirement,
  type RemoteIssueSnapshot,
  type RemoteLocation,
  type RequirementForIssues,
  type RequirementIssueDraft,
  type RequirementPlanEntry,
  type RequirementPlanSummary,
  type RequirementStatus,
  type TestMatch,
} from '@b-studio/agent';
import { StudioError } from './errors';

export const REQUIREMENT_ISSUES_FILE = 'docs/requirements.issues.json';

export interface RequirementIssuesContext {
  root: string;
  remote: RemoteLocation;
  token: string;
  projectName: string;
}

interface StoredRecord {
  issue: number;
  rev: number;
  publishedHash: string;
  publishedAt: string;
}

interface StoredFile {
  tracking?: { issue: number; url: string };
  byId: Record<string, StoredRecord>;
}

async function loadStore(root: string): Promise<StoredFile> {
  try {
    const raw = await new Workspace(root).read(REQUIREMENT_ISSUES_FILE);
    const parsed = JSON.parse(raw) as Partial<StoredFile>;
    return { tracking: parsed.tracking, byId: parsed.byId ?? {} };
  } catch {
    return { byId: {} };
  }
}

async function saveStore(root: string, store: StoredFile): Promise<void> {
  await new Workspace(root).write(REQUIREMENT_ISSUES_FILE, `${JSON.stringify(store, null, 2)}\n`);
}

/**
 * `Requirement`를 이슈 발행기가 읽는 모양(`RequirementForIssues`)으로 옮긴다. rev는 항상 파일(docs/requirements.md)의
 * 개정 번호를 그대로 쓴다(ADR-106) — 발행 기록(사이드카)의 rev는 더는 따로 늘리지 않는, 마지막으로 발행했을 때의
 * 기록값일 뿐이라 우선하지 않는다. trace.issue만 발행 기록을 우선한다(그래야 재발행 때 같은 이슈를 찾는다)
 */
function toRequirementForIssues(requirement: Requirement, record: StoredRecord | undefined): RequirementForIssues {
  return {
    id: requirement.id,
    title: requirement.title,
    kind: requirement.kind,
    priority: requirement.priority,
    acceptance: requirement.acceptance,
    rev: requirement.rev,
    ears: requirement.ears,
    scenarios: requirement.scenarios,
    nfr: requirement.nfr,
    trace: record ? { issue: record.issue, dependsOn: requirement.trace?.dependsOn, supersedes: requirement.trace?.supersedes } : requirement.trace,
    published: record ? { issue: record.issue, hash: record.publishedHash, at: record.publishedAt } : undefined,
  };
}

function isChecklistOnly(requirement: Pick<Requirement, 'kind' | 'priority'>): boolean {
  return requirement.priority === 'could' || requirement.kind === 'docs';
}

/** b-studio:req 라벨이 붙었거나 제목이 "[Rn] …" 형태인 이슈만 골라 관리형 영역 스냅샷으로 바꾼다(전체 이슈가 아니라 이 프로젝트가 만든 것만) */
async function fetchRemoteRequirementIssues(
  ctx: RequirementIssuesContext,
): Promise<{ snapshots: RemoteIssueSnapshot[]; tracking?: { issue: number; url?: string } }> {
  const issues = await listIssues(ctx.remote, { state: 'all', token: ctx.token });
  const snapshots = issues
    .filter((issue) => issue.labels.includes(REQUIREMENT_LABEL) || requirementIdFromIssueTitle(issue.title) !== undefined)
    .map((issue) => ({ number: issue.number, state: issue.state, body: issue.body ?? '' }));
  return { snapshots, tracking: findTrackingIssue(issues, ctx.projectName) };
}

/** 미리보기에 보여줄 저장소 이름(호스트/경로). 자격 증명은 RemoteLocation.display에서 이미 빠져 있다 */
function repositoryLabel(remote: RemoteLocation): string {
  return remote.host && remote.path ? `${remote.host}/${remote.path}` : remote.display;
}

/** 발행 기록에 추적 이슈가 없으면 저장소에서 찾은 것을 쓴다(다른 세션에서 이미 발행한 경우) */
function resolveTracking(
  store: { tracking?: { issue: number; url: string } },
  found: { issue: number; url?: string } | undefined,
): { issue: number; url?: string } | undefined {
  return store.tracking ?? found;
}

export interface RequirementPlanResult {
  plan: RequirementPlanEntry[];
  summary: RequirementPlanSummary;
  /** 이슈를 쓸 저장소(화면 표시용, 예: github.com/dj258255/test). 외부에 쓰는 동작이라 미리보기에 꼭 보여준다 */
  repository: string;
  /** 추적 이슈를 새로 만드는지, 이미 있는 것을 갱신하는지 */
  tracking: { action: 'create' } | { action: 'update'; issue: number };
}

/** 발행 전 미리보기(dry-run). 네트워크로 원격 이슈를 읽기만 하고 아무것도 쓰지 않는다 */
export async function planRequirementIssuePublish(
  ctx: RequirementIssuesContext,
  requirements: readonly Requirement[],
  statusById: Readonly<Record<string, RequirementStatus>>,
): Promise<RequirementPlanResult> {
  const store = await loadStore(ctx.root);
  const remote = await fetchRemoteRequirementIssues(ctx);
  const inputs = requirements.map((requirement) => ({
    requirement: toRequirementForIssues(requirement, store.byId[requirement.id]),
    status: statusById[requirement.id] ?? '미착수',
  }));
  const plan = planRequirementPublish(inputs, remote.snapshots);
  const tracking = resolveTracking(store, remote.tracking);
  return {
    plan,
    summary: summarizeRequirementPlan(plan),
    repository: repositoryLabel(ctx.remote),
    tracking: tracking ? { action: 'update', issue: tracking.issue } : { action: 'create' },
  };
}

/** 발행 결과. 미리보기의 계획·요약은 그대로 담고, 추적 이슈는 "무엇을 할지" 대신 실제로 쓴 이슈 번호·주소를 돌려준다 */
export interface RequirementPublishResult extends Omit<RequirementPlanResult, 'tracking' | 'repository'> {
  tracking?: { issue: number; url: string };
  /** 하위 이슈·추적 이슈 중 일부가 실패해도 나머지는 계속 진행한다. 실패한 요구사항 id와 이유 */
  errors: Array<{ id: string; message: string }>;
}

/**
 * 계획을 실제로 실행한다: create·update·reverify인 요구사항의 하위 이슈를 만들거나 고치고, 라벨을 보장하고,
 * 추적 이슈(표 + could·docs 체크리스트)를 만들거나 갱신하고, GitHub이면 새로 만든 하위 이슈를 추적 이슈에 연결한다.
 * conflict·unchanged·closed_but_requirement_exists는 쓰지 않는다(충돌은 `resolveRequirementConflict`로 따로 푼다).
 */
export async function publishRequirementIssues(
  ctx: RequirementIssuesContext,
  requirements: readonly Requirement[],
  statusById: Readonly<Record<string, RequirementStatus>>,
): Promise<RequirementPublishResult> {
  const store = await loadStore(ctx.root);
  const remote = await fetchRemoteRequirementIssues(ctx);
  const remoteIssues = remote.snapshots;
  // 다른 세션에서 이미 만든 추적 이슈가 있으면 그것을 이어 쓴다(새로 만들지 않는다)
  if (!store.tracking && remote.tracking) store.tracking = { issue: remote.tracking.issue, url: remote.tracking.url ?? '' };
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const inputs = requirements.map((requirement) => ({
    requirement: toRequirementForIssues(requirement, store.byId[requirement.id]),
    status: statusById[requirement.id] ?? '미착수',
  }));
  const plan = planRequirementPublish(inputs, remoteIssues);

  const allLabels = new Set<string>([REQUIREMENT_LABEL]);
  for (const requirement of requirements) for (const label of requirementLabelSet(requirement, statusById[requirement.id] ?? '미착수')) allLabels.add(label);
  await ensureLabels(ctx.remote, [...allLabels], { token: ctx.token });

  const errors: Array<{ id: string; message: string }> = [];
  const createdThisRound: string[] = [];

  for (const entry of plan) {
    if (entry.checklistOnly || (entry.action !== 'create' && entry.action !== 'update' && entry.action !== 'reverify')) continue;
    const requirement = byId.get(entry.id);
    if (!requirement) continue;
    try {
      const record = store.byId[entry.id];
      const requirementForIssues = toRequirementForIssues(requirement, record);
      // 이슈 헤더의 rev=는 "몇 번째로 발행했나"가 아니라 파일의 개정 번호와 같게 쓴다(ADR-106, 버그 리포트 47 —
      // 발행 횟수와 파일 "개정"이 서로 다른 숫자로 보였다). 파일이 저장된 적 없이 처음 발행되면(드문 경우) 1로 본다
      const rev = requirement.rev ?? 1;
      const body = buildSubIssueBody(requirementForIssues, rev);
      const labels = requirementLabelSet(requirement, statusById[entry.id] ?? '미착수');

      let issueNumber: number;
      if (entry.action === 'create') {
        const created = await createIssue(ctx.remote, { title: subIssueTitle(requirement), body, labels }, { token: ctx.token });
        issueNumber = created.number;
        createdThisRound.push(entry.id);
      } else {
        issueNumber = entry.issue!;
        await updateIssue(ctx.remote, issueNumber, { body, labels, ...(entry.action === 'reverify' ? { state: 'open' as const } : {}) }, { token: ctx.token });
      }
      store.byId[entry.id] = { issue: issueNumber, rev, publishedHash: entry.localHash, publishedAt: new Date().toISOString() };
    } catch (error) {
      errors.push({ id: entry.id, message: describe(error) });
    }
  }

  try {
    const rows = requirements.map((requirement) => ({
      requirement,
      status: statusById[requirement.id] ?? ('미착수' as RequirementStatus),
      issue: store.byId[requirement.id]?.issue,
      checklistOnly: isChecklistOnly(requirement),
    }));
    const trackingBody = buildTrackingIssueBody(ctx.projectName, rows);
    if (store.tracking) {
      await updateIssue(ctx.remote, store.tracking.issue, { body: trackingBody, labels: [REQUIREMENT_LABEL] }, { token: ctx.token });
    } else {
      const created = await createIssue(ctx.remote, { title: trackingIssueTitle(ctx.projectName), body: trackingBody, labels: [REQUIREMENT_LABEL] }, { token: ctx.token });
      store.tracking = { issue: created.number, url: created.url };
    }
    if (ctx.remote.kind === 'github' && store.tracking) {
      for (const id of createdThisRound) {
        const issueNumber = store.byId[id]?.issue;
        if (issueNumber === undefined) continue;
        await addSubIssue(ctx.remote, store.tracking.issue, issueNumber, { token: ctx.token }).catch((error: unknown) => {
          errors.push({ id, message: `하위 이슈 연결 실패: ${describe(error)}` });
        });
      }
    }
  } catch (error) {
    errors.push({ id: '(추적 이슈)', message: describe(error) });
  }

  await saveStore(ctx.root, store);
  return { plan, summary: summarizeRequirementPlan(plan), tracking: store.tracking, errors };
}

export interface ConflictResolutionResult {
  action: ConflictResolution;
  /** action이 'import'일 때만 있다 — docs/requirements.md에 반영할지는 사람이 검토해 결정한다(자동으로 쓰지 않는다) */
  draft?: RequirementIssueDraft;
}

/**
 * 충돌(이슈가 GitHub에서 직접 수정됨) 하나를 해결한다.
 *  - overwrite(덮어쓰기): 로컬 내용으로 이슈 본문을 다시 쓴다
 *  - ignore(무시): 아무것도 쓰지 않고, 원격의 지금 내용을 새 기준선으로 받아들인다(다음 발행부터 다시 비교한다)
 *  - import(가져오기): 이슈 본문을 요구사항 초안으로 파싱해 돌려준다(파일에 쓰지 않는다 — 화면이 "요구사항 적용"으로 반영한다)
 */
export async function resolveRequirementConflict(
  ctx: RequirementIssuesContext,
  requirement: Requirement,
  status: RequirementStatus,
  resolution: ConflictResolution,
): Promise<ConflictResolutionResult> {
  const store = await loadStore(ctx.root);
  const record = store.byId[requirement.id];
  if (!record) throw new StudioError(404, `${requirement.id}은 아직 이슈로 발행되지 않아 충돌을 풀 것이 없습니다`);

  const remoteIssues = (await fetchRemoteRequirementIssues(ctx)).snapshots;
  const issue = remoteIssues.find((candidate) => candidate.number === record.issue);
  if (!issue) throw new StudioError(404, `이슈 #${record.issue}를 찾지 못했습니다`);
  const region = parseManagedRegion(issue.body);
  const remoteHash = region ? contentHash(region.content) : undefined;

  if (resolution === 'overwrite') {
    const requirementForIssues = toRequirementForIssues(requirement, record);
    // 발행과 같은 규칙: 이슈 헤더의 rev=는 파일의 개정 번호를 그대로 쓴다(ADR-106)
    const rev = requirement.rev ?? 1;
    const body = buildSubIssueBody(requirementForIssues, rev);
    await updateIssue(ctx.remote, record.issue, { body, labels: requirementLabelSet(requirement, status) }, { token: ctx.token });
    store.byId[requirement.id] = { issue: record.issue, rev, publishedHash: requirementContentHash(requirementForIssues), publishedAt: new Date().toISOString() };
    await saveStore(ctx.root, store);
    return { action: 'overwrite' };
  }

  if (resolution === 'ignore') {
    if (remoteHash !== undefined) {
      store.byId[requirement.id] = { ...record, publishedHash: remoteHash, rev: region?.rev ?? record.rev };
      await saveStore(ctx.root, store);
    }
    return { action: 'ignore' };
  }

  const draft = draftRequirementFromIssue(subIssueTitle(requirement), issue.body);
  if (remoteHash !== undefined) {
    store.byId[requirement.id] = { ...record, publishedHash: remoteHash, rev: region?.rev ?? record.rev };
    await saveStore(ctx.root, store);
  }
  return { action: 'import', draft };
}

export interface RequirementSyncEvidence {
  id: string;
  kind: string;
  priority: string;
  status: RequirementStatus;
  checkpoints: ReadonlyArray<{ shortSha: string }>;
  tests: ReadonlyArray<TestMatch>;
  gateChecks: ReadonlyArray<GateCheckResult>;
}

function evidenceRows(evidence: RequirementSyncEvidence): Array<{ scenario: string; test?: string; result: string; commit?: string; gate?: string }> {
  const commit = evidence.checkpoints[0]?.shortSha;
  const gate = evidence.gateChecks.map((check) => `${check.name}(${check.ok ? '통과' : '실패'})`).join(', ') || undefined;
  if (evidence.tests.length === 0) return [{ scenario: '(테스트 없음)', result: evidence.status, commit, gate }];
  return evidence.tests.map((test) => ({ scenario: test.name, test: test.file, result: evidence.status, commit, gate }));
}

export interface RequirementSyncResult {
  updated: string[];
  errors: Array<{ id: string; message: string }>;
}

/**
 * 발행된 하위 이슈마다 상태를 반영한다: 고정 댓글(시나리오·테스트·결과·커밋·게이트 표)을 편집하고 상태 라벨을 바꾼다.
 * `prMerged`가 참이면(이 세션의 PR이 병합됐다는 뜻 — 호출하는 쪽이 판단해 넘긴다) 검증됨인 요구사항의 하위 이슈를 닫는다.
 * 그 밖에는 이슈를 닫지 않는다("검증됨 + PR 병합" 둘 다 확인됐을 때만 닫는다 — `Closes #n`은 기본 브랜치 병합에서만 동작하므로
 * 이 함수가 그 조건을 한 번 더 확인하는 안전망이다).
 */
export async function syncRequirementIssueStatus(ctx: RequirementIssuesContext, evidences: readonly RequirementSyncEvidence[], { prMerged = false }: { prMerged?: boolean } = {}): Promise<RequirementSyncResult> {
  const store = await loadStore(ctx.root);
  const updated: string[] = [];
  const errors: Array<{ id: string; message: string }> = [];

  for (const evidence of evidences) {
    const record = store.byId[evidence.id];
    if (!record) continue;
    try {
      const comments = await listIssueComments(ctx.remote, record.issue, { token: ctx.token });
      const body = buildStatusComment(evidence.id, evidence.status, evidenceRows(evidence));
      const pinned = findPinnedStatusComment(comments, evidence.id);
      if (pinned) {
        if (pinned.body !== body) await updateComment(ctx.remote, pinned.id, body, { token: ctx.token });
      } else {
        await postComment(ctx.remote, record.issue, body, { token: ctx.token });
      }
      await updateIssue(ctx.remote, record.issue, { labels: requirementLabelSet(evidence, evidence.status) }, { token: ctx.token });
      if (prMerged && evidence.status === '검증됨') {
        await updateIssue(ctx.remote, record.issue, { state: 'closed' }, { token: ctx.token });
      }
      updated.push(evidence.id);
    } catch (error) {
      errors.push({ id: evidence.id, message: describe(error) });
    }
  }
  return { updated, errors };
}

/**
 * 요구사항 id마다 발행된 하위 이슈 번호를 찾는다(발행되지 않았으면 빠진다). 사이드카 파일만 읽어(원격·토큰 없이도 동작한다)
 * PR 본문의 `Closes #n`·AI 리뷰 문맥·"이 요구사항 작업" 프리필 조립에 쓴다.
 */
export async function publishedIssueNumbers(root: string, ids: readonly string[]): Promise<Record<string, number>> {
  const store = await loadStore(root);
  const result: Record<string, number> = {};
  for (const id of ids) {
    const issue = store.byId[id]?.issue;
    if (issue !== undefined) result[id] = issue;
  }
  return result;
}

/** 이 프로젝트가 발행한 요구사항 추적 이슈(사이드카의 tracking 필드). 없으면(아직 발행하지 않았으면) undefined */
export async function publishedTrackingIssue(root: string): Promise<{ issue: number; url: string } | undefined> {
  const store = await loadStore(root);
  return store.tracking;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
