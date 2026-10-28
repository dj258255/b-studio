/**
 * Codex 세션 터미널의 문맥 %(#978). Codex에는 Claude의 상태 줄이 없고, 문맥 창 크기는 텔레메트리에도 app-server에도 없다.
 * 그 숫자가 있는 곳은 Codex가 남기는 세션 기록(`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<시각>-<대화 id>.jsonl`)의
 * `token_count` 이벤트뿐이라 거기서 읽는다(범수 님 결정 2026-10-28, ADR-189 덧붙임).
 *
 * 지키는 것:
 * - b-studio가 연 세션의 대화 id(훅의 session_id 또는 그 세션 관문으로 들어온 텔레메트리의 conversation.id)로 찾은 파일 하나만 연다.
 *   폴더는 이름만 훑고 다른 세션의 파일은 열지 않는다. id 꼴이 아니면 훑지도 않는다.
 * - 끝에서부터 조금씩 읽어 `token_count` 줄의 숫자만 꺼낸다. 다른 줄(대화 내용)은 그 자리에서 버리고 기억·기록·로그로 내보내지 않는다.
 * - 확실하지 않으면(파일이 없다, 숫자가 틀렸다) 문맥을 비운다.
 */
import type { Dirent } from 'node:fs';
import { open as openFile, readdir as readDir } from 'node:fs/promises';
import path from 'node:path';
import type { ActivityContext } from './terminal-activity';

export interface CodexRolloutFile {
  stat(): Promise<{ size: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** 테스트가 연 파일과 훑은 폴더를 세려고 바꿔 끼운다 */
export interface CodexRolloutFs {
  readdir(dir: string): Promise<string[]>;
  open(file: string): Promise<CodexRolloutFile>;
}

const nodeFs: CodexRolloutFs = {
  readdir: async (dir) => (await readDir(dir, { withFileTypes: true })).map((entry: Dirent) => entry.name),
  open: (file) => openFile(file, 'r'),
};

/** Codex 대화 id(UUID 꼴). 경로 글자가 섞인 값은 받지 않는다 */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 끝에서부터 한 번에 읽는 양과, 한 기록에서 읽는 상한. token_count는 응답마다 남아 보통 끝 가까이에 있다 */
const CHUNK = 64 * 1024;
const MAX_SCAN = 4 * 1024 * 1024;
/** 거슬러 훑는 날짜 폴더 수. 그보다 오래된 대화를 이어 쓰면 문맥을 비운다 */
const MAX_DAYS = 60;

export interface CodexRolloutReader {
  /** 그 대화의 마지막 문맥. 모르면 undefined */
  read(codexHome: string, thread: string): Promise<ActivityContext | undefined>;
}

export function createCodexRolloutReader(fs: CodexRolloutFs = nodeFs): CodexRolloutReader {
  // 찾은 파일 자리. 대화 id마다 하나다(다른 세션의 기록과 섞이지 않는다)
  const found = new Map<string, string>();
  return {
    async read(codexHome, thread) {
      if (!THREAD_ID.test(thread)) return undefined;
      const key = `${codexHome}\0${thread}`;
      const file = found.get(key) ?? (await findRollout(fs, codexHome, thread));
      if (!file) return undefined;
      found.set(key, file);
      return lastContext(fs, file).catch(() => undefined);
    },
  };
}

/** 날짜 폴더를 새것부터 이름만 훑어 `-<대화 id>.jsonl`로 끝나는 파일을 찾는다. 파일은 열지 않는다 */
async function findRollout(fs: CodexRolloutFs, codexHome: string, thread: string): Promise<string | undefined> {
  const root = path.join(codexHome, 'sessions');
  const list = async (dir: string, pattern: RegExp) => (await fs.readdir(dir).catch(() => [])).filter((name) => pattern.test(name)).sort().reverse();
  const suffix = `-${thread}.jsonl`;
  let days = 0;
  for (const year of await list(root, /^\d{4}$/)) {
    for (const month of await list(path.join(root, year), /^\d{2}$/)) {
      for (const day of await list(path.join(root, year, month), /^\d{2}$/)) {
        if (days++ >= MAX_DAYS) return undefined;
        const dir = path.join(root, year, month, day);
        const name = (await fs.readdir(dir).catch(() => [])).find((entry) => entry.startsWith('rollout-') && entry.endsWith(suffix));
        if (name) return path.join(dir, name);
      }
    }
  }
  return undefined;
}

/** 끝에서부터 줄을 거슬러 읽어 첫 `token_count`의 숫자를 문맥으로 바꾼다 */
async function lastContext(fs: CodexRolloutFs, file: string): Promise<ActivityContext | undefined> {
  const handle = await fs.open(file);
  try {
    const { size } = await handle.stat();
    let position = size;
    // 아직 앞부분을 읽지 않은 줄(조각의 맨 앞 줄). 다음 조각을 읽으면 그 앞에 붙는다
    let head = Buffer.alloc(0);
    while (position > 0 && size - position < MAX_SCAN) {
      const length = Math.min(CHUNK, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const buffer = Buffer.concat([chunk.subarray(0, bytesRead), head]);
      // 뒤에서부터 줄바꿈마다 끊어 본다. 맨 앞 줄은 앞 조각과 이어질 수 있어 남긴다
      let end = buffer.length;
      while (end > 0) {
        const at = buffer.lastIndexOf(0x0a, end - 1);
        if (at < 0) break;
        const context = contextOf(buffer.subarray(at + 1, end));
        if (context) return context;
        end = at;
      }
      head = buffer.subarray(0, end);
    }
    // 파일 처음까지 읽었으면 남은 것은 온전한 첫 줄이다
    return position === 0 ? contextOf(head) : undefined;
  } finally {
    await handle.close();
  }
}

/** 한 줄이 token_count면 숫자만 꺼낸다. 다른 줄은 해석하지 않는다 */
function contextOf(line: Buffer): ActivityContext | undefined {
  if (line.length === 0 || line.indexOf('"token_count"') < 0) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line.toString('utf8'));
  } catch {
    return undefined;
  }
  const payload = (event as { payload?: { type?: unknown; info?: unknown } } | null)?.payload;
  if (payload?.type !== 'token_count' || !payload.info || typeof payload.info !== 'object') return undefined;
  const info = payload.info as { model_context_window?: unknown; last_token_usage?: { total_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown } };
  const size = info.model_context_window;
  const last = info.last_token_usage;
  if (!isCount(size) || size <= 0 || !last) return undefined;
  // 다음 요청이 들고 갈 문맥은 마지막 요청의 입력(캐시 포함)과 그 답이다
  const used = isCount(last.total_tokens) ? last.total_tokens : isCount(last.input_tokens) && isCount(last.output_tokens) ? last.input_tokens + last.output_tokens : undefined;
  if (used === undefined || used > size) return undefined;
  return { usedPct: Math.round((used / size) * 100), used, size };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
