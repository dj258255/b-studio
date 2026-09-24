import type { AgentUsage, RunMetrics } from '@b-studio/agent';
import type { TaskPlanMetrics } from './task-plan-metrics';

export type TaskPlanStatus = 'planning' | 'awaiting_approval' | 'running' | 'integrating' | 'interrupted' | 'done' | 'failed' | 'rejected';
export type TaskPlanStepStatus = 'queued' | 'booting' | 'running' | 'done' | 'failed' | 'skipped';

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
  /** 세션을 만들기 직전 시각 */
  startedAt?: string;
  /** 레인이 성공·실패로 끝난 시각 */
  finishedAt?: string;
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
  /** 통합 실행의 지표 */
  run?: TaskPlanRunMetricsView;
  /** 통합 세션을 만들기 직전 시각 */
  startedAt?: string;
  /** 통합이 끝난 시각 */
  finishedAt?: string;
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
  /** 계획 전체 합계 지표 */
  metrics?: TaskPlanMetrics;
  lanes: TaskPlanLaneView[];
  integration?: TaskPlanIntegrationView;
  error?: string;
}
