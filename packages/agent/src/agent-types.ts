import type Anthropic from '@anthropic-ai/sdk';
import type { Sandbox, StartOptions } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import type { Effort } from './anthropic-client';
import type { BrowserRunner } from './browser-check';
import type { ContextClearingPolicy } from './context-clearing';
import type { EscalationPolicy } from './escalation';
import type { GateOptions, PageFetcher, VerifyMode } from './gate';
import type { ExecutionPolicy } from './policy';
import type { SelfCheckMode } from './tool-output';
import type { AskUserQuestion, BoardAccess, RequestMismatch, ToolContext } from './tools';
import type { ContractFetcher, VerificationReport } from './verify';
import type { WorkflowCheck } from './workflow';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaTool = Anthropic.Beta.BetaTool;

export interface AgentRequest {
  system: string;
  tools: BetaTool[];
  messages: BetaMessageParam[];
}

export interface ModelClientInfo {
  provider: 'anthropic' | 'openai' | 'google' | 'scripted';
  backend: string;
  model: string;
  auth?: string;
  /** 이 호출에 실제로 적용한 노력 단계. 클라이언트가 노력 단계를 지원하지 않으면(openai·google 호환 클라이언트) 없다 */
  effort?: Effort;
}

export type ModelPreflight = { ok: true } | { ok: false; reason: string };

/** 모델 호출을 추상화한다. 실제 Claude 클라이언트와 오프라인 검증용 스크립트 모델이 같은 루프를 쓴다 */
export interface ModelClient {
  readonly info?: ModelClientInfo;
  preflight?(): Promise<ModelPreflight>;
  createMessage(request: AgentRequest, signal?: AbortSignal): Promise<BetaMessage>;
}

/**
 * 실행 중 지시 큐. 스튜디오가 채우고 러너가 꺼내 간다. 꺼내는 시점은 러너마다 다르다
 * (API 루프·Codex는 다음 모델 호출 직전, 로컬 Claude는 입력 큐에 들어올 때).
 * 어떤 러너든 도구 호출 도중에 끼어들지 않고, 지금 하던 도구 호출이 끝난 뒤에만 반영한다.
 */
export interface Steering {
  /** 쌓인 지시를 꺼내 비운다 */
  take(): string[];
  /**
   * 지시가 들어올 때 알린다(선택). 모델 호출 지점을 직접 잡을 수 없는 로컬 Claude 러너가
   * 입력 큐에 대기 없이 넣는 데 쓴다. 없으면 러너가 짧은 주기로 take()를 부른다.
   * 돌려준 함수로 구독을 해제한다.
   */
  onPush?(listener: () => void): () => void;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 요청 하나를 처리하며 관찰한 실행 지표. 토큰 합계(usage)와 달리 호출 횟수·입력 크기·단계별 시간을 남긴다 */
export interface RunMetrics {
  /** client.createMessage 호출 횟수 */
  modelCalls: number;
  /** 호출 한 번의 입력 크기(input+cache_read+cache_creation) 중 최댓값 */
  maxContextTokens: number;
  /**
   * 모델 호출에 걸린 시간 합. **없으면 "재지 않음"이다(0초와 다르다).**
   * api 백엔드는 createMessage 호출을 직접 잰다. 로컬 Claude Code 러너는 SDK가 결과에 실어 주는 API 호출 시간 합(duration_api_ms)을 쓴다 —
   * 부가 호출까지 더한 값이라 벽시계 시간보다 클 수 있다. 호출 경계가 보이지 않는 러너(Codex·Gemini CLI)는 비워 둔다
   */
  modelMs?: number;
  /** executeTool 실행 시간 합 */
  toolMs: number;
  /** gate.check() 실행 시간 합 */
  gateMs: number;
  /** 승격이 일어났다면 몇 번째 게이트 시도(실패) 뒤였는지. 승격이 없으면 없다 */
  escalatedAt?: number;
  /**
   * 모델 이름(또는 id)별 사용량. 승격 등으로 실행 중 모델이 바뀌면 모델별 비용을 나누어 계산할 수 있게 한다.
   * 모델을 구분할 수 없는 러너는 채우지 않는다
   */
  usageByModel?: Record<string, AgentUsage>;
  /** 프로젝트 지침(AGENTS.md, ADR-077)이 시스템 프롬프트에 더한 글자 수. 파일이 없거나 꺼져 있으면 없다(고정 문맥 비용을 눈에 보이게 한다) */
  guideChars?: number;
}

export interface AgentResult {
  /** awaiting_input: 에이전트가 질문을 남기고 멈춰, 사용자 답을 다음 요청으로 기다린다 */
  status: 'done' | 'failed' | 'awaiting_input';
  /**
   * 가장 최근 게이트 검증의 결과(게이트가 한 번도 돌지 않았으면 없다). 질문을 남기고 멈춘 실행(awaiting_input)은 직전에
   * 게이트를 한 번 돌리지만 그 결과와 무관하게 멈춘다. 호출자는 이 값이 'pass'일 때만 그 변경을 체크포인트로 남겨야 한다 —
   * report.ok(재시작·계약 검증)는 선언한 체크(테스트·화면 확인·리뷰)의 실패를 담지 않는다
   */
  gateOutcome?: 'pass' | 'retry' | 'exhausted';
  summary: string;
  changedFiles: string[];
  /** awaiting_input이면 사용자의 답을 기다리는 질문 */
  question?: AskUserQuestion;
  /** 마지막 검증 게이트 결과 */
  report?: VerificationReport;
  /** 마지막 검증에서 플랫폼이 실행한 화면 확인·테스트·리뷰 */
  checks?: WorkflowCheck[];
  /** 마지막 검증에서 통과한 워크플로 검증 단계 */
  passedStages?: import('@b-studio/spec').WorkflowStage[];
  /**
   * 게이트가 검증한, 도구를 거치지 않고 바뀐 파일의 지문(프로젝트 기준 경로 → 지문). 게이트를 통과한 결과에만 싣는다.
   * 세션이 체크포인트를 남기기 전에 스테이징될 내용이 검증한 내용과 같은지 견주는 데 쓴다(StagedMismatchError).
   * 도구 밖 변경을 게이트에 넘긴 러너만 채운다
   */
  verifiedFingerprints?: Record<string, string>;
  /** 'light'(가볍게 확인)면 테스트·화면 확인·동시 요청·리뷰를 건너뛰었다. full이면 없다 */
  verify?: VerifyMode;
  /** light에서 건너뛴 검증 단계(workflow.required 대조에서 실패로 보지 않음) */
  skippedStages?: import('@b-studio/spec').WorkflowStage[];
  verifyAttempts: number;
  turns: number;
  usage: AgentUsage;
  /** 실행 지표. 로컬 Claude Code 러너는 모델 호출을 직접 보지 못해 채우지 않는다 */
  metrics?: RunMetrics;
  /**
   * status가 'failed'일 때만 뜻이 있다. 'max_turns'면 턴 상한에 걸려 끝났다는 뜻이다(ADR-131).
   * 되돌리기 자체(보관 뒤 삭제)는 다른 실패 사유와 같지만, 턴 상한은 되돌리기 전에 게이트를 한 번 더 돌려
   * 지금까지의 변경이 통과하면 실패 대신 체크포인트로 남긴다(recheckGateOnMaxTurns). 그래도 통과하지 못하면
   * 이 표시를 달고 실패로 끝나, 다른 실패 사유와 똑같이 보관·되돌리기 경로를 탄다.
   * 'network'면 일시적 네트워크 오류(ENOTFOUND 등)로 재시도했지만 상한(횟수·총 대기 시간) 안에 복구되지 않아 끝났다는
   * 뜻이다(ADR-142). 로컬 Claude Code 러너만 채운다(이어받기가 가능한 세션 id가 있어야 재시도할 수 있다).
   */
  failureReason?: 'max_turns' | 'network';
  /**
   * status가 'done'일 때만 뜻이 있다. 'max_turns'면 턴 상한에 닿았지만 그때의 변경이 게이트를 통과해 체크포인트로 남긴
   * 실행이다(ADR-131). 턴 상한은 모델이 다음 도구를 부르려는 순간에 걸리므로, 게이트가 통과했어도 요청은 끝나지 않았을 수
   * 있다 — 세션이 체크포인트에 표시를 남기고(Workflow-Incomplete), 올리기 전 미리보기가 그것을 알린다
   */
  incomplete?: 'max_turns';
  /**
   * 에이전트가 report_mismatch로 알린 요청과 확인의 어긋남(#666, ADR-182). 있으면 호출자는 done이어도 "확인 필요"로 보인다.
   * 게이트 판정과 체크포인트는 바꾸지 않는다(상태를 낮추기만 한다). 보고가 없으면 필드가 없다
   */
  mismatches?: RequestMismatch[];
}

export type AgentEvent =
  /** 실제로 요청을 처리하는 실행 환경. 로컬 Claude Code처럼 모델과 인증을 밖에서 정할 때 알린다 */
  | { type: 'session'; backend: string; model: string; auth?: string; effort?: Effort }
  | {
      type: 'route';
      selectedId: string;
      reason: string;
      complexity: 'simple' | 'normal' | 'complex';
      risk: 'normal' | 'high';
      candidates: Array<{ id: string; label: string; eligible: boolean; score: number; estimatedCostUsd?: number }>;
      /** claude-code 'auto' 선택(ADR-091)이 낸 결정이면 true. api 라우터(ADR-047)의 점수 비교와 화면 표현이 다르다(한 줄 안내) */
      auto?: boolean;
    }
  | { type: 'turn'; turn: number }
  /** 이번 실행에서 지금까지 쓴 토큰 누적값. 직접 만든 루프는 모델 응답마다, 로컬 Claude Code는 턴을 끝낼 때마다 온다 */
  | { type: 'tokens'; usage: AgentUsage }
  /**
   * 턴 하나의 모델 요청 사용량. 실행 누적값(tokens)과 달리 그 턴 한 번의 값이라 "어느 턴에서 컨텍스트가 커졌는지" 볼 수 있다.
   * contextTokens = input + cacheRead + cacheWrite (한 요청이 모델에 보낸 입력 크기).
   */
  | { type: 'turn_usage'; turn: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; contextTokens: number }
  /**
   * 직전 턴의 컨텍스트가 임계치를 넘어 오래된 도구 결과를 묶어서 비웠다.
   * clearedCount: 표시 문구로 바꾼 도구 결과 수, clearedChars: 그때 줄어든 글자 수
   */
  | { type: 'context_cleared'; turn: number; clearedCount: number; clearedChars: number }
  /**
   * 로컬 CLI 러너가 이어받은 대화가 길어져 앞부분을 요약으로 바꿨다(SDK의 compact_boundary).
   * trigger: auto는 자동 압축, manual은 사용자가 보낸 압축. preTokens는 압축 직전, postTokens는 압축 직후 크기(모르면 없다)
   */
  | { type: 'context_compacted'; trigger: 'auto' | 'manual'; preTokens: number; postTokens?: number; durationMs?: number }
  /**
   * 로컬 CLI 러너가 대화 앞부분을 요약하기 시작했다(SDK의 status: 'compacting'). 큰 대화는 몇 분이 걸리고 그동안 턴이 없으므로,
   * 화면이 멈춘 것처럼 보이지 않게 알린다. 끝나면 context_compacted가 온다
   */
  | { type: 'context_compacting' }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  /** chars: 모델에 간 글자 수(자르기·반복 대체 뒤). rawChars: 자르기 전 원래 글자 수. 토큰 탭이 이 둘로 낭비를 찾는다 */
  | { type: 'tool_result'; name: string; ok: boolean; content: string; chars?: number; rawChars?: number }
  | { type: 'policy'; tool: string; decision: 'allow' | 'deny'; reason?: string }
  /** ask_user가 남긴 질문. 실행은 이 턴 뒤에 끝난다 */
  | { type: 'question'; question: string; options: string[]; allowOther: boolean; proposal?: import('./tools').ModeProposal }
  /** report_mismatch가 남긴 어긋남(#666). 실행은 이어 간다 */
  | ({ type: 'mismatch' } & RequestMismatch)
  | { type: 'stage'; stage: import('@b-studio/spec').WorkflowStage; source: 'platform' | 'agent' }
  /** 진행 중 지시를 다음 모델 호출 전에 대화에 넣었다 */
  | { type: 'steer_applied'; count: number }
  /** 게이트의 실패 서명이 같은 값으로 반복돼 더 비싼 모델로 올렸다 */
  | { type: 'model_escalated'; from: string; to: string; attempt: number; signature: string; sameSignatureTimes: number }
  /**
   * 실행은 이어가지만 사람이 알면 좋은 사실. 지금은 두 가지다.
   *  - 이어받기를 요청했는데 상태 폴더가 없어 새 대화로 시작한다(구독 CLI 러너)
   *  - 이 러너가 모델 승격을 지원하지 않아 옵션을 무시했다
   */
  | { type: 'warning'; message: string }
  | { type: 'workflow_check'; check: WorkflowCheck }
  | { type: 'verify_start'; files: string[] }
  /**
   * 서비스 재시작·준비 판정·계약까지의 결과다. moreChecks면 이 뒤에 선언 검사·리뷰(workflow_check)가 더 돌고 끝에 gate_done이 온다.
   * moreChecks가 없는 기록(서비스 확인 실패, 이 필드가 생기기 전의 옛 기록)은 이 결과가 곧 게이트의 끝이다
   */
  | { type: 'verify_result'; report: VerificationReport; text: string; moreChecks?: boolean }
  /** moreChecks인 verify_result 뒤의 선언 검사·리뷰까지 끝났다. ok는 게이트 전체의 통과 여부(#1155) */
  | { type: 'gate_done'; ok: boolean }
  | { type: 'done'; result: AgentResult }
  | { type: 'failed'; result: AgentResult };

export interface RunAgentOptions {
  request: string;
  /**
   * 요구사항 문서의 기준 내용: 마지막 체크포인트에 커밋된 docs/requirements.md(그때 문서가 없었으면 null).
   * 넘기면 게이트가 "실행을 시작할 때의 디스크"가 아니라 이것과 견준다(ADR-157). 실행을 시작할 때의 디스크에는 앞선 실행이
   * 체크포인트 없이 남긴 변경이 들어 있을 수 있다 — 사람 확인을 써넣고 질문으로 멈춘 실행의 다음 실행이 그 예다.
   * 넘기지 않으면(체크포인트를 모르는 호출자) 실행을 시작할 때의 디스크를 기준으로 쓴다
   */
  requirementsBaseline?: string | null;
  /**
   * 이전 요청부터 이어지는 대화 기록. 넘기면 이번 실행의 메시지가 여기에 이어 붙는다.
   * 실행 중 예외가 나면 이번 실행분은 되돌려 다음 요청이 깨진 대화로 시작하지 않게 한다.
   */
  conversation?: BetaMessageParam[];
  /**
   * 실행 도중 들어온 지시를 꺼내는 큐. 주면 다음 모델 호출 직전에 take()해 대화에 넣는다.
   * 도구 호출 도중에는 끼어들지 않고, 도구 결과가 대화에 들어간 뒤 다음 호출 전에만 반영한다.
   */
  steering?: Steering;
  project: LoadedProject;
  sandbox: Sandbox;
  client: ModelClient;
  /**
   * 게이트 실패 서명이 `sameSignatureTimes`번 반복되면 이후 호출을 `client`로 바꾼다.
   * 주지 않으면 지금처럼 한 모델로 끝까지 돈다(승격 없음). 한 번 올리면 다시 올리지 않는다.
   */
  escalation?: EscalationPolicy & { client: ModelClient };
  /** 요청이 필드·엔드포인트 삭제나 타입 변경을 명시할 때만 true */
  allowBreaking?: boolean;
  /** ask: 질문 모드. 파일을 바꾸는 도구를 거부하고, 바뀐 파일이 없으므로 검증 게이트를 돌리지 않는다 */
  intent?: 'build' | 'ask';
  /**
   * "조사" 모드(intent가 ask일 때만 뜻이 있다). 이 직접 만든 루프(모델은 api 백엔드)는 웹 도구가 없으므로
   * 요청 앞에 "웹 검색을 지원하지 않아 모델 지식으로 답한다"는 안내만 한 번 더 붙인다(claude-code 러너만 실제로 연다)
   */
  research?: boolean;
  maxTurns?: number;
  /** 검증 게이트 실패를 몇 번까지 모델에게 돌려줄지 */
  maxVerifyAttempts?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** 검증 게이트나 도구가 서비스를 재시작할 때의 상태. 재시작하면 호스트 포트가 바뀌므로 미리보기가 따라가야 한다 */
  onServiceStatus?: StartOptions['onStatus'];
  fetcher?: ContractFetcher;
  pageFetcher?: PageFetcher;
  browserRunner?: BrowserRunner;
  /** 화면 확인 스크린샷을 저장하고 식별자를 돌려준다. 저장은 호출자가 한다 (agent는 파일 위치를 모른다) */
  saveArtifact?: GateOptions['saveArtifact'];
  /** true면 ask_user 도구를 넣는다. 단일 세션의 사용자 요청에만 켠다(레인·벤치·CLI는 기본 false) */
  interactive?: boolean;
  /** 도구 호출을 실행기에서 통제하는 정책 */
  policy?: ExecutionPolicy;
  /**
   * 컨텍스트가 커졌을 때 오래된 도구 결과를 묶어서 비우는 정책. **기본은 끔**(효과를 재기 전).
   * `B_STUDIO_CONTEXT_CLEARING=on`이면 기본 정책으로 켠다. `false`로 넘기면 환경 변수보다 우선해 끈다.
   * Claude Code·Codex 러너는 대화를 직접 다루지 않는다(각 CLI가 자체 압축을 한다). 이 옵션은 쓰지 않는다.
   */
  contextClearing?: ContextClearingPolicy | false;
  approvalToken?: string;
  requestApproval?: ToolContext['requestApproval'];
  /** 레인 조율 게시판. 주면 read_notes·(모델이 쓰는 전략이면) post_note 도구가 목록에 오른다 */
  board?: BoardAccess;
  /**
   * 이번 실행이 시작되기 전에 이미 작업 트리에 있던 변경(프로젝트 루트 기준 경로, 보관본 되살리기·사람의 직접
   * 수정 등 — 출처를 가리지 않는다). 에이전트 도구가 이번 실행에서 손대지 않아도 게이트가 검증 대상으로 보게
   * workspace에 동기화한다(ADR-131 되살리기 미검증 체크포인트 사고 재발 방지). 호출하는 쪽이 세션의 실제
   * git 작업 트리 상태(checkpoints.pendingFiles())로 채운다
   */
  externalChanges?: readonly string[];
  /**
   * 도구를 거치지 않고 바뀐 파일(CLI 내장 도구·서비스 안 명령 등)을 게이트가 보게 한다. 주면 게이트가 check()마다
   * 이 목록을 작업 공간으로 옮기고, 통과한 결과에 검증한 내용의 지문(verifiedFingerprints)을 싣는다
   */
  outsideChanges?: GateOptions['outsideChanges'];
  /**
   * 선언한 시험이 실패했을 때 변경 전 기준(마지막 체크포인트)에서 같은 시험을 다시 돌려 피드백에 라벨을 붙이는 기준(이슈 #1435).
   * 주지 않으면 라벨은 "변경 전 결과 모름"이다. 통과·실패 판정은 이 값과 무관하다
   */
  baseline?: GateOptions['baseline'];
  /**
   * 샌드박스를 지금 켠다(지연 기동 세션). 주면 게이트를 실행 시작 때 만들지 않고, 첫 파일 변경·샌드박스 도구 때
   * 그때 켠 뒤에 만든다 — 계약 기준을 샌드박스가 켜진 뒤, 변경 전에 잡기 위해서다. 없으면 지금처럼 시작할 때 만든다
   */
  ensureSandbox?: () => Promise<void>;
  /**
   * 검증 범위(기본 full). light(가볍게 확인)면 게이트가 서비스 재시작·준비 판정·계약만 돌리고
   * 테스트·화면 확인·동시 요청·리뷰는 건너뛴다. 건너뛴 단계는 결과의 skippedStages로 남는다
   */
  verify?: VerifyMode;
  /** 사용자가 이 요청에서 확인 선언의 변경을 허용했다(ADR-164). 켜면 게이트가 바뀐 선언으로 검증한다. 사람이 보낸 요청에서만 켠다 */
  allowCheckChanges?: boolean;
  /**
   * 자가 확인 범위(기본 full). lean이면 프롬프트가 게이트와 겹치는 확인(전체 빌드·테스트, 끝난 변경의 재시작·HTTP 확인)을
   * 하지 말라고 안내하고, 성공한 run_in_service 출력을 짧게 돌려준다
   */
  selfCheck?: SelfCheckMode;
}
