/**
 * 조율 게시판을 외부 에이전트(다른 Claude Code 세션, herdr, Codex CLI 등)에 MCP 도구 두 개로 연다.
 * tools.ts가 레인에 주는 post_note·read_notes와 이름·입력 모양이 같다 — 모델이 보는 쪽에서는 레인이든
 * 외부 토큰이든 같은 도구로 보인다. 신원(BoardAccess.lane)은 토큰을 내준 쪽이 정하고, 모델도 이 파일도
 * 바꾸지 않는다 — tools.ts의 laneBoard()와 같은 원칙이다.
 */
import type { Board, NoteKind } from './coordination';
import type { BoardAccess, ToolOutcome } from './tools';

export interface BoardMcpToolSpec {
  name: 'post_note' | 'read_notes';
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

const POST_NOTE_SPEC: BoardMcpToolSpec = {
  name: 'post_note',
  description:
    'Post a short note to the coordination board shared by parallel lanes and connected external agents: interface contracts (refs required) and environment facts. Verification failures are written by the platform, not by external agents, so failure is not offered here.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['contract', 'fact'], description: 'Note kind. Send "contract" for interface agreements, "fact" for environment facts.' },
      body: { type: 'string', description: 'Short note body (up to 2048 bytes). Do not paste diffs or reasoning.' },
      refs: { type: 'array', items: { type: 'string' }, description: 'File paths or checkpoint references. contract notes need at least one; send [] when there is nothing to point at.' },
    },
    required: ['kind', 'body', 'refs'],
    additionalProperties: false,
  },
};

const READ_NOTES_SPEC: BoardMcpToolSpec = {
  name: 'read_notes',
  description: 'Read notes posted on the coordination board by lanes and other external agents. Notes come back newest first, ordered by priority (failure > contract > fact).',
  input_schema: {
    type: 'object',
    properties: { kinds: { type: 'array', items: { type: 'string', enum: ['contract', 'failure', 'fact'] }, description: 'Kinds to read. Send [] to read every kind.' } },
    required: ['kinds'],
    additionalProperties: false,
  },
};

/** access.modelWrites가 false면(S2·S5처럼 읽기 전용 전략) post_note를 넣지 않는다 — tools.ts의 레인 규칙과 같다 */
export function boardMcpToolSpecs(access: Pick<BoardAccess, 'modelWrites'>): BoardMcpToolSpec[] {
  return access.modelWrites === false ? [READ_NOTES_SPEC] : [POST_NOTE_SPEC, READ_NOTES_SPEC];
}

const READ_KINDS: readonly NoteKind[] = ['contract', 'failure', 'fact'];
const POST_KINDS: readonly NoteKind[] = ['contract', 'fact'];

class BoardMcpInputError extends Error {}

function stringField(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new BoardMcpInputError(`"${key}" must be a string`);
  return value;
}

function stringArrayField(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new BoardMcpInputError(`"${key}" must be an array of strings`);
  return value;
}

/** post_note는 failure를 받지 않는다 — 스키마가 이미 막지만, 스키마를 거치지 않고 부른 호출도 여기서 한 번 더 막는다 */
function asPostKind(value: string): NoteKind {
  if (!(POST_KINDS as readonly string[]).includes(value)) throw new BoardMcpInputError(`Unknown note kind: ${value}`);
  return value as NoteKind;
}

function asReadKinds(values: string[]): NoteKind[] {
  return values.map((value) => {
    if (!(READ_KINDS as readonly string[]).includes(value)) throw new BoardMcpInputError(`Unknown note kind: ${value}`);
    return value as NoteKind;
  });
}

/** 읽은 메모를 짧은 텍스트로: `[kind·priority] 작성 레인: 본문 (refs)`. tools.ts의 formatNote와 같은 모양이다 */
function formatNote(note: { kind: NoteKind; priority: number; author: { lane: string }; body: string; refs: string[] }): string {
  const refs = note.refs.length > 0 ? ` (${note.refs.join(', ')})` : '';
  return `[${note.kind}·${note.priority}] ${note.author.lane}: ${note.body}${refs}`;
}

function success(content: string): ToolOutcome {
  return { ok: true, content };
}

function failure(content: string): ToolOutcome {
  return { ok: false, content };
}

/**
 * post_note·read_notes 실행. access(BoardAccess)가 신원과 쓰기 가능 여부를 고정하므로, 여기서는 입력만
 * 검증하고 나머지 규칙(실패 메모 거부, topology 읽기 범위, 상한)은 Board(access 뒤)가 그대로 강제한다.
 */
export async function runBoardMcpTool(name: string, args: Record<string, unknown>, access: BoardAccess): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'post_note': {
        if (access.modelWrites === false) return failure('이 게시판은 외부 에이전트도 읽기만 할 수 있습니다');
        const kind = asPostKind(stringField(args, 'kind'));
        const body = stringField(args, 'body');
        const refs = stringArrayField(args, 'refs');
        const result = access.post({ kind, body, refs });
        return result.ok ? success(`posted ${result.note.id} (${result.note.kind})`) : failure(result.reason);
      }
      case 'read_notes': {
        const kinds = asReadKinds(stringArrayField(args, 'kinds'));
        const { notes, truncated, reason, notice } = access.read({ kinds: kinds.length > 0 ? kinds : undefined });
        const lines = notes.map(formatNote);
        if (truncated) lines.push(`[... ${reason ?? '읽기 상한으로 일부만 돌려줬습니다'} ...]`);
        if (notice) lines.push(notice);
        return success(lines.length > 0 ? lines.join('\n') : '(no notes)');
      }
      default:
        return failure(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 외부 토큰 신원을 고정한 BoardAccess. 레인용 laneBoard()(apps/studio)와 같은 모양이다 — 누구 이름으로
 * 쓰고 읽는지는 토큰을 발급할 때 정해지고, 모델도 MCP 클라이언트도 바꿀 수 없다. by는 늘 'model'이라
 * Board.post가 실패 메모를 그대로 거부한다(레인과 같은 규칙, tools.ts 참고).
 */
export function externalBoardAccess(board: Board, identity: { lane: string; group?: string }, redact: (text: string) => string = (text) => text): BoardAccess {
  return {
    lane: identity.lane,
    modelWrites: board.modelWrites,
    post: (input) =>
      board.post({ kind: input.kind, body: redact(input.body), ...(input.refs ? { refs: input.refs.map(redact) } : {}) }, { lane: identity.lane, by: 'model' }),
    read: (options) => board.read({ lane: identity.lane, ...(identity.group !== undefined ? { group: identity.group } : {}) }, options),
  };
}
