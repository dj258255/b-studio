/**
 * `studio desk`가 스튜디오 API에서 받는 값의 꼴. 스튜디오 코드(apps/studio)를 가져오지 않고 필요한 필드만 적는다 —
 * desk는 스튜디오의 얇은 손님이고, 옛 서버가 주지 않는 필드(terminal·gate·costUsd)는 없을 수 있다
 */

/** `/api/agents` 항목(AgentItem)에서 desk가 쓰는 것 */
export interface DeskItem {
  kind: 'session' | 'lane' | 'fleet';
  /** 세션 id. 계획 승인 대기는 `plan:<id>`라 세션이 아니다 */
  id: string;
  title: string;
  projectName: string;
  state: 'working' | 'idle' | 'booting' | 'dormant' | 'stopped' | 'done' | 'error';
  attention?: string;
  backend?: string;
  lastActivityAt: string;
  /** 터미널 세션일 때: CLI가 떠 있는가, 권한을 묻고 있는가 */
  terminal?: { cli: 'up' | 'down'; waiting?: 'permission' };
  /** 게이트: 지금 검증 중인가, 마지막 판정, 체크포인트 수 */
  gate?: { state: 'verifying' | 'passed' | 'failed' | 'none'; checkpoints: number };
  /** 세션 누적 비용(달러) */
  costUsd?: number;
  /** 세션 토큰 합 */
  tokens?: DeskUsage;
  /** 터미널 CLI의 메인·서브에이전트별 내역(#843). 옛 서버는 주지 않는다 */
  agents?: DeskAgent[];
  /** 이 에이전트가 할 수 있는 범위(#843) */
  capabilities?: DeskCapabilities;
  /** 세션을 띄운 AI 계정(#885). 기본 계정이면 없다 — 그 CLI의 기본 계정(id가 CLI 이름)이다 */
  accountId?: string;
}

export interface DeskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 에이전트 내역 한 행(스튜디오 terminal-agents.ts의 TerminalAgentRow와 같은 꼴) */
export interface DeskAgent {
  id: string;
  name: string;
  kind: 'main' | 'subagent';
  state: 'working' | 'done' | 'idle';
  activity?: string;
  tokens: DeskUsage;
  costUsd?: number;
}

export interface DeskCapabilities {
  backend: string;
  model?: string;
  tools: string[] | 'cli-default';
  writeScope: string;
  permission: string;
}

export interface DeskOverview {
  items: DeskItem[];
}

export interface DeskProject {
  id: string;
  name: string;
  error?: string;
}

/** 세션 터미널 통로의 메시지(session-terminal.ts의 TerminalMessage와 같은 꼴) */
export type DeskTerminalMessage =
  | { kind: 'data'; data: string }
  | { kind: 'status'; state: 'closed' | 'opening' | 'open'; message?: string }
  | { kind: 'exit'; code: number | null }
  | { kind: 'cli'; alive: boolean }
  | { kind: 'warning'; message: string };

/** 새 요청을 터미널로 보낸 결과(#836) */
/** AI 계정 하나(#885, GET /api/ai-accounts). builtin이면 파일에 없는 처음 기본 계정이다 */
export interface DeskAccount {
  id: string;
  name: string;
  backend: string;
  configDir?: string;
  sprite?: string;
  builtin?: boolean;
}

/** 계정 하나의 로그인 상태(#890, GET /api/ai-accounts/{id}/status). 각 CLI의 상태 확인 명령으로 잰다 */
export interface DeskAccountStatus {
  connected: boolean;
  installed: boolean;
  /** 아는 계정 종류(예: "Max 구독") */
  accountKind?: string;
  /** 연결되지 않았을 때 사람이 할 일 */
  reason?: string;
}

/** 로그인 진행(스튜디오 cli-accounts.ts의 LoginProgress에서 desk가 쓰는 것) */
export interface DeskLoginProgress {
  state: 'running' | 'exited' | 'cancelled' | 'timeout';
  lines: string[];
  url?: string;
  code?: string;
  exitCode?: number | null;
  error?: string;
  /** 끝난 뒤 다시 잰 상태 */
  status?: DeskAccountStatus;
}

/** 로그인 시작의 답. spawnable이 아니면(대화형 CLI) 사람이 칠 명령만 온다 */
export interface DeskLoginStart {
  spawnable: boolean;
  progress?: DeskLoginProgress;
  command?: string;
  note?: string;
}

/** 라우팅 규칙(스튜디오 lib/backend-rules.ts와 같은 꼴, #822·#885) */
export interface DeskRuleWhen {
  intent?: 'build' | 'ask';
  complexity?: Array<'simple' | 'normal' | 'complex'>;
  risk?: 'high' | 'normal';
  keywords?: string[];
}

export interface DeskRuleTarget {
  backend: string;
  model?: string;
  accountId?: string;
}

export interface DeskRule extends DeskRuleTarget {
  when: DeskRuleWhen;
}

export interface DeskRules {
  rules: DeskRule[];
  fallback?: DeskRuleTarget;
}

/** GET /api/routing/rules. 옛 스튜디오는 rules를 주지 않을 수 있다 */
export interface DeskRulesView {
  rules?: DeskRules;
  /** 저장한 규칙을 쓰지 못한 까닭 */
  error?: string;
  allowed: string[];
  defaultBackend: string;
}

export interface DeskStartResult {
  session: { id: string };
  routing?: { backend?: string; model?: string; matched?: string };
  terminal?: { opened: boolean; pasted: boolean; pasteError?: string };
  /** 세션은 만들었지만 터미널을 열지 못했거나(CLI 없음 등) 설계 승인 검사에 막혔다 */
  sendError?: string;
}

/** 미리보기(`/api/routing/preview`) */
export interface DeskPreview {
  backend: string;
  model?: string;
  rule: number | 'fallback' | 'default' | 'direct';
  matched: string;
  records?: Array<{ backend: string; passed: number; judged: number }>;
}

/** 사용량 한도 창 하나(5시간·주간). 카드의 막대로 보인다(#887). 채우는 쪽은 사용량 수집(#886·#889)이다 */
export interface DeskLimitWindow {
  /** 쓴 비율(0~100) */
  usedPercent: number;
  /** 다시 차는 때(ISO 8601) */
  resetsAt?: string;
}

export interface DeskLimits {
  fiveHour?: DeskLimitWindow;
  weekly?: DeskLimitWindow;
}

/** 계정의 한도 상태: ok 여유, warn 주의, exhausted 다 씀, idle 쉬는 중, unknown 모름(읽지 못함·꺼 둠), unsupported 해당 없음 */
export type DeskLimitStatus = 'ok' | 'warn' | 'exhausted' | 'idle' | 'unknown' | 'unsupported';

/** 계정 하나의 사용량 한도(GET /api/usage/limits, #886·#889). 스튜디오 usage-limits.ts의 AccountLimits에 이름·그림을 붙인 꼴 */
export interface DeskAccountLimits {
  id: string;
  backend: string;
  /** 계정 이름(기본 계정은 "기본"). 옛 서버는 주지 않는다 */
  name?: string;
  /** 그림 폴더 안의 그림 파일 이름 */
  sprite?: string;
  builtin?: boolean;
  plan?: string;
  status: DeskLimitStatus;
  windows: Array<{ kind: 'five_hour' | 'weekly' | 'other'; usedPercent: number; resetsAt?: string; minutes?: number }>;
  source: string;
  /** 마지막으로 읽은 시각(ISO) */
  fetchedAt?: string;
  /** 이번에 읽지 못해 지난 값을 보여 주는 중 */
  stale?: boolean;
  /** 읽지 못한 까닭 */
  error?: string;
  recommended?: boolean;
}
