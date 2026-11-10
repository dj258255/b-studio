import { createSdkMcpServer, query, type AccountInfo, type McpServerConfig, type ModelInfo, type Options, type SDKMessage, type SDKUserMessage, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

/**
 * Agent SDK를 바꿔 끼우는 지점. `claude-code` 러너는 SDK를 쓰지 않고 공개 CLI 입출력으로 돈다(claude-code-runner.ts, ADR-194).
 * 이 타입은 아직 SDK를 쓰는 탐색형 QA(explore-qa-claude-code.ts)만 쓴다.
 */
export interface ClaudeCodeSdk {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeCodeQuery;
  createSdkMcpServer(options: { name: string; version?: string; tools?: Array<SdkMcpToolDefinition<any>> }): McpServerConfig;
}

export interface ClaudeCodeQuery extends AsyncIterable<SDKMessage> {
  accountInfo(): Promise<AccountInfo>;
  /** 로그인한 계정이 실제로 쓸 수 있는 모델 목록(별칭이 풀리는 id·설명·노력 단계 지원 여부 포함) */
  supportedModels(): Promise<ModelInfo[]>;
  interrupt(): Promise<unknown>;
  close(): void;
}

export const DEFAULT_SDK: ClaudeCodeSdk = { query, createSdkMcpServer };
