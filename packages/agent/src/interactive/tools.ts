import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_OUTPUT_CHARS, BASH_MAX_TIMEOUT_MS, runBash, type BashOptions } from './bash';

type BetaTool = Anthropic.Beta.BetaTool;

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

/** 읽기 한 번의 크기 상한(읽기 전에 stat으로 본다), 쓰기 내용 상한, 목록 도구의 결과·방문 상한 */
export const MAX_READ_BYTES = 1_000_000;
export const MAX_WRITE_BYTES = 5_000_000;
export const MAX_RESULTS = 200;
export const MAX_VISITED = 20_000;
/** 목록 도구가 들어가지 않는 폴더(결과에 건너뛴다고 적는다) */
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

const fail = (text: string): ToolOutcome => ({ text, isError: true });
const ok = (text: string): ToolOutcome => ({ text, isError: false });

export const TOOL_DEFINITIONS: BetaTool[] = [
  { name: 'Read', description: '작업 폴더 안의 파일을 읽는다(줄 번호를 붙인다).', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'Write', description: '작업 폴더 안에 파일을 쓴다(없으면 만들고 있으면 덮어쓴다).', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  {
    name: 'Edit',
    description: '파일에서 old_string을 new_string으로 바꾼다. old_string이 여러 곳에 있으면 replace_all이 있어야 한다.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] },
  },
  { name: 'Glob', description: '작업 폴더 안에서 glob 패턴(`**`, `*`, `?`, `{a,b}`)에 맞는 파일을 찾는다. .git·node_modules와 링크는 건너뛴다.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  {
    name: 'Grep',
    description: '작업 폴더 안의 파일에서 정규식에 맞는 줄을 찾는다. glob으로 파일을 좁힐 수 있다. .git·node_modules와 링크는 건너뛴다.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'Bash',
    description: `작업 폴더에서 셸 명령(bash -c)을 실행하고 종료 코드와 출력(stdout·stderr)을 돌려준다. 입력(stdin)은 닫혀 있어 대화형 명령은 쓸 수 없다. 기본 ${BASH_DEFAULT_TIMEOUT_MS}ms, 최대 ${BASH_MAX_TIMEOUT_MS}ms(timeout)를 넘기면 명령과 하위 프로세스를 끊는다. 명령이 끝나면 남은 하위 프로세스(백그라운드로 보낸 것 포함)도 끊는다. 출력은 앞 ${BASH_MAX_OUTPUT_CHARS}자만 남는다. 작업 폴더 밖 경로 제한은 이 도구에 없다.`,
    input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number', description: '밀리초' }, description: { type: 'string' } }, required: ['command'] },
  },
];

type Confined = { ok: true; abs: string; real: string; exists: boolean } | { ok: false; reason: string };

const within = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/**
 * 작업 폴더 가둠. 막는 검사이므로 모르는 입력은 거절한다(fail closed).
 * 1) 글자만으로 `..`·밖의 절대 경로를 거른다. 2) 있는 가장 가까운 조상의 realpath가 작업 폴더의 realpath 안인지 본다
 *    (링크를 지나 밖으로 나가는 경로, 깨진 링크, 읽을 수 없는 조상은 거절). 새 파일은 없는 조각을 그 실제 조상에 붙여 쓴다
 * 확인과 쓰기 사이에 링크로 바꿔치는 경쟁은 쓰기 쪽의 O_NOFOLLOW와 실제 경로로 쓰기로 좁히지만 완전히 막지는 못한다(한계)
 */
export async function confine(cwd: string, requested: string): Promise<Confined> {
  if (typeof requested !== 'string' || requested === '' || requested.includes('\0')) return { ok: false, reason: '경로가 올바르지 않습니다' };
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return { ok: false, reason: '작업 폴더를 확인할 수 없습니다' };
  }
  const abs = path.resolve(cwd, requested);
  if (!within(path.resolve(cwd), abs)) return { ok: false, reason: `작업 폴더 밖의 경로입니다: ${requested}` };
  let probe = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      await lstat(probe);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ok: false, reason: `경로를 확인할 수 없습니다: ${requested}` };
      const parent = path.dirname(probe);
      if (parent === probe) return { ok: false, reason: `경로를 확인할 수 없습니다: ${requested}` };
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
  let realProbe: string;
  try {
    realProbe = await realpath(probe);
  } catch {
    // 깨진 링크, 순환 링크 등
    return { ok: false, reason: `링크를 풀 수 없는 경로입니다: ${requested}` };
  }
  const real = path.join(realProbe, ...tail);
  if (!within(root, real)) return { ok: false, reason: `링크를 따라가면 작업 폴더 밖입니다: ${requested}` };
  // 작업 폴더 안을 가리키는 링크도 지나지 않는다: 훅(서버)에는 글자 그대로의 경로를 알리므로, 링크를 지나면 서버가 본 경로와
  // 실제로 읽고 쓰는 경로가 갈린다(예: web/notes -> ../tests/acceptance면 서버는 web/notes/x를 보고 파일은 보호 경로에 써진다).
  // 실제 경로가 글자 그대로의 경로와 같을 때만 연다. 대소문자만 다른 경로도 여기서 걸린다(모르면 거절)
  if (real !== path.join(root, path.relative(path.resolve(cwd), abs))) return { ok: false, reason: `링크를 지나는 경로는 읽거나 쓰지 않습니다: ${requested}` };
  return { ok: true, abs, real, exists: tail.length === 0 };
}

/** 쓰는 도구용: 마지막 조각이 링크면 안쪽을 가리켜도 거절한다 */
async function confineForWrite(cwd: string, requested: string): Promise<Confined> {
  const confined = await confine(cwd, requested);
  if (!confined.ok) return confined;
  if (confined.exists) {
    try {
      if ((await lstat(confined.abs)).isSymbolicLink()) return { ok: false, reason: `링크 파일에는 쓰지 않습니다: ${requested}` };
    } catch {
      return { ok: false, reason: `경로를 확인할 수 없습니다: ${requested}` };
    }
  }
  return confined;
}

/** glob → 정규식(작업 폴더 기준 `/` 상대 경로 전체에 맞춘다). `**`는 폴더 여러 단계, `*`·`?`는 한 조각 안 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  let depth = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') {
          index++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else if (char === '{') {
      depth++;
      out += '(?:';
    } else if (char === '}' && depth > 0) {
      depth--;
      out += ')';
    } else if (char === ',' && depth > 0) out += '|';
    else out += char.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  // 닫히지 않은 `{`는 정규식이 틀리게 되므로 글자 그대로 맞추는 것으로 바꾼다
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  }
}

interface Walked {
  files: string[];
  truncated: boolean;
  skippedDirs: number;
}

/**
 * 폴더를 내려가며 일반 파일의 경로(시작 폴더 기준 상대)를 모은다. 링크는 파일이든 폴더든 따라가지도 돌려주지도 않는다.
 * 방문 수·결과 수 상한에 닿으면 truncated로 알린다
 */
async function walk(startReal: string, accept: (rel: string) => boolean, limit: number): Promise<Walked> {
  const out: Walked = { files: [], truncated: false, skippedDirs: 0 };
  let visited = 0;
  const stack: string[] = [startReal];
  while (stack.length > 0 && !out.truncated) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      out.skippedDirs++;
      continue;
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (++visited > MAX_VISITED) {
        out.truncated = true;
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) out.skippedDirs++;
        else subdirs.push(full);
      } else if (entry.isFile()) {
        const rel = path.relative(startReal, full).split(path.sep).join('/');
        if (!accept(rel)) continue;
        if (out.files.length >= limit) {
          out.truncated = true;
          break;
        }
        out.files.push(rel);
      }
    }
    for (const sub of subdirs.reverse()) stack.push(sub);
  }
  return out;
}

async function readTextFile(real: string, requested: string): Promise<{ ok: true; text: string } | { ok: false; outcome: ToolOutcome }> {
  try {
    const info = await stat(real);
    if (!info.isFile()) return { ok: false, outcome: fail(`일반 파일이 아닙니다: ${requested}`) };
    if (info.size > MAX_READ_BYTES) return { ok: false, outcome: fail(`파일이 너무 큽니다(${info.size}바이트, 상한 ${MAX_READ_BYTES}): ${requested}`) };
    return { ok: true, text: await readFile(real, 'utf8') };
  } catch (error) {
    return { ok: false, outcome: fail(`읽지 못했습니다: ${requested} (${(error as NodeJS.ErrnoException).code ?? 'error'})`) };
  }
}

async function writeNoFollow(real: string, content: string): Promise<void> {
  await mkdir(path.dirname(real), { recursive: true });
  const handle = await open(real, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export interface InteractiveTools {
  definitions: BetaTool[];
  /** 훅에 알릴 입력: 파일 경로 칸을 작업 폴더 기준 절대 경로로 풀어 준다(서버가 작업 폴더와 견주는 값) */
  hookInput(name: string, input: Record<string, unknown>): Record<string, unknown>;
  /** signal이 끊기면 실행 중인 명령을 끊는다 */
  execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome>;
}

export function createTools(cwd: string, bash: Omit<BashOptions, 'cwd'> = {}): InteractiveTools {
  const resolveField = (input: Record<string, unknown>, key: string) => (typeof input[key] === 'string' && input[key] !== '' ? { [key]: path.resolve(cwd, input[key] as string) } : {});
  return {
    definitions: TOOL_DEFINITIONS,
    hookInput(name, input) {
      if (name === 'Read' || name === 'Write' || name === 'Edit') return { ...input, ...resolveField(input, 'file_path') };
      if (name === 'Glob' || name === 'Grep') return { ...input, ...resolveField(input, 'path') };
      return input;
    },
    async execute(name, input, signal) {
      switch (name) {
        case 'Bash':
          return runBash(input, { ...bash, cwd }, signal);
        case 'Read': {
          const file = str(input.file_path);
          if (file === undefined) return fail('file_path가 필요합니다');
          const confined = await confine(cwd, file);
          if (!confined.ok) return fail(confined.reason);
          const read = await readTextFile(confined.real, file);
          if (!read.ok) return read.outcome;
          return ok(read.text.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n'));
        }
        case 'Write': {
          const file = str(input.file_path);
          const content = str(input.content);
          if (file === undefined || content === undefined) return fail('file_path와 content가 필요합니다');
          if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return fail(`내용이 너무 큽니다(상한 ${MAX_WRITE_BYTES}바이트)`);
          const confined = await confineForWrite(cwd, file);
          if (!confined.ok) return fail(confined.reason);
          try {
            await writeNoFollow(confined.real, content);
          } catch (error) {
            return fail(`쓰지 못했습니다: ${file} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
          }
          return ok(`${file}에 ${Buffer.byteLength(content)}바이트를 썼습니다`);
        }
        case 'Edit': {
          const file = str(input.file_path);
          const oldString = str(input.old_string);
          const newString = str(input.new_string);
          if (file === undefined || oldString === undefined || newString === undefined) return fail('file_path, old_string, new_string이 필요합니다');
          if (oldString === '') return fail('old_string이 비어 있습니다');
          if (oldString === newString) return fail('old_string과 new_string이 같습니다');
          const confined = await confineForWrite(cwd, file);
          if (!confined.ok) return fail(confined.reason);
          if (!confined.exists) return fail(`파일이 없습니다: ${file}`);
          const read = await readTextFile(confined.real, file);
          if (!read.ok) return read.outcome;
          const count = read.text.split(oldString).length - 1;
          if (count === 0) return fail('old_string을 찾지 못했습니다');
          if (count > 1 && input.replace_all !== true) return fail(`old_string이 ${count}곳에 있습니다. 더 길게 적거나 replace_all을 쓰세요`);
          const next = input.replace_all === true ? read.text.split(oldString).join(newString) : read.text.replace(oldString, () => newString);
          try {
            await writeNoFollow(confined.real, next);
          } catch (error) {
            return fail(`쓰지 못했습니다: ${file} (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
          }
          return ok(`${file}에서 ${input.replace_all === true ? count : 1}곳을 바꿨습니다`);
        }
        case 'Glob':
        case 'Grep': {
          const pattern = str(input.pattern);
          if (pattern === undefined || pattern === '') return fail('pattern이 필요합니다');
          const base = await confine(cwd, str(input.path) ?? '.');
          if (!base.ok) return fail(base.reason);
          try {
            if (!(await stat(base.real)).isDirectory()) return fail(`폴더가 아닙니다: ${str(input.path)}`);
          } catch {
            return fail(`폴더를 확인할 수 없습니다: ${str(input.path)}`);
          }
          // 패턴은 시작 폴더 기준으로 맞추고, 결과 경로는 작업 폴더 기준으로 돌려준다
          let root: string;
          try {
            root = await realpath(cwd);
          } catch {
            return fail('작업 폴더를 확인할 수 없습니다');
          }
          const baseRel = path.relative(root, base.real).split(path.sep).join('/');
          const outPath = (rel: string) => (baseRel === '' ? rel : `${baseRel}/${rel}`);
          const notes = (walked: Walked) => [walked.truncated ? `(결과가 잘렸습니다: truncated, 상한 ${MAX_RESULTS}개·방문 ${MAX_VISITED}개)` : '', walked.skippedDirs > 0 ? `(건너뛴 폴더 ${walked.skippedDirs}개: .git·node_modules·읽을 수 없는 폴더)` : ''].filter(Boolean);
          if (name === 'Glob') {
            const regex = globToRegExp(pattern);
            const walked = await walk(base.real, (rel) => regex.test(rel), MAX_RESULTS);
            return ok([...(walked.files.length > 0 ? walked.files.map(outPath) : ['(맞는 파일 없음)']), ...notes(walked)].join('\n'));
          }
          let regex: RegExp;
          try {
            regex = new RegExp(pattern);
          } catch {
            return fail('정규식이 올바르지 않습니다');
          }
          const fileFilter = str(input.glob) ? globToRegExp(str(input.glob)!) : undefined;
          const walked = await walk(base.real, (rel) => !fileFilter || fileFilter.test(rel) || fileFilter.test(path.posix.basename(rel)), MAX_VISITED);
          const lines: string[] = [];
          let truncated = walked.truncated;
          let unreadable = 0;
          for (const rel of walked.files) {
            if (lines.length >= MAX_RESULTS) {
              truncated = true;
              break;
            }
            const read = await readTextFile(path.join(base.real, rel), outPath(rel));
            if (!read.ok || read.text.includes('\0')) {
              unreadable++;
              continue;
            }
            for (const [index, line] of read.text.split('\n').entries()) {
              if (!regex.test(line)) continue;
              if (lines.length >= MAX_RESULTS) {
                truncated = true;
                break;
              }
              lines.push(`${outPath(rel)}:${index + 1}:${line.slice(0, 500)}`);
            }
          }
          const extra = [truncated ? `(결과가 잘렸습니다: truncated, 상한 ${MAX_RESULTS}줄)` : '', unreadable > 0 ? `(읽지 않은 파일 ${unreadable}개: 크거나 이진이거나 읽을 수 없음)` : '', walked.skippedDirs > 0 ? `(건너뛴 폴더 ${walked.skippedDirs}개: .git·node_modules·읽을 수 없는 폴더)` : ''].filter(Boolean);
          return ok([...(lines.length > 0 ? lines : ['(맞는 줄 없음)']), ...extra].join('\n'));
        }
        default:
          return fail(`알 수 없는 도구입니다: ${name}`);
      }
    },
  };
}
