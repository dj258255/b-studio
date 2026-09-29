import type { AgentUsage, BoardStats, NoteKind, PlanBackend, RunMetrics, Topology } from '@b-studio/agent';
import type { TaskPlanMetrics } from './task-plan-metrics';

export type TaskPlanStatus = 'planning' | 'awaiting_approval' | 'running' | 'integrating' | 'interrupted' | 'done' | 'failed' | 'rejected';
export type TaskPlanStepStatus = 'queued' | 'booting' | 'running' | 'done' | 'failed' | 'skipped';

/** 레인 간 조율 전략. S0·S1은 공유 없음(기존)이라 여기 없다 */
export type TaskPlanStrategy = 'S2' | 'S3' | 'S4' | 'S5';

/** 게시판 메모 하나(화면·기록용). Board의 Note에서 작성자와 id를 평평하게 폈다 */
export interface TaskPlanNoteView {
  kind: NoteKind;
  body: string;
  refs: string[];
  lane: string;
  task?: string;
  by: 'model' | 'platform';
  /** 계층 구조(hierarchical)의 그룹. 작성 레인의 첫 쓰기 범위 */
  group?: string;
  priority: number;
  at: string;
}

export interface TaskPlanBoardView {
  notes: TaskPlanNoteView[];
  stats: BoardStats;
}

/** S4에서 통합 게이트가 실패한 뒤 한 번 시도한 모델 수리 */
export interface TaskPlanRepairView {
  attempted: boolean;
  status: string;
  run?: TaskPlanRunMetricsView;
}

export interface TaskPlanCheckpointView {
  sha: string;
  shortSha: string;
  files: string[];
}

/** 한 실행(작업·통합)이 남긴 지표. 로컬 Claude Code 러너처럼 지표가 없으면 usage만 있다 */
export interface TaskPlanRunMetricsView {
  /** run_finished status */
  status: string;
  durationMs?: number;
  usage?: AgentUsage;
  metrics?: RunMetrics;
}

export interface TaskPlanTaskView {
  id: string;
  title: string;
  request: string;
  paths: string[];
  dependsOn: string[];
  /** 이 작업을 돌릴 세션 백엔드(고정 계획만). 없으면 서버 모드 */
  backend?: PlanBackend;
  /** 이 작업에 고정한 모델(백엔드마다 뜻이 다르다) */
  model?: string;
  status: TaskPlanStepStatus;
  summary?: string;
  checkpoint?: TaskPlanCheckpointView;
  /** 이 작업 실행의 지표 (실패한 작업도 기록한다) */
  run?: TaskPlanRunMetricsView;
}

export interface TaskPlanLaneView {
  id: string;
  /** 레인이 쓰는 세션. 세션을 만들기 전이면 없다 */
  sessionId?: string;
  /** 이 레인 세션의 백엔드·모델(레인 작업들이 공유한다). 없으면 서버 모드 */
  backend?: PlanBackend;
  model?: string;
  /** 레인 세션의 작업 폴더. 세션이 사라진 뒤에도 통합이 결과를 다시 읽을 수 있게 남긴다 */
  workDir?: string;
  /** 레인이 바꾼 파일 (세션 시작 체크포인트를 뺀 체크포인트들의 파일 합집합, 정렬) */
  changedFiles?: string[];
  paths: string[];
  status: TaskPlanStepStatus;
  tasks: TaskPlanTaskView[];
  error?: string;
  /** 세션 생성부터 준비까지 걸린 시간 */
  bootMs?: number;
  /** 기동 중 이 레인 세션이 받은 바이트(서비스 합). 못 읽었으면 없다 */
  bootRxBytes?: number;
  /** 세션을 만들기 직전 시각 */
  startedAt?: string;
  /** 레인이 성공·실패로 끝난 시각 */
  finishedAt?: string;
}

/** 원격 저장소에 올린 이슈 하나 */
export interface TaskPlanIssueRef {
  number: number;
  url: string;
}

/** 승인 뒤 원격 저장소에 올린 추적 이슈와 작업별 하위 이슈 */
export interface TaskPlanIssuesView {
  /** 계획 전체를 나타내는 추적 이슈 */
  tracking?: TaskPlanIssueRef;
  /** 작업 id → 하위 이슈 */
  tasks: Record<string, TaskPlanIssueRef>;
  /** 이슈를 올리다 실패한 이유. 실패해도 계획 실행·상태 전이는 바뀌지 않는다 */
  error?: string;
}

export interface TaskPlanIntegrationView {
  sessionId?: string;
  status: TaskPlanStepStatus;
  /** 레인들에서 모아 다시 적용한 파일 */
  files: string[];
  /** 레인들이 지워 통합에서 함께 지운 파일 */
  deleted: string[];
  checkpoint?: TaskPlanCheckpointView;
  error?: string;
  /** 통합 세션 생성부터 준비까지 걸린 시간 */
  bootMs?: number;
  /** 기동 중 통합 세션이 받은 바이트(서비스 합). 못 읽었으면 없다 */
  bootRxBytes?: number;
  /** 통합 실행의 지표 */
  run?: TaskPlanRunMetricsView;
  /** S4: 통합 게이트가 실패해 모델에 수리를 한 번 요청한 기록 */
  repair?: TaskPlanRepairView;
  /** 통합 세션을 만들기 직전 시각 */
  startedAt?: string;
  /** 통합이 끝난 시각 */
  finishedAt?: string;
}

/** 계획 모델이 받은 레인 사이 계약(B_STUDIO_PLAN_CONTRACTS). 받지 못했으면 warning이 있다(계약 없이 진행) */
export interface TaskPlanContractsView {
  source: 'model' | 'human';
  count: number;
  /** 계약 호출의 usage와 걸린 시간. 사람이 쓴 계약(벤치 고정 계약)은 호출이 없어 없다 */
  usage?: AgentUsage;
  durationMs?: number;
  /** 계약을 받지 못했을 때의 한 줄 경고(이유 포함) */
  warning?: string;
}

export interface TaskPlanView {
  id: string;
  owner: string;
  projectId: string;
  request: string;
  modelId: string;
  status: TaskPlanStatus;
  createdAt: string;
  finishedAt?: string;
  /** 계획을 승인한 사용자와 시각 */
  approvedBy?: string;
  approvedAt?: string;
  /** 거부한 사유 (있으면) */
  rejectedReason?: string;
  /** 계획 호출의 usage와 걸린 시간 */
  planning?: { usage: AgentUsage; durationMs: number };
  /** 계획 모델이 레인 사이 계약을 썼는가(S2로 게시). 설정이 꺼져 있거나 레인이 하나면 없다 */
  contracts?: TaskPlanContractsView;
  /** 모델에게 계획을 받지 않고 서버 안에서 고정했다(벤치마크·테스트). 이때는 planning이 없다 */
  preset?: true;
  /** 계획 전체 합계 지표 */
  metrics?: TaskPlanMetrics;
  /** 조율 전략과 topology. 서버 안에서만 정한다(HTTP 라우트는 받지 않는다) */
  coordination?: { strategy: TaskPlanStrategy; topology: Topology };
  /** 조율 게시판 상태(메모 목록과 통계). 조율을 켠 계획에만 있다 */
  board?: TaskPlanBoardView;
  lanes: TaskPlanLaneView[];
  integration?: TaskPlanIntegrationView;
  /** 승인 때 "이슈로 올리기"를 골랐을 때 만든 추적 이슈·하위 이슈 */
  issues?: TaskPlanIssuesView;
  error?: string;
}
