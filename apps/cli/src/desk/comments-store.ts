/**
 * 지금 변경 화면(#924)의 의견을 세션마다 남긴다. desk 설정 폴더의 desk-comments.json에 둔다(desk-state.json 옆).
 * 의견은 사람이 쓴 메모라 스튜디오로 보내지 않는다. 깨진 파일과 모양이 틀린 의견은 버리고, 세션 하나에 너무 많으면 해결한 오래된 의견부터 버린다
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeskComment } from './changes';

const FILE = 'desk-comments.json';
/** 세션 하나에 남기는 의견 수 */
const MAX_PER_SESSION = 200;

function isComment(value: unknown): value is DeskComment {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.file === 'string' &&
    typeof entry.line === 'number' &&
    (entry.side === 'new' || entry.side === 'old') &&
    typeof entry.code === 'string' &&
    typeof entry.text === 'string' &&
    typeof entry.createdAt === 'string' &&
    (entry.resolved === undefined || typeof entry.resolved === 'boolean') &&
    (entry.sentAt === undefined || typeof entry.sentAt === 'string')
  );
}

function readAll(dir: string): Record<string, DeskComment[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
  } catch {
    return {};
  }
  const sessions = parsed && typeof parsed === 'object' ? (parsed as { sessions?: unknown }).sessions : undefined;
  if (!sessions || typeof sessions !== 'object') return {};
  const all: Record<string, DeskComment[]> = {};
  for (const [id, list] of Object.entries(sessions as Record<string, unknown>)) {
    if (Array.isArray(list)) all[id] = list.filter(isComment);
  }
  return all;
}

export function loadComments(dir: string, sessionId: string): DeskComment[] {
  return readAll(dir)[sessionId] ?? [];
}

/** 너무 많으면 해결한 의견을 오래된 것부터 버린다. 그래도 많으면 오래된 것부터 */
function trim(comments: readonly DeskComment[]): DeskComment[] {
  let kept = [...comments];
  const drop = (pick: (comment: DeskComment) => boolean) => {
    const order = kept.filter(pick).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const gone = new Set(order.slice(0, Math.max(0, kept.length - MAX_PER_SESSION)).map((comment) => comment.id));
    kept = kept.filter((comment) => !gone.has(comment.id));
  };
  if (kept.length > MAX_PER_SESSION) drop((comment) => comment.resolved === true);
  if (kept.length > MAX_PER_SESSION) drop(() => true);
  return kept;
}

/** 이 세션의 의견을 바꿔 쓴다. 쓰다 끊겨도 앞 파일이 깨지지 않게 옆 파일에 쓰고 바꿔 단다. 실패하면 던진다 */
export function saveComments(dir: string, sessionId: string, comments: readonly DeskComment[]): void {
  const all = readAll(dir);
  if (comments.length === 0) delete all[sessionId];
  else all[sessionId] = trim(comments);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, sessions: all }, null, 2)}\n`);
  renameSync(temp, file);
}
