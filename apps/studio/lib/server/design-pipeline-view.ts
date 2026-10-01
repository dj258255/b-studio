/**
 * "요구사항" 탭의 "파이프라인" 하위 화면이 보는 값을 조립한다(ADR-100).
 * 요구사항 → 설계 → 작업 묶음 → 구현 → 검토 → 검증 단계를 설계 문서(design-pipeline.ts)·작업 계획(task-plans.ts)·
 * 세션 스냅샷(sessions.ts)에서 있는 그대로 모으기만 한다 — 새로 저장하는 값은 설계 문서 자체(초안·승인·작업 묶음)뿐이다.
 * design-pipeline.ts는 task-plans.ts를 모르게 두고(순환 참조 방지), 조립은 이 파일이 맡는다.
 */
import { deriveDesignPipelineResult, extractRequirementIds, type DesignDocRecord, type DesignPipelineBundleActual, type DesignPipelineResult, type DesignPipelineReviewInput, type DesignPipelineVerificationInput } from '@b-studio/agent';
import type { Checkpoint } from '@b-studio/agent';
import type { TaskPlanLaneView, TaskPlanView } from '@/lib/task-plan-types';
import type { ReviewStateView, SessionSnapshot } from '@/lib/studio-events';
import { getSnapshot } from './sessions';
import { listSessionDesignDocs } from './design-pipeline';
import { listTaskPlans } from './task-plans';
import { StudioError } from './errors';

export interface DesignPipelineDocView {
  design: DesignDocRecord;
  /** 이 설계와 요구사항이 겹치는 작업 계획(나눠서 병렬로 하기) id들 */
  linkedTaskPlanIds: string[];
  bundleActuals: DesignPipelineBundleActual[];
  review?: DesignPipelineReviewInput;
  verification?: DesignPipelineVerificationInput;
  implementationCheckpointExists: boolean;
  result: DesignPipelineResult;
}

/** 작업 계획의 요청이 이 설계의 요구사항 범위와 겹치는지 */
function planMatchesDesign(plan: TaskPlanView, requirementIds: readonly string[]): boolean {
  if (requirementIds.length === 0) return false;
  const mentioned = new Set(extractRequirementIds(plan.request));
  return requirementIds.some((id) => mentioned.has(id));
}

/** 레인 하나의 실제 소요 시간(분). 작업별 run.durationMs 합이 있으면 그것을, 없으면 시작~끝 시각 차이를 쓴다 */
function laneActualMinutes(lane: TaskPlanLaneView): number | undefined {
  const fromTasks = lane.tasks.reduce((sum, task) => sum + (task.run?.durationMs ?? 0), 0);
  if (fromTasks > 0) return Math.round(fromTasks / 60_000);
  if (lane.startedAt && lane.finishedAt) return Math.round((new Date(lane.finishedAt).getTime() - new Date(lane.startedAt).getTime()) / 60_000);
  return undefined;
}

/** 작업 묶음을 도는 동안 모델이 승격(에스컬레이션)됐는지의 거친 신호: 한 작업이 모델을 두 개 이상 썼으면 승격이 있었다고 본다 */
function laneEscalated(lane: TaskPlanLaneView): boolean {
  return lane.tasks.some((task) => Object.keys(task.run?.metrics?.usageByModel ?? {}).length > 1);
}

/** 설계 문서의 작업 묶음을 쓰기 범위가 겹치는 레인에 매칭해 예상 vs 실제를 나란히 둔다. 매칭이 없으면 실제 값 없이 돌려준다 */
function matchBundleActuals(design: DesignDocRecord, linkedPlans: readonly TaskPlanView[]): DesignPipelineBundleActual[] {
  const lanes = linkedPlans.flatMap((plan) => plan.lanes);
  return design.bundles.map((bundle) => {
    const lane = lanes.find((candidate) => candidate.paths.some((path) => bundle.writableScope.includes(path)));
    if (!lane) return { bundle };
    return {
      bundle,
      actualMinutes: laneActualMinutes(lane),
      coder: { sessionId: lane.sessionId, backend: lane.backend, model: lane.model, escalated: laneEscalated(lane) },
    };
  });
}

/** 설계 승인 뒤, 게이트(직접 수정·문서 체크포인트가 아닌)를 거친 체크포인트가 있으면 구현이 "완료"됐다고 본다 */
function hasImplementationCheckpoint(design: DesignDocRecord, snapshot: SessionSnapshot, linkedPlans: readonly TaskPlanView[]): boolean {
  if (linkedPlans.some((plan) => plan.status === 'done')) return true;
  if (!design.approvedAt) return false;
  const approvedAt = new Date(design.approvedAt).getTime();
  return snapshot.checkpoints.some((checkpoint) => checkpoint.passedStages !== undefined && checkpoint.verify !== 'docs' && new Date(checkpoint.createdAt).getTime() >= approvedAt);
}

/** 설계 승인 뒤의 체크포인트 중 가장 최근 것으로 검증(테스트 재실행 포함) 입력을 만든다. 없으면 "검증을 다시 돌리지 못했다" */
function latestVerification(design: DesignDocRecord, snapshot: SessionSnapshot): DesignPipelineVerificationInput | undefined {
  if (!design.approvedAt) return undefined;
  const approvedAt = new Date(design.approvedAt).getTime();
  const candidates = snapshot.checkpoints.filter(
    (checkpoint): checkpoint is Checkpoint & { createdAt: string } => checkpoint.passedStages !== undefined && checkpoint.verify !== 'docs' && new Date(checkpoint.createdAt).getTime() >= approvedAt,
  );
  const latest = candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) return { ran: false, ok: false, testsRerun: false };
  return { ran: true, ok: true, testsRerun: (latest.passedStages ?? []).includes('test') };
}

/** 세션의 리뷰 상태를 파이프라인 입력으로 바꾼다. 아직 리뷰를 부른 적이 없으면 undefined(검토 못 함으로 표시된다) */
function reviewInputFromState(review: ReviewStateView | undefined): DesignPipelineReviewInput | undefined {
  if (!review) return undefined;
  // 라운드를 한 번도 진행하지 못하고 바로 멈췄으면(백엔드가 리뷰를 지원하지 않음 등) "검토를 돌리지 못했다"로 본다
  const ran = review.rounds.length > 0;
  const findingsCount = review.rounds.at(-1)?.findings?.length;
  return {
    ran,
    passed: review.state === 'passed',
    independence: review.independence ?? 'unknown',
    ...(findingsCount !== undefined ? { findingsCount } : {}),
    ...(review.reviewerModelId ? { reviewerLabel: review.reviewerModelId } : {}),
  };
}

/** 설계 파이프라인 전체 보기: 이 세션의 설계 문서마다 요구사항·작업 묶음·구현·검토·검증 단계를 모아 "완료" vs "성공"을 보여 준다 */
export async function getSessionDesignPipeline(id: string): Promise<DesignPipelineDocView[]> {
  const snapshot = getSnapshot(id);
  if (!snapshot) throw new StudioError(404, '세션을 찾을 수 없습니다');
  const designDocs = await listSessionDesignDocs(id);
  if (designDocs.length === 0) return [];

  // 리뷰 독립성(구현 계열 vs 검토 계열)은 runReviewRound가 리뷰를 돌릴 때 이미 계산해 session.snapshot.review.independence에
  // 남긴다(sessions.ts) — 여기서는 그 값을 그대로 읽기만 한다(modelFamily를 다시 부르지 않는다)
  const plans = listTaskPlans(snapshot.owner ?? '').filter((plan) => plan.sourceSessionId === id);

  return designDocs.map((design) => {
    const linkedPlans = plans.filter((plan) => planMatchesDesign(plan, design.requirementIds));
    const implementationCheckpointExists = hasImplementationCheckpoint(design, snapshot, linkedPlans);
    const review = reviewInputFromState(snapshot.review);
    const verification = latestVerification(design, snapshot);
    return {
      design,
      linkedTaskPlanIds: linkedPlans.map((plan) => plan.id),
      bundleActuals: matchBundleActuals(design, linkedPlans),
      ...(review ? { review } : {}),
      ...(verification ? { verification } : {}),
      implementationCheckpointExists,
      result: deriveDesignPipelineResult({ design, implementationCheckpointExists, review, verification }),
    };
  });
}
