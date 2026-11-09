/**
 * "현황" 탭(ADR-098)이 쓰는 순수 집계 함수. 세션·요구사항·체크포인트·작업 분해 레인처럼 이미 다른 화면이 읽는
 * 데이터를 모아 한 사람이 "지금 어디까지 왔는가"를 한 화면에서 읽을 수 있게 재배열하기만 한다 — 새로 측정하거나
 * 저장소에 쓰지 않는다(읽기 전용 집계). studio의 sessions.ts가 세션·요구사항 스냅샷에서 ProjectStatusInput
 * 모양으로 조립해 넘기고, 이 파일은 그 모양을 받아 화면이 바로 그릴 수 있는 ProjectStatusView로 바꾸기만 한다.
 *
 * 범수 님이 쓴 평가 기준의 "지금 어디까지 왔는가" 항목을 그대로 따른다: 지금 하는 일, 목적(요구사항·이슈),
 * 예상 완료(예상이 없으면 없다고 말한다 — 지어내지 않는다), 결과물, 위험·불확실성, 검증 기록, 예상 vs 실제.
 *
 * 집계는 Rust(`crates/bstudio-guard/src/project_status.rs`, ADR-191 3단계 3h)가 한다. 여기에는 타입과, 같은 이름·시그니처로 네이티브 모듈을 부르는 얇은 껍데기만 남았다.
 */
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';

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
  /** resolved: 라운드 상한에 걸렸지만 사람이 막는 지적을 모두 오탐으로 닫아 더는 막지 않는다(과제 67-b) — "위험"으로 보지 않는다 */
  reviewState?: { state: 'running' | 'passed' | 'capped' | 'stopped' | 'resolved'; rounds: number };
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

/** 세션·요구사항·체크포인트·레인 데이터를 "현황" 화면 모양으로 모은다. 모두 이미 있는 데이터를 재배열할 뿐, 새로 재지 않는다 */
export function buildProjectStatus(input: ProjectStatusInput): ProjectStatusView {
  return decodeNative<ProjectStatusView>(native.projectStatusBuild(encodeNative(input)));
}
