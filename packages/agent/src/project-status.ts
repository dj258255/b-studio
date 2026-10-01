/**
 * "현황" 탭(ADR-098)이 쓰는 순수 집계 함수. 세션·요구사항·체크포인트·작업 분해 레인처럼 이미 다른 화면이 읽는
 * 데이터를 모아 한 사람이 "지금 어디까지 왔는가"를 한 화면에서 읽을 수 있게 재배열하기만 한다 — 새로 측정하거나
 * 저장소에 쓰지 않는다(읽기 전용 집계). studio의 sessions.ts가 세션·요구사항 스냅샷에서 ProjectStatusInput
 * 모양으로 조립해 넘기고, 이 파일은 그 모양을 받아 화면이 바로 그릴 수 있는 ProjectStatusView로 바꾸기만 한다.
 *
 * 범수 님이 쓴 평가 기준의 "지금 어디까지 왔는가" 항목을 그대로 따른다: 지금 하는 일, 목적(요구사항·이슈),
 * 예상 완료(예상이 없으면 없다고 말한다 — 지어내지 않는다), 결과물, 위험·불확실성, 검증 기록, 예상 vs 실제.
 */

export interface ProjectStatusRequirementRef {
  id: string;
  title: string;
  priority: 'must' | 'should' | 'could';
  /** requirements.ts의 RequirementStatus 문자열 그대로('미착수'·'작업 중'·'검증됨'·'재확인 필요'·'실패') */
  status: string;
  issue?: number;
}

/** 작업 분해 레인 하나의 지금 상태(task-plans.ts의 TaskLane이 쓰는 status 문자열을 그대로 받는다) */
export interface ProjectStatusLaneRef {
  id: string;
  label: string;
  status: string;
}

/** 작업 하나의 예상·실제 시간(분). 지금 시스템에 "예상 시간" 입력이 없는 작업은 estimateMinutes를 생략한다 — 지어내지 않는다 */
export interface ProjectStatusEstimate {
  id: string;
  label: string;
  estimateMinutes?: number;
  actualMinutes?: number;
  /** 예상과 실제가 다른 이유(사람이 적는다) */
  note?: string;
}

export interface ProjectStatusCheckpointRef {
  shortSha: string;
  message: string;
  createdAt: string;
}

export interface ProjectStatusInput {
  projectName: string;
  /** 지금 처리 중인 요청이 있는가 */
  running: boolean;
  /** running이면 그 요청의 짧은 설명(있으면) */
  currentRequestSummary?: string;
  /** 이 세션이 작업 분해 계획의 레인·통합이면 그 레인들의 지금 상태. 아니면 생략 */
  lanes?: readonly ProjectStatusLaneRef[];
  requirements: readonly ProjectStatusRequirementRef[];
  /** 에이전트가 되물어 멈춘 질문(있으면) */
  openQuestion?: string;
  /** "사람이 할 일" 절에 남아 있는 항목(에이전트가 절대 하지 않는 절차) */
  manualSteps: readonly string[];
  /** 최근 체크포인트가 먼저 오도록 호출하는 쪽이 정렬해 넘긴다 */
  checkpoints: readonly ProjectStatusCheckpointRef[];
  pullRequestUrl?: string;
  reviewState?: { state: 'running' | 'passed' | 'capped' | 'stopped'; rounds: number };
  /** 지금 failed 상태인 서비스 이름들 */
  failedServices: readonly string[];
  /** 작업별 예상·실제 시간. 작업 분해 계획에 예상 시간 입력이 없으면 생략(undefined) — "추정 없음"으로 보여준다 */
  estimates?: readonly ProjectStatusEstimate[];
  links: { roadmap: string; changelog: string; docsIndex: string };
}

export interface ProjectStatusView {
  currentWork: { summary: string; items: readonly string[] };
  purpose: { items: ReadonlyArray<{ id: string; title: string; issue?: number }> };
  eta: { hasEstimate: boolean; summary: string };
  deliverables: { checkpoints: readonly ProjectStatusCheckpointRef[]; pullRequestUrl?: string };
  risks: { items: readonly string[] };
  verification: { summary: string; byStatus: Readonly<Record<string, number>> };
  estimateVsActual: ReadonlyArray<{ id: string; label: string; estimateMinutes?: number; actualMinutes?: number; deltaMinutes?: number; note?: string }>;
  links: { roadmap: string; changelog: string; docsIndex: string };
}

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
export function buildProjectStatus(input: ProjectStatusInput): ProjectStatusView {
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
