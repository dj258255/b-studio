import { native } from '@b-studio/sandbox';

/**
 * 세션 터미널의 요청·도구 입력 분류(ADR-215, 4f B5a). 판정은 Rust `crates/bstudio-session`의 `terminal::classify`가 한다(순수 함수).
 * 여기는 글을 코어에 넘기고 결과를 TS 값으로 돌려주는 껍데기다. 옛 판정은 지웠다(#1347).
 *
 * 부르는 자리마다 막는 쪽인지 여는 쪽인지:
 * - `readOnly`: 읽기만을 놓치는 것이 여는 쪽이다(읽기만 요청의 쓰기가 허용된다). 코어가 의심스러우면 읽기만으로 읽는다
 * - `slashCommand`: 요청 시작에서 "CLI 안에서 끝나는 명령"을 가른다. 참이면 실행을 열지 않고 토큰 한도 거절도 건너뛴다(그 칸의 값이 `/`로 시작하는 글뿐이다)
 * - `isReadTool`: 쓰기 직전 훅의 앞 칸이다. 참이면 아무것도 기다리지 않고 허용한다(여는 쪽). 정확히 일치하는 이름만 참이고 모르는 이름은 거짓이다
 */

export interface PromptClass {
  /** 읽기만 요청이다 */
  readOnly: boolean;
  /** 감싸개를 한 번 벗기고 자른 글이 `/`로 시작한다 */
  slashCommand: boolean;
  /** 붙여 넣은 요청의 감싸개를 한 번 벗기고 앞뒤 빈칸을 자른 글 */
  unwrapped: string;
}

/**
 * 코어는 Rust 문자열만 받는다. 짝 없는 서로게이트(JS 문자열에는 있다)는 U+FFFD로 바꿔 넘긴다 — 표시와 상관없는 자리라 판정은 같고, 넘기다 던지지 않는다
 */
export function classifyPrompt(text: string): PromptClass {
  return native.terminalClassifyPrompt(text.toWellFormed());
}

/** 읽기만 요청인가 */
export function isReadOnlyPrompt(text: string): boolean {
  return classifyPrompt(text).readOnly;
}

/** 파일을 바꾸지 않는 도구인가(Claude Code와 Codex의 읽기 도구 표) */
export function isReadTool(name: string): boolean {
  return native.terminalIsReadTool(name.toWellFormed());
}

/** 갈래별 읽기 도구인가. 새 갈래(commandcode·opencode·gemini)는 자기 표만 본다. 모르는 갈래는 거짓이다 */
export function isReadToolFor(kind: string, name: string): boolean {
  return native.terminalIsReadToolFor(kind, name.toWellFormed());
}

/**
 * 읽기만이 앞선 변경이 있는 실행에 이어 켜질 때 턴 끝이 읽기만 지름길을 타지 않게 표시하는가(S6, ADR-212).
 * `changedBefore`가 `undefined`면 변경 목록을 읽지 못한 것이라 있는 것으로 본다(막는 쪽)
 */
export function readOnlyAfterWork(alreadyReadOnly: boolean, verificationStarted: boolean, changedBefore: boolean | undefined): boolean {
  return native.terminalReadOnlyAfterWork(alreadyReadOnly, verificationStarted, changedBefore === undefined ? 2 : changedBefore ? 1 : 0);
}

/** 쓰기 직전 훅이 도구 입력을 읽는 갈래. claude·codex 말고는 아직 세션 만들기에서 닿지 않는다(실험) */
export type TerminalToolKind = 'claude' | 'codex' | 'commandcode' | 'opencode' | 'gemini';

/** OpenCode가 파일을 바꾸는 도구: 입력에 `filePath`가 있어야 한다. 없으면 어느 파일인지 알 수 없다 */
const OPENCODE_FILE_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'multiedit']);
/**
 * Gemini CLI가 파일을 바꾸는 도구와 받는 열쇠 표(0.71.1의 도구 정의, ADR-242): `write_file`은 {file_path, content}, `replace`는 {file_path, instruction, old_string, new_string, allow_multiple}다.
 * 경로 열쇠는 `file_path` 하나이고 별칭이 없다. 표에 없는 열쇠가 하나라도 있으면 도구 쪽이 그것을 어떻게 읽는지 알 수 없으므로 null이다(허용 목록에 넣을 값이라 모르는 값은 막는다)
 */
const GEMINI_FILE_INPUT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  write_file: new Set(['file_path', 'content']),
  replace: new Set(['file_path', 'instruction', 'old_string', 'new_string', 'allow_multiple']),
};
/** Gemini의 서브에이전트 도구(`invoke_agent`). 안의 도구 호출이 훅을 거치는지는 소스로만 읽었다(실행으로 확인하지 못했다): 바꾸는 파일을 알 수 없는 것으로 본다 */
const GEMINI_NESTED_TOOLS: ReadonlySet<string> = new Set(['invoke_agent']);
/**
 * OpenCode 파일 도구가 받는 열쇠 표(설치된 1.18.33의 도구 정의, ADR-241): `edit`는 {filePath, oldString, newString, replaceAll?}, `write`는 {filePath, content}다.
 * 경로 열쇠는 `filePath` 하나뿐이고 별칭이 없다. 그래도 표에 없는 열쇠가 하나라도 있으면 도구 쪽이 그것을 어떻게 읽는지 알 수 없으므로 null이다(허용 목록에 넣을 값이라 모르는 값은 막는다).
 * `multiedit`은 1.18.33에 없다(옛 판의 {filePath, edits}). 있어도 같은 규칙이다
 */
const OPENCODE_FILE_INPUT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  edit: new Set(['filePath', 'oldString', 'newString', 'replaceAll']),
  write: new Set(['filePath', 'content']),
  multiedit: new Set(['filePath', 'edits']),
};
/** Command Code가 파일을 바꾸는 도구(설치된 v1.93.4의 도구 정의와 별칭 표에서 확인, ADR-233): 입력에 경로(정식 이름 `file_path`나 별칭)가 있어야 한다. 없으면 어느 파일인지 알 수 없다 */
const COMMAND_CODE_FILE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);
/**
 * Command Code의 파일 도구가 받는 열쇠 표(설치된 v1.93.4의 `yv` 별칭 표와 두 도구의 입력 스키마, ADR-233).
 * CLI는 도구를 부르기 전에 입력의 별칭을 정식 이름으로 고쳐 쓰는데(`renameAliasedField`: 정식 이름이 비었으면 입력 객체에서 먼저 나온 별칭을 쓴다),
 * mod의 `beforeToolCall`에는 **고치기 전 원본 입력**이 온다. 그래서 우리는 정식 이름과 별칭을 모두 본다. 표에 없는 열쇠가 하나라도 있으면 판이 바뀐 것이라 경로를 알 수 없다(null).
 */
const COMMAND_CODE_PATH_KEYS: readonly string[] = ['file_path', 'path', 'absolutePath', 'absolute_path', 'filePath', 'filepath', 'pathname', 'target_file', 'targetFile', 'fileName', 'file_name', 'filename'];
const PATH_KEY_SET: ReadonlySet<string> = new Set(COMMAND_CODE_PATH_KEYS);
const COMMAND_CODE_FILE_INPUT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  write_file: new Set([...COMMAND_CODE_PATH_KEYS, 'content', 'text', 'body', 'data', 'contents', 'fileContent']),
  edit_file: new Set([
    ...COMMAND_CODE_PATH_KEYS,
    ...['old_string', 'oldValue', 'oldString', 'old', 'old_str', 'oldStr', 'from', 'old_value', 'oldText', 'old_text', 'oldContent', 'old_content'],
    ...['new_string', 'newValue', 'newString', 'new', 'new_str', 'newStr', 'to', 'new_value', 'newText', 'new_text', 'newContent', 'new_content'],
    ...['replace_all', 'replaceAll', 'replaceall', 'all', 'replacement_count', 'replacementCount', 'count'],
  ]),
};
/** CLI가 경로 값에서 벗겨 내는 마크다운 링크(`[글](경로)`, cli.mjs `stripMarkdownLinkFromPath`) */
const MARKDOWN_LINK = /^\[[^\]]*\]\(([^)]+)\)$/;

/**
 * commandcode의 `write_file`·`edit_file` 입력에서 바꿀 파일을 **모두** 꺼낸다. 허용 목록(카드의 쓰기 범위)에 넣을 값이라 모르는 값은 null이다:
 * 입력이 객체가 아님, 표에 없는 열쇠가 있음, 경로 열쇠의 값이 글이 아님, 경로가 하나도 없음.
 * 경로 열쇠가 둘 이상이고 값이 달라도 하나로 고르지 않고 모두 낸다 — CLI가 어느 것을 쓰는지는 객체의 열쇠 순서와 판에 달려 있어 우리가 따라 맞추면 틀린다.
 * 부르는 쪽이 모두 범위 안일 때만 통과시킨다(어느 것을 써도 범위 안). 빈 글(`""`)은 CLI도 건너뛰는 자리라 건너뛴다
 */
function commandCodeFilePaths(tool: string, input: unknown): string[] | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const known = COMMAND_CODE_FILE_INPUT_KEYS[tool];
  if (!known) return null;
  for (const key of Object.keys(record)) if (!known.has(key)) return null;
  const paths: string[] = [];
  const add = (value: string): void => {
    if (!paths.includes(value)) paths.push(value);
  };
  for (const key of Object.keys(record)) {
    if (!PATH_KEY_SET.has(key)) continue;
    const value = record[key];
    if (typeof value !== 'string') return null;
    if (value.trim() === '') continue;
    add(value);
    const unwrapped = MARKDOWN_LINK.exec(value.trim())?.[1];
    if (unwrapped !== undefined && unwrapped.trim() !== '') add(unwrapped);
  }
  return paths.length > 0 ? paths : null;
}

/**
 * Command Code가 서브에이전트를 띄우는 도구. 서브에이전트 안의 도구 호출은 mod의 쓰기 직전 훅을 거치지 않으므로(ADR-233) 이 도구가 바꿀 파일은 알 수 없다.
 * 문서가 두 이름을 쓴다(`agent`, `task`): 더 맞추면 더 막을 뿐이다
 */
const COMMAND_CODE_NESTED_TOOLS: ReadonlySet<string> = new Set(['agent', 'task']);
/** 패치 본문을 받는 도구 */
const PATCH_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'patch']);
/** 우리가 아는 패치 줄: 파일 머리글(경로를 낸다)과 그 밖의 표시 */
const PATCH_FILE_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.*)$/;
const PATCH_MARKER = /^\*\*\* (?:Begin Patch|End Patch|End of File)$/;

/**
 * 패치 본문에서 바꾸는 파일을 모두 꺼낸다. **알아보지 못하면 null이다**(경로가 하나도 없거나, 경로가 빈 머리글이 있거나, `***`로 시작하는데 아는 줄이 아닌 줄이 있다).
 * 놓친 파일이 있을 수 있는 패치를 "경로 없음"으로 읽으면 허용 목록이 열린다. 모든 갈래의 패치 도구가 이 하나를 쓴다(옛 느슨한 `applyPatchPaths`는 앞뒤 공백이 있는 머리글을 놓쳤다)
 */
function strictPatchPaths(patch: unknown): string[] | null {
  if (typeof patch !== 'string') return null;
  const paths: string[] = [];
  for (const raw of patch.split('\n')) {
    // CLI의 패치 읽기처럼 줄 앞뒤 공백(`\r` 포함)을 다듬은 줄로 맞춘다. 우리가 덜 다듬으면 CLI는 바꾸는데 우리는 못 본 파일이 생긴다
    const line = raw.trim();
    const header = PATCH_FILE_HEADER.exec(line);
    if (header) {
      const file = header[1]!.trim();
      if (file === '') return null;
      paths.push(file);
    } else if (line.startsWith('***') && !PATCH_MARKER.test(line)) {
      return null;
    }
  }
  return paths.length > 0 ? paths : null;
}

/**
 * Gemini의 파일 도구(`write_file`·`replace`)가 바꿀 경로. 도구는 경로를 `resolveDefensiveToolPath`로 한 번 더 고쳐 쓴다: NUL을 지우고,
 * 글자 그대로의 파일이 없으면 앞의 `@`를 떼어 낸다. 우리가 본 글과 도구가 쓰는 곳이 달라지는 모양(NUL·앞의 `@`)은 어느 파일인지 알 수 없는 것(null)으로 본다.
 * 입력이 객체가 아니거나 열쇠 표에 없는 열쇠가 있거나 경로가 글이 아니거나 비어 있어도 null이다
 */
function geminiFilePaths(tool: string, input: unknown): string[] | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const known = GEMINI_FILE_INPUT_KEYS[tool]!;
  if (Object.keys(record).some((key) => !known.has(key))) return null;
  const value = record.file_path;
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') || value.trimStart().startsWith('@')) return null;
  return [value];
}

/**
 * 터미널 도구 입력에서 파일 경로를 꺼낸다(쓰기 직전의 훅). 경로가 없는 도구면 빈 목록, **알 수 없으면 null**이다.
 * 허용 목록(카드의 쓰기 범위)에 넣을 값이라 null을 빈 목록처럼 통과시키지 않는다: 부르는 쪽이 범위 밖으로 막는다.
 * - claude: `file_path`·`notebook_path`의 첫 값. codex: `apply_patch`의 `command` 본문(엄격하게 읽고 모르면 null)
 * - opencode: `filePath`(edit·write·multiedit은 없으면 null, 도구 정의에 없는 열쇠가 하나라도 있어도 null), `apply_patch`·`patch`는 `patchText`를 엄격하게 읽는다
 * - gemini: 파일 도구(`write_file`·`replace`)는 `file_path`만 꺼내고(`geminiFilePaths`: 모르는 열쇠·NUL·앞의 `@`면 null), 서브에이전트 도구(`invoke_agent`)는 늘 null이다
 * - commandcode·gemini(그 밖의 도구): 알려진 경로 키(`file_path`·`filePath`·`path`·`notebook_path`)를 모두 낸다(더 꺼내면 더 막는다). 패치 도구는 본문을 읽지 못하면 null.
 *   commandcode의 파일 도구(`write_file`·`edit_file`)는 정식 이름과 별칭 열쇠를 모두 꺼내고(`commandCodeFilePaths`), 표에 없는 열쇠가 있거나 경로를 하나도 꺼내지 못해도 null이다(입력이 객체가 아니어도). 서브에이전트 도구(`agent`·`task`)는 늘 null이다.
 *   셸 도구처럼 경로가 없는 도구는 빈 목록이다
 */
export function terminalToolFilePaths(kind: TerminalToolKind, tool: string, input: unknown): string[] | null {
  // 서브에이전트 도구는 입력과 상관없이 바꾸는 파일을 알 수 없다. 빈 목록으로 읽으면 카드의 쓰기 범위가 그 안의 쓰기에 열린다
  if (kind === 'commandcode' && COMMAND_CODE_NESTED_TOOLS.has(tool)) return null;
  // 파일 도구는 정식 이름과 별칭 열쇠를 모두 읽는다(아래 표). 모르는 열쇠가 있으면 null
  if (kind === 'commandcode' && COMMAND_CODE_FILE_TOOLS.has(tool)) return commandCodeFilePaths(tool, input);
  if (kind === 'gemini' && GEMINI_NESTED_TOOLS.has(tool)) return null;
  if (kind === 'gemini' && Object.hasOwn(GEMINI_FILE_INPUT_KEYS, tool)) return geminiFilePaths(tool, input);
  if (kind === 'claude' || kind === 'codex') {
    // 패치 도구는 본문을 엄격하게 읽는다. 읽지 못하면 바꾸는 파일을 알 수 없다(옛 코드는 빈 목록이거나 느슨한 추출이라 쓰기 범위를 비켜 갔다)
    if (PATCH_TOOLS.has(tool)) {
      const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).command : undefined;
      return strictPatchPaths(body);
    }
    if (typeof input !== 'object' || input === null) return [];
    const record = input as Record<string, unknown>;
    for (const key of ['file_path', 'notebook_path']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return [value];
    }
    return [];
  }
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  if (PATCH_TOOLS.has(tool)) {
    if (!record) return null;
    if (kind === 'opencode') return strictPatchPaths(record.patchText);
    return strictPatchPaths(record.patchText ?? record.command);
  }
  if (!record) return OPENCODE_FILE_TOOLS.has(tool) && kind === 'opencode' ? null : [];
  if (kind === 'opencode') {
    const known = Object.hasOwn(OPENCODE_FILE_INPUT_KEYS, tool) ? OPENCODE_FILE_INPUT_KEYS[tool] : undefined;
    if (known && Object.keys(record).some((key) => !known.has(key))) return null;
    const value = record.filePath;
    if (typeof value === 'string' && value.trim() !== '') return [value];
    return OPENCODE_FILE_TOOLS.has(tool) ? null : [];
  }
  const paths: string[] = [];
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') paths.push(value);
  }
  return paths;
}
