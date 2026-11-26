/**
 * 쓰던 요청 글의 임시 저장(#1380 단위 1). desk를 닫았다 다시 띄워도 새 요청·새 계획·새 비교의 입력 칸에 쓰던 글이 남는다.
 * `$XDG_CONFIG_HOME/b-studio/desk-drafts.json`(배치 기억 desk-state.json과 같은 폴더)에 600으로 둔다.
 *
 * 읽을 때는 fail closed다(agent-tty/model-file.ts와 같은 규칙): 링크·FIFO 같은 특수 파일·다른 사용자의 파일·
 * 그룹/다른 사용자 권한이 있는 파일·상한을 넘는 파일은 열지 않고 알림만 낸다(desk는 멈추지 않는다).
 * 쓸 때는 같은 폴더의 임시 파일에 600으로 쓰고 바꿔 단다(쓰다 끊겨도 앞 파일이 깨지지 않는다)
 */
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const DRAFT_FILE = 'desk-drafts.json';
/** 글 하나의 상한(UTF-8 바이트). 넘으면 저장하지 않고, 읽을 때는 그 글만 버린다 */
export const MAX_DRAFT_BYTES = 64 * 1024;
/** 한꺼번에 남기는 글의 수. 넘으면 가장 오래 안 고친 것부터 버린다 */
export const MAX_DRAFTS = 32;
/** 파일 전체의 상한. 읽기 전에 fstat 크기로 본다("상한은 읽기 전에") */
export const MAX_DRAFT_FILE_BYTES = MAX_DRAFT_BYTES * MAX_DRAFTS + 64 * 1024;
const MAX_KEY_LENGTH = 200;

/** 이름(칸 종류와 프로젝트)에서 글로 가는 목록. 나중에 고친 것이 뒤에 온다 */
export type Drafts = Map<string, string>;

export interface DeskDraftStore {
  /** warning이 있으면 파일을 믿지 못해 비운 채 시작한 것이다 */
  load(): { drafts: Drafts; warning?: string };
  /** 실패하면 던진다 */
  save(drafts: ReadonlyMap<string, string>): void;
}

export function draftFits(text: string, max = MAX_DRAFT_BYTES): boolean {
  return Buffer.byteLength(text, 'utf8') <= max;
}

export function createDraftStore(dir: string): DeskDraftStore {
  const file = join(dir, DRAFT_FILE);
  return { load: () => loadDrafts(file), save: (drafts) => saveDrafts(dir, drafts) };
}

export function loadDrafts(file: string): { drafts: Drafts; warning?: string } {
  const none = (reason: string) => ({ drafts: new Map<string, string>(), warning: `쓰던 글 임시 저장 파일을 읽지 않았습니다(${reason}): ${file}` });
  let fd: number;
  try {
    // O_NOFOLLOW: 마지막 조각이 링크면 열지 않는다. O_NONBLOCK: FIFO에서 열기가 멈추지 않게 한다(종류는 아래 fstat에서 거절한다)
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { drafts: new Map() };
    if (code === 'ELOOP') return none('링크는 허용하지 않습니다');
    return none('열 수 없습니다');
  }
  let raw: string;
  try {
    // 한 번 연 핸들로 확인하고 읽는다: 경로로 확인한 뒤 다시 경로로 읽으면 그 사이에 바꿔친 파일을 읽을 수 있다
    const stat = fstatSync(fd);
    if (!stat.isFile()) return none('일반 파일이 아닙니다');
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return none('주인이 이 사용자가 아닙니다');
    if ((stat.mode & 0o077) !== 0) return none('권한이 600이 아닙니다');
    if (stat.size > MAX_DRAFT_FILE_BYTES) return none('너무 큽니다');
    raw = readFileSync(fd, 'utf8');
  } catch {
    return none('읽지 못했습니다');
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return none('JSON이 아닙니다');
  }
  const body = (parsed as { drafts?: unknown } | null)?.drafts;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return none('꼴이 맞지 않습니다');
  const drafts: Drafts = new Map();
  for (const [key, text] of Object.entries(body)) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || typeof text !== 'string' || text === '' || !draftFits(text)) continue;
    drafts.set(key, text);
  }
  // 상한을 넘는 만큼은 앞(오래된 것)을 버린다
  while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value as string);
  return { drafts };
}

export function saveDrafts(dir: string, drafts: ReadonlyMap<string, string>): void {
  const file = join(dir, DRAFT_FILE);
  const kept = [...drafts].filter(([key, text]) => text !== '' && key.length <= MAX_KEY_LENGTH && draftFits(text)).slice(-MAX_DRAFTS);
  if (kept.length === 0) {
    // 남길 글이 없으면 파일도 두지 않는다
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  // wx(O_EXCL)는 이미 있는 파일·링크 위에 쓰지 않는다. 앞 시도가 남긴 임시 파일은 치우고 한 번 더 한다
  const open = (): number => openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let fd: number;
  try {
    fd = open();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    unlinkSync(temp);
    fd = open();
  }
  try {
    // umask가 권한을 깎지 못하게 하는 것이 아니라(깎기만 한다), 넓어지지 않게 확실히 600으로 맞춘다
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify({ version: 1, drafts: Object.fromEntries(kept) })}\n`);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // 지우지 못한 임시 파일은 다음 저장이 치운다
    }
    throw error;
  }
  closeSync(fd);
  // 같은 폴더 안의 바꿔 달기: 목적지가 링크여도 링크 자체를 갈아 끼우고 그 너머는 건드리지 않는다
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // 다음 저장이 치운다
    }
    throw error;
  }
}
