export type TaskPlanStatus = 'planning' | 'awaiting_approval' | 'running' | 'integrating' | 'interrupted' | 'done' | 'failed' | 'rejected';
export type TaskPlanStepStatus = 'queued' | 'booting' | 'running' | 'done' | 'failed' | 'skipped';

export interface TaskPlanCheckpointView {
  sha: string;
  shortSha: string;
  files: string[];
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
  lanes: TaskPlanLaneView[];
  integration?: TaskPlanIntegrationView;
  error?: string;
}
