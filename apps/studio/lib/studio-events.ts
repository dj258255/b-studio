import type { AgentEvent } from '@b-studio/agent';

/** 브라우저와 서버가 주고받는 형태. 서버 전용 객체(샌드박스, 프로세스)는 담지 않는다 */

export type SessionStatus = 'starting' | 'ready' | 'failed' | 'stopped';
export type ServiceState = 'starting' | 'probing' | 'ready' | 'failed';

export interface ServiceView {
  name: string;
  template: string;
  preview: 'browser' | 'openapi' | 'logs';
  state: ServiceState;
  /** 준비된 서비스의 주소. 재시작하면 포트가 바뀐다 */
  url?: string;
  detail?: string;
  hasContract: boolean;
}

export interface SessionSnapshot {
  id: string;
  projectId: string;
  projectName: string;
  /** 세션용 작업 복사본 위치 */
  workDir: string;
  status: SessionStatus;
  error?: string;
  mode: 'claude' | 'demo';
  running: boolean;
  services: ServiceView[];
  /** 데모 모드에서 다음에 실행할 수 있는 요청 */
  nextDemoRequest?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  services: Array<{ name: string; template: string; preview: string }>;
  error?: string;
}

export type StudioEvent =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'status'; status: SessionStatus; error?: string }
  | { type: 'service'; service: string; state: ServiceState; url?: string; detail?: string }
  | { type: 'log'; service: string; text: string; at: string }
  | { type: 'run_started'; runId: string; request: string }
  | { type: 'agent'; runId: string; event: AgentEvent }
  | {
      type: 'run_finished';
      runId: string;
      status: 'done' | 'failed' | 'error';
      summary: string;
      turns?: number;
      nextDemoRequest?: string;
    };

export interface ProxyResponse {
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
  durationMs: number;
}
