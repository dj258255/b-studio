import type { AgentUsage } from '@b-studio/agent';
import type { SessionMode } from './studio-events';

export type FleetMemberStatus = 'booting' | 'running' | 'done' | 'failed' | 'error' | 'cancelled' | 'awaiting_input';

/**
 * Fleet 후보 하나. backend마다 model의 뜻이 다르다:
 * api는 모델 레지스트리 id, CLI는 그 CLI에 넘길 모델 이름(id·`--model` 값), 없으면 서버·계정 기본.
 * 기존 API 입력(모델 id 목록)은 `{ backend: 'api', model: <id> }`와 같다.
 */
export interface FleetCandidate {
  backend: SessionMode;
  model?: string;
}

export interface FleetMemberView {
  sessionId: string;
  /** 이 멤버가 도는 백엔드. 이 필드가 생기기 전 기록은 api다(load할 때 채운다) */
  backend: SessionMode;
  /** 후보가 고른 모델. api면 모델 레지스트리 id(비용 계산에 쓴다), CLI면 그 CLI의 모델 이름. 없으면 그 백엔드의 기본 */
  modelId?: string;
  label: string;
  /** api는 모델 제공자, CLI는 백엔드 이름 */
  provider: string;
  status: FleetMemberStatus;
  runId?: string;
  summary?: string;
  turns?: number;
  usage?: AgentUsage;
  /** 실행 중 모델이 바뀌었으면(승격) 모델별 사용량. 토큰 탭과 같은 표기로 보여 준다 */
  usageByModel?: Record<string, AgentUsage>;
  costUsd?: number;
  checkpoint?: { sha: string; shortSha: string; files: string[] };
  startedAt?: string;
  finishedAt?: string;
}

export interface FleetView {
  id: string;
  owner: string;
  projectId: string;
  projectName: string;
  request: string;
  allowBreaking: boolean;
  createdAt: string;
  winnerSessionId?: string;
  members: FleetMemberView[];
}
