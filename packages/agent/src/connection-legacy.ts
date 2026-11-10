import { timingSafeEqual } from 'node:crypto';
import type { NoteKind } from './coordination';
import type { BoardAccess, ToolOutcome } from './tools';

/**
 * 옮기기 전(ADR-191 3t) 연결·인증 판정의 TS 본문이다(`mcp-http-server.ts`·`board-mcp.ts`·`browser-check.ts`·`change-tracker.ts`에서 `export`만 붙여 가져왔다).
 * 차등·벡터 시험이 기준으로 삼는다. 지우지 않는다. 시험 말고는 아무도 import하지 않는다.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function authorize(host: string | undefined, authorization: string | undefined, token: string, allowedHosts: readonly string[]): { status: number; message: string } | undefined {
  if (!hostAllowed(host, allowedHosts)) return { status: 403, message: 'MCP 서버는 루프백에서만 접근할 수 있습니다' };
  if (!tokenMatches(authorization, token)) return { status: 401, message: 'unauthorized' };
  return undefined;
}

export function hostAllowed(host: string | undefined, allowedHosts: readonly string[] = []): boolean {
  const name = hostnameOf(host).toLowerCase();
  return LOOPBACK_HOSTS.has(name) || allowedHosts.some((allowed) => allowed.toLowerCase() === name);
}

export function hostnameOf(host: string | undefined): string {
  const value = (host ?? '').trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? '' : value.slice(1, end);
  }
  const colon = value.indexOf(':');
  // 콜론이 둘 이상이면 포트 없는 IPv6 주소다
  return colon === -1 || value.includes(':', colon + 1) ? value : value.slice(0, colon);
}

export function tokenMatches(authorization: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!authorization?.startsWith(prefix)) return false;
  const provided = Buffer.from(authorization.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

const INTERNAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

export function isAllowedRequest(url: string, allowed: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return INTERNAL_SCHEMES.has(parsed.protocol) || allowed.has(parsed.origin);
}

export function isAutomaticFavicon(url: string): boolean {
  return new URL(url).pathname === '/favicon.ico';
}

export interface LegacyPageStep {
  click?: string;
  fill?: { selector: string; value: string };
  press?: string;
  waitFor?: string;
}

export function describeStep(step: LegacyPageStep): string {
  if (step.click !== undefined) return `click ${step.click}`;
  if (step.fill !== undefined) return `fill ${step.fill.selector}`;
  if (step.press !== undefined) return `press ${step.press}`;
  return `waitFor ${step.waitFor}`;
}

export function rejectedChangeFeedback(rejected: readonly string[]): string {
  return [
    '[b-studio 검증 게이트] 게이트가 검증할 수 없는 경로가 이번 실행에서 바뀌어 통과시키지 않았습니다.',
    ...rejected.slice(0, 20).map((file) => `- ${file}`),
    ...(rejected.length > 20 ? [`- 외 ${rejected.length - 20}개`] : []),
    '비밀 파일(.env 등)이나 생성물은 체크포인트에 넣지 않습니다. 필요 없는 파일이면 지우고, 생성물이면 .gitignore에 넣은 뒤 턴을 끝내세요.',
  ].join('\n');
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

export function formatNote(note: { kind: NoteKind; priority: number; author: { lane: string }; body: string; refs: string[] }): string {
  const refs = note.refs.length > 0 ? ` (${note.refs.join(', ')})` : '';
  return `[${note.kind}·${note.priority}] ${note.author.lane}: ${note.body}${refs}`;
}

function success(content: string): ToolOutcome {
  return { ok: true, content };
}

function failure(content: string): ToolOutcome {
  return { ok: false, content };
}

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
