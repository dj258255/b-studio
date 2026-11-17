/**
 * 옛 터미널 요청·도구 입력 분류(ADR-215 이전). 새 코드(`session-terminal-classify.ts`, Rust `bstudio-session`의 `terminal::classify`)와 견주는 차등 시험의 기준으로만 남아 있다.
 * 4g에서 지운다. 옛 `sessions.ts`·`@b-studio/sandbox`(`agent-terminal.ts`)의 규칙을 그대로 옮겼다(부수 효과는 뺐다).
 *
 * 옛 모습 그대로의 틈도 옮겼다:
 * - 서버는 붙여 넣은 요청의 감싸개를 두 번 벗겼다(`terminalPromptSubmitted`가 한 번, `isReadOnlyPrompt`가 한 번). 컨테이너 안의 훅 스크립트는 한 번만 벗겼다
 * - 읽기 도구인가는 `AGENT_READ_TOOLS`와 `CODEX_READ_TOOLS` 두 표를 정확히 일치하는 이름으로 봤다
 */
const READ_ONLY_MARK = '[읽기만]';
const LEADING = String.raw`^[\s​-‏⁠﻿‪-‮⁦-⁩]+`;
const PASTED_OPEN = String.raw`<pasted_content(?:\s+id="[^"]*")?>\r?\n?`;
const PASTED_CLOSE = String.raw`\r?\n?</pasted_content(?:\s+id="[^"]*")?>`;

/** 옛 `unwrapPastedPrompt`: 감싸개 표시를 한 번 벗긴다 */
export function legacyUnwrapPastedPrompt(prompt: string): string {
  return prompt.replace(new RegExp(PASTED_OPEN, 'g'), '').replace(new RegExp(PASTED_CLOSE, 'g'), '');
}

/** 옛 `isReadOnlyPrompt`(sandbox): 한 번 벗기고 NFC로 맞춘 뒤 앞의 빈칸·보이지 않는 글자를 건너뛰어 표시로 시작하는가 */
export function legacyIsReadOnlyPrompt(prompt: string): boolean {
  return legacyUnwrapPastedPrompt(prompt).normalize('NFC').replace(new RegExp(LEADING), '').startsWith(READ_ONLY_MARK);
}

/** 옛 `terminalPromptSubmitted`가 읽던 요청 글: 한 번 벗기고 앞뒤 빈칸을 자른다(자르기 상한은 판정과 무관하다) */
export function legacyServerPrompt(raw: string): string {
  return legacyUnwrapPastedPrompt(raw).trim();
}

/** 옛 서버의 읽기만 판정: 위의 글에 `isReadOnlyPrompt`를 다시 불렀다(감싸개를 두 번 벗긴다) */
export function legacyServerReadOnly(raw: string): boolean {
  return legacyIsReadOnlyPrompt(legacyServerPrompt(raw));
}

/** 옛 서버의 `/` 명령 판정 */
export function legacyServerSlash(raw: string): boolean {
  return legacyServerPrompt(raw).startsWith('/');
}

/** 옛 `AGENT_READ_TOOLS`(Claude Code)와 `CODEX_READ_TOOLS` */
export const LEGACY_AGENT_READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch', 'AskUserQuestion', 'Agent', 'Task'] as const;
export const LEGACY_CODEX_READ_TOOLS = ['view_image', 'web_search', 'tool_search', 'request_user_input', 'update_plan', 'get_goal', 'create_goal', 'update_goal', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'] as const;

/** 옛 `terminalToolDecision`의 읽기 도구 칸 */
export function legacyIsReadTool(name: string): boolean {
  return (LEGACY_AGENT_READ_TOOLS as readonly string[]).includes(name) || (LEGACY_CODEX_READ_TOOLS as readonly string[]).includes(name);
}
