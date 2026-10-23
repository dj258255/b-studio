/**
 * 여러 AI 계정(#885). CLI마다 계정을 여럿 두고, 세션을 띄울 때 그 계정의 설정 폴더로 CLI를 띄운다.
 *
 * 계정 목록은 `$XDG_CONFIG_HOME/b-studio/accounts.json`(없으면 `~/.config/b-studio/accounts.json`)에 둔다. 사람이 고치는
 * 설정이라 캐시 폴더가 아닌 설정 폴더다. 임시 파일에 쓴 뒤 이름을 바꾸고 0600으로 둔다(backend-rules.ts와 같다).
 *
 * 계정 = 이름 + CLI + 설정 폴더. 설정 폴더는 CLI가 로그인 정보와 대화 기록을 두는 자리다(claude는 CLAUDE_CONFIG_DIR,
 * codex는 CODEX_HOME). b-studio는 그 폴더를 만들지도, 지우지도, 안의 파일을 읽지도 않는다 — 로그인은 CLI가 그 폴더에 직접 한다.
 * 설정 폴더가 없는 계정은 기본 계정이다(지금처럼 ~/.claude·~/.codex, 또는 사용자가 셸에서 정한 값). 기본 계정은 파일에 없어도
 * 목록에 늘 있고, 이름·그림만 붙일 수 있다.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ACCOUNT_DIR_ENV } from '@b-studio/sandbox';
import { CLI_ACCOUNT_BACKENDS, isCliAccountBackend, type CliAccountBackend } from './cli-accounts';
import { StudioError } from './errors';

export interface AiAccount {
  id: string;
  name: string;
  backend: CliAccountBackend;
  /** CLI의 설정 폴더(절대 경로, 홈 아래). 없으면 기본 계정이다 */
  configDir?: string;
  /** 캐릭터 그림 파일(`b-studio/sprites/` 기준 상대 경로, png·gif). 화면이 읽는다 */
  sprite?: string;
  /** 파일에 없는 처음 기본 계정 */
  builtin?: true;
}

type Env = Record<string, string | undefined>;

export const ACCOUNT_NAME_MAX = 60;
export const MAX_ACCOUNTS = 32;
/** 계정 id의 꼴. 기본 계정은 CLI 이름(claude-code 등), 더한 계정은 acct-와 16진수 8자다 */
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * 그림 파일(#890): sprites 폴더 기준 상대 경로. 하위 폴더는 셋까지, 이름마다 점으로 시작하지 않는다(.., 숨은 폴더를 막는다).
 * 빈 이름(//), 역슬래시, 제어 글자도 받지 않는다. 화면(desk)은 이 경로를 그림 폴더에서 찾은 파일 목록에 있을 때만 읽는다
 */
const SPRITE_PART = '[^./\\\\\\u0000-\\u001f][^/\\\\\\u0000-\\u001f]';
const SPRITE = new RegExp(`^(?:${SPRITE_PART}{0,63}/){0,3}${SPRITE_PART}{0,123}\\.(?:png|gif)$`, 'i');

/** 설정 폴더를 따로 둘 수 있는 CLI와 그 환경 변수 */
const DIR_ENV: Partial<Record<CliAccountBackend, string>> = { 'claude-code': ACCOUNT_DIR_ENV.claude, codex: ACCOUNT_DIR_ENV.codex };
/** 기본 계정의 설정 폴더(홈 기준). 이 폴더를 다른 계정으로 더하면 같은 계정이 둘이 된다 */
const DEFAULT_DIR: Partial<Record<CliAccountBackend, string>> = { 'claude-code': '.claude', codex: '.codex' };

function homeOf(env: Env): string {
  return env.HOME?.trim() || homedir();
}

export function accountsFile(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(homeOf(env), '.config');
  return path.join(base, 'b-studio', 'accounts.json');
}

function builtinAccount(backend: CliAccountBackend): AiAccount {
  return { id: backend, name: '기본', backend, builtin: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 파일에서 읽은 한 줄. 꼴이 틀리면 던진다(손으로 고친 파일을 조용히 버리면 다음 저장 때 그 계정이 사라진다) */
function readEntry(value: unknown, index: number): AiAccount {
  const where = `${index + 1}번째 계정`;
  if (!isRecord(value)) throw new Error(`${where}: 객체여야 합니다`);
  const { id, name, backend, configDir, sprite } = value;
  if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw new Error(`${where}: id가 틀렸습니다`);
  if (typeof name !== 'string' || !name.trim()) throw new Error(`${where}: name이 필요합니다`);
  if (!isCliAccountBackend(backend)) throw new Error(`${where}: backend가 틀렸습니다`);
  if (configDir !== undefined && (typeof configDir !== 'string' || !path.isAbsolute(configDir))) throw new Error(`${where}: configDir는 절대 경로여야 합니다`);
  if (sprite !== undefined && (typeof sprite !== 'string' || !SPRITE.test(sprite))) throw new Error(`${where}: sprite가 틀렸습니다`);
  return { id, name, backend, ...(configDir ? { configDir } : {}), ...(sprite ? { sprite } : {}) };
}

/** 파일에 남긴 계정. 파일이 없으면 빈 목록, 깨졌으면 500으로 던진다 */
async function readStored(env: Env): Promise<AiAccount[]> {
  const file = accountsFile(env);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new StudioError(500, `계정 목록 파일(${file})을 읽지 못했습니다: ${(error as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) throw new Error('{ accounts: [...] } 꼴이어야 합니다');
    return parsed.accounts.map(readEntry);
  } catch (error) {
    throw new StudioError(500, `계정 목록 파일(${file})을 읽지 못했습니다. 고치거나 지운 뒤 다시 하세요: ${(error as Error).message}`);
  }
}

/** 파일에 남길 모양(처음 기본 계정 표시는 남기지 않는다) */
function storedShape(account: AiAccount): AiAccount {
  return {
    id: account.id,
    name: account.name,
    backend: account.backend,
    ...(account.configDir ? { configDir: account.configDir } : {}),
    ...(account.sprite ? { sprite: account.sprite } : {}),
  };
}

async function writeStored(accounts: readonly AiAccount[], env: Env): Promise<void> {
  const file = accountsFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const body = { accounts: accounts.map(storedShape) };
  try {
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** 읽고 고쳐 쓰는 일을 하나씩 한다(동시에 더해도 서로 덮어쓰지 않게) */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

/** 계정 목록: 고른 CLI마다 기본 계정(파일에 이름을 붙였으면 그것)을 앞에, 더한 계정을 뒤에 둔다 */
export async function listAiAccounts(env: Env = process.env, backends: readonly CliAccountBackend[] = CLI_ACCOUNT_BACKENDS): Promise<AiAccount[]> {
  const stored = await readStored(env);
  const result: AiAccount[] = [];
  for (const backend of backends) {
    result.push(stored.find((account) => account.id === backend) ?? builtinAccount(backend));
    result.push(...stored.filter((account) => account.backend === backend && account.id !== backend));
  }
  return result;
}

export async function findAiAccount(id: string, env: Env = process.env): Promise<AiAccount | undefined> {
  if (!ACCOUNT_ID.test(id)) return undefined;
  if (isCliAccountBackend(id)) return (await readStored(env)).find((account) => account.id === id) ?? builtinAccount(id);
  return (await readStored(env)).find((account) => account.id === id);
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new StudioError(400, 'name은 글이어야 합니다');
  const name = value.replace(CONTROL, '').trim();
  if (!name) throw new StudioError(400, '계정 이름을 적으세요');
  if (name.length > ACCOUNT_NAME_MAX) throw new StudioError(400, `계정 이름은 ${ACCOUNT_NAME_MAX}자까지입니다`);
  return name;
}

function cleanSprite(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !SPRITE.test(value)) throw new StudioError(400, '그림은 sprites 폴더 안의 png·gif 파일만 적습니다(예: marco.png, pokemon/25.gif)');
  return value;
}

/** 설정 폴더를 검사해 정규화한 절대 경로를 돌려준다. 폴더를 만들지 않는다 */
async function cleanConfigDir(value: unknown, backend: CliAccountBackend, env: Env): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) throw new StudioError(400, '계정의 설정 폴더(configDir)를 적으세요. 예: ~/.claude-work');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new StudioError(400, '설정 폴더에 제어 글자가 있습니다');
  if (value.length > 1024) throw new StudioError(400, '설정 폴더 경로가 너무 깁니다');
  const home = path.resolve(homeOf(env));
  const raw = value.trim();
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) throw new StudioError(400, '설정 폴더는 절대 경로나 ~/로 시작하는 경로여야 합니다');
  const dir = path.resolve(expanded);
  const relative = path.relative(home, dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new StudioError(400, '설정 폴더는 홈 폴더 아래여야 합니다(홈 폴더 자체는 안 됩니다)');
  const defaultDir = DEFAULT_DIR[backend];
  if (defaultDir && dir === path.join(home, defaultDir)) throw new StudioError(400, `~/${defaultDir}는 기본 계정의 폴더입니다. 기본 계정은 이름만 바꾸세요`);
  const info = await lstat(dir).catch(() => undefined);
  if (info && !info.isDirectory()) throw new StudioError(400, `설정 폴더 자리에 있는 것이 폴더가 아닙니다: ${dir}`);
  return dir;
}

/** 계정을 더한다. 설정 폴더를 따로 둘 수 있는 CLI(claude-code·codex)만 된다 */
export async function addAiAccount(input: unknown, env: Env = process.env): Promise<AiAccount> {
  if (!isRecord(input)) throw new StudioError(400, '계정은 객체로 보냅니다');
  const { backend } = input;
  if (!isCliAccountBackend(backend)) throw new StudioError(400, `계정을 둘 수 없는 CLI입니다: ${String(backend)}`);
  if (!DIR_ENV[backend]) throw new StudioError(400, `${backend}는 설정 폴더를 따로 둘 수 없어 계정을 하나만 씁니다. 기본 계정의 이름만 바꾸세요`);
  const name = cleanName(input.name);
  const sprite = cleanSprite(input.sprite);
  const configDir = await cleanConfigDir(input.configDir, backend, env);
  return exclusive(async () => {
    const stored = await readStored(env);
    if (stored.length >= MAX_ACCOUNTS) throw new StudioError(400, `계정은 ${MAX_ACCOUNTS}개까지입니다`);
    const same = stored.find((account) => account.backend === backend && account.configDir === configDir);
    if (same) throw new StudioError(409, `같은 설정 폴더를 쓰는 계정이 이미 있습니다: ${same.name}`);
    let id: string;
    do id = `acct-${randomBytes(4).toString('hex')}`;
    while (stored.some((account) => account.id === id));
    const account: AiAccount = { id, name, backend, configDir, ...(sprite ? { sprite } : {}) };
    await writeStored([...stored, account], env);
    return account;
  });
}

/** 이름·그림만 고친다. 설정 폴더·CLI는 세션 기록이 가리키므로 바꾸지 않는다(지우고 새로 더한다) */
export async function updateAiAccount(id: string, input: unknown, env: Env = process.env): Promise<AiAccount> {
  if (!isRecord(input)) throw new StudioError(400, '고칠 내용은 객체로 보냅니다');
  if ('configDir' in input || 'backend' in input) throw new StudioError(400, '계정의 설정 폴더와 CLI는 바꿀 수 없습니다. 지우고 새로 더하세요');
  const name = input.name !== undefined ? cleanName(input.name) : undefined;
  const sprite = 'sprite' in input ? { value: cleanSprite(input.sprite) } : undefined;
  return exclusive(async () => {
    const stored = await readStored(env);
    const index = stored.findIndex((account) => account.id === id);
    const current = index >= 0 ? stored[index]! : isCliAccountBackend(id) ? builtinAccount(id) : undefined;
    if (!current) throw new StudioError(404, '그 계정이 목록에 없습니다');
    const nextSprite = sprite ? sprite.value : current.sprite;
    const next: AiAccount = { ...storedShape(current), ...(name ? { name } : {}) };
    delete next.sprite;
    if (nextSprite) next.sprite = nextSprite;
    await writeStored(index >= 0 ? stored.map((account, at) => (at === index ? next : account)) : [...stored, next], env);
    return next;
  });
}

/** 목록에서만 뺀다. 설정 폴더(로그인 정보, 대화 기록)는 그대로 둔다 */
export async function removeAiAccount(id: string, env: Env = process.env): Promise<void> {
  await exclusive(async () => {
    const stored = await readStored(env);
    if (!stored.some((account) => account.id === id)) {
      if (isCliAccountBackend(id)) throw new StudioError(400, '기본 계정은 지울 수 없습니다');
      throw new StudioError(404, '그 계정이 목록에 없습니다');
    }
    await writeStored(
      stored.filter((account) => account.id !== id),
      env,
    );
  });
}

/** 계정의 설정 폴더 변수(CLAUDE_CONFIG_DIR·CODEX_HOME). 기본 계정이면 비어 있다 */
export function aiAccountEnv(account: Pick<AiAccount, 'backend' | 'configDir'>): Record<string, string> {
  const name = DIR_ENV[account.backend];
  return name && account.configDir ? { [name]: account.configDir } : {};
}

/** CLI 프로세스에 넘길 환경. 기본 계정(또는 계정 없음)이면 undefined라 부르는 쪽이 지금처럼 process.env를 쓴다 */
export function accountProcessEnv(account: Pick<AiAccount, 'backend' | 'configDir'> | undefined, base: NodeJS.ProcessEnv | Env = process.env): NodeJS.ProcessEnv | undefined {
  const extra = account ? aiAccountEnv(account) : {};
  return Object.keys(extra).length > 0 ? ({ ...base, ...extra } as NodeJS.ProcessEnv) : undefined;
}

/**
 * 세션에 쓸 계정. id가 없거나 기본 계정이면 undefined(지금처럼). 목록에 없거나 다른 CLI의 계정이면 400이다 —
 * 다른 계정으로 조용히 띄우면 사람이 모르는 사이에 다른 구독의 한도를 쓴다
 */
export async function resolveSessionAccount(id: string | undefined, backend: string, env: Env = process.env): Promise<AiAccount | undefined> {
  if (id === undefined) return undefined;
  const account = await findAiAccount(id, env);
  if (!account) throw new StudioError(400, `계정이 목록에 없습니다: ${id}`);
  if (account.backend !== backend) throw new StudioError(400, `${account.name} 계정은 ${account.backend}의 계정입니다(고른 AI: ${backend})`);
  return account.configDir ? account : undefined;
}
