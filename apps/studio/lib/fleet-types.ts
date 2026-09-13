import type { AgentUsage } from '@b-studio/agent';

export type FleetMemberStatus = 'booting' | 'running' | 'done' | 'failed' | 'error' | 'cancelled';

export interface FleetMemberView {
  sessionId: string;
  modelId: string;
  label: string;
  provider: string;
  status: FleetMemberStatus;
  runId?: string;
  summary?: string;
  turns?: number;
  usage?: AgentUsage;
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
