import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLI_MODEL_ENV,
  checkHostGatewayConfig,
  cliModelArg,
  expectedHostGatewayFiles,
  FIRST_PROMPT_ENV,
  firstPromptArg,
  hostBashRc,
  hostCliWrapper,
  hostGatewaySettings,
  hostShellLaunch,
  hostTerminalCommand,
  hostTerminalEnv,
  hostZshFiles,
  isResumableConversation,
  removeHostGatewayConfig,
  RESUME_CONVERSATION_ENV,
  resumeConversationArg,
  shellQuote,
  writeHostGatewayConfig,
  type HostCli,
} from './host-terminal';

/**
 * 이 컴퓨터 방식 터미널의 관문 글과 폴더(4f C1 5단계) 시험. 셸 주입·옵션 주입을 막는 자리라 따옴표·작은따옴표·`$`·백틱·줄바꿈·NUL·`-`로 시작하는 글·유니코드를 넣는다.
 * 옛 TS 구현과 견주던 시험(#1347에서 옛 구현을 지웠다)에서, 옛 구현이 낸 값은 지우기 전에 한 번 재어 JSON으로 고정했다.
 *  - `host-terminal-text-vectors.json`: 관문 글 함수 239개 호출의 인자와 기대값(거절한 입력은 오류의 이름·글)
 *  - `host-terminal-gateway-tree.json`: 관문 폴더를 쓰고 지운 뒤의 파일 나무(경로·종류·권한), 검사가 내는 위반 목록
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const address = { hookUrl: 'http://127.0.0.1:41234', hookToken: 'hook-token', mcpUrl: 'http://127.0.0.1:41235/mcp', mcpToken: 'mcp-token' };
const cli: HostCli = { kind: 'claude', cliPath: '/usr/local/bin/claude', nodePath: '/usr/local/bin/node' };


interface TextVector {
  fn: string;
  args: unknown[];
  expected: unknown;
}
const TEXT_VECTORS = JSON.parse(readFileSync(new URL('./host-terminal-text-vectors.json', import.meta.url), 'utf8')) as TextVector[];
const TREE = JSON.parse(readFileSync(new URL('./host-terminal-gateway-tree.json', import.meta.url), 'utf8')) as Record<string, unknown>;

interface Failure {
  name: string;
  message: string;
  detail: unknown;
}

function observe(fn: () => unknown): unknown | Failure {
  try {
    return fn();
  } catch (error) {
    const failure = error as Error & { detail?: unknown };
    return { name: failure.name, message: failure.message, detail: failure.detail };
  }
}

const FUNCTIONS: Record<string, (...args: any[]) => unknown> = {
  shellQuote,
  firstPromptArg,
  resumeConversationArg,
  isResumableConversation,
  cliModelArg,
  hostTerminalEnv,
  hostTerminalCommand,
  hostShellLaunch,
  hostGatewaySettings,
  hostCliWrapper,
  hostZshFiles,
  hostBashRc,
  expectedHostGatewayFiles,
};

describe('관문 글: 옛 TS가 낸 값과 바이트까지 같다', () => {
  it.each(Object.keys(FUNCTIONS))('%s', (name) => {
    const vectors = TEXT_VECTORS.filter((vector) => vector.fn === name);
    expect(vectors.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const vector of vectors) {
      // JSON에서는 undefined 인자가 null로 적혀 있다
      const args = vector.args.map((arg) => (arg === null ? undefined : arg));
      const actual = JSON.parse(JSON.stringify(observe(() => FUNCTIONS[name]!(...args)) ?? null));
      if (JSON.stringify(actual) !== JSON.stringify(vector.expected)) bad.push(`${JSON.stringify(vector.args).slice(0, 200)}\n  기대 ${JSON.stringify(vector.expected).slice(0, 300)}\n  실제 ${JSON.stringify(actual).slice(0, 300)}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('고정한 벡터가 239개다', () => {
    expect(TEXT_VECTORS.length).toBe(239);
  });

  it('환경 변수 이름 상수', () => {
    expect(FIRST_PROMPT_ENV).toBe('B_STUDIO_FIRST_PROMPT');
    expect(RESUME_CONVERSATION_ENV).toBe('B_STUDIO_RESUME_ID');
    expect(CLI_MODEL_ENV).toBe('B_STUDIO_CLI_MODEL');
  });
});

// ── 관문 폴더 입출력 ──

interface Entry {
  path: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  mode: number;
  content?: string;
  target?: string;
}

/** 링크를 따라가지 않고 나무 전체를 적는다. 파일 내용은 UTF-8로 읽는다 */
async function snapshot(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const target = path.join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;
      const info = await lstat(target);
      const mode = info.mode & 0o777;
      if (info.isSymbolicLink()) {
        out.push({ path: rel, kind: 'link', mode, target: await readlink(target) });
      } else if (info.isDirectory()) {
        out.push({ path: rel, kind: 'dir', mode });
        await walk(target, rel);
      } else if (info.isFile()) {
        out.push({ path: rel, kind: 'file', mode, content: await readFile(target, 'utf8') });
      } else {
        out.push({ path: rel, kind: 'other', mode });
      }
    }
  };
  await walk(root, '');
  return out;
}

const shape = (entries: Entry[]) => entries.map(({ path: entryPath, kind, mode, target }) => ({ path: entryPath, kind, mode, ...(target === undefined ? {} : { target }) }));
const kinds = (entries: Entry[]) => entries.map(({ path: entryPath, kind }) => ({ path: entryPath, kind }));

describe('관문 폴더: 옛 TS와 같은 상태를 만든다(옛 TS가 낸 나무)', () => {
  it('쓰기·검사·지우기: 같은 파일·권한, 같은 위반 목록, 같은 지운 뒤 모습', async () => {
    const root = await tempDir('b-studio-gateway-diff-');
    const dir = await writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    expect(shape(await snapshot(root))).toEqual(TREE.written);
    const expected = expectedHostGatewayFiles(address, dir, cli);
    expect(await checkHostGatewayConfig(dir, expected)).toEqual([]);

    // 같은 변형에 같은 위반 목록
    await writeFile(path.join(dir, 'settings.json'), '{}\n');
    await chmod(path.join(dir, 'bin'), 0o755);
    await chmod(dir, 0o755);
    expect((await checkHostGatewayConfig(dir, expected)).map((violation) => violation.split(dir).join('<DIR>')).sort()).toEqual(TREE.violations);

    // 고친 뒤 다시 쓰면 깨끗해진다
    await writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    expect(await checkHostGatewayConfig(dir, expected)).toEqual([]);

    await removeHostGatewayConfig('studio-orders-abc', root);
    expect(shape(await snapshot(root))).toEqual(TREE.removed);
  });

  it('상태 줄·계정 폴더·codex 갈래도 같은 나무를 만든다', async () => {
    const variants = [
      ['v1', { ...cli, configDir: '/tmp/acct', statusLine: 'my-line' }],
      ['v2', { kind: 'codex' as const, cliPath: '/opt/bin/codex', nodePath: '/usr/local/bin/node' }],
    ] as const;
    for (const [key, variant] of variants) {
      const root = await tempDir('b-studio-gateway-diff-');
      await writeHostGatewayConfig('s-one', address, variant, root);
      expect(shape(await snapshot(root)), key).toEqual(TREE[key]);
      await removeHostGatewayConfig('s-one', root);
      expect(shape(await snapshot(root)), `${key} 지운 뒤`).toEqual(TREE[`${key}Removed`]);
    }
  });

  it('관문 폴더 자체가 링크면 쓰지 않고 거절하며 너머를 건드리지 않는다', async () => {
    const root = await tempDir('b-studio-gateway-link-');
    const outside = await tempDir('b-studio-gateway-link-out-');
    await writeFile(path.join(outside, 'keep'), '건드리지 마라\n');
    await symlink(outside, path.join(root, 'studio-orders-link'));
    const failure = await writeHostGatewayConfig('studio-orders-link', address, cli, root).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure ? { name: failure.name, message: failure.message.split(root).join('<ROOT>') } : undefined).toEqual(TREE.linkFailure);
    expect(failure?.name).toBe('SandboxError');
    expect(failure?.message.startsWith('관문 폴더가 심볼릭 링크입니다\n')).toBe(true);
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('건드리지 마라\n');
    expect((await readdir(outside)).sort()).toEqual(['keep']);
  });

  it('지우기: 하위 폴더가 링크면 링크만 지우고, .zcompdump*는 파일·링크만 지운다(#1296)', async () => {
    const root = await tempDir('b-studio-gateway-remove-');
    const outside = await tempDir('b-studio-gateway-remove-out-');
    await writeFile(path.join(outside, 'claude'), '건드리지 마라\n');
    await writeFile(path.join(outside, 'keep'), '건드리지 마라\n');

    const dir = await writeHostGatewayConfig('studio-orders-rm', address, cli, root);
    await rm(path.join(dir, 'bin'), { recursive: true, force: true });
    await symlink(outside, path.join(dir, 'bin'));
    const zsh = path.join(dir, 'shell/zsh');
    await writeFile(path.join(zsh, '.zcompdump-host-5.9'), 'dump');
    await writeFile(path.join(zsh, '.zcompdump-host-5.9.zwc'), 'zwc');
    await symlink(path.join(outside, 'keep'), path.join(zsh, '.zcompdump-link'));
    await mkdir(path.join(zsh, '.zcompdump-dir'), { recursive: true });
    await writeFile(path.join(zsh, '.zcompdump-dir/inner'), '폴더 안');
    await writeFile(path.join(zsh, 'notes.txt'), '남겨 둘 것');
    await removeHostGatewayConfig('studio-orders-rm', root);
    // 파일·링크인 .zcompdump*와 관문이 만든 것은 지우고, 폴더인 .zcompdump-dir와 notes.txt는 남긴다
    expect(kinds(await snapshot(root))).toEqual(TREE.rmTree);
    // 링크 너머는 그대로다
    expect(kinds(await snapshot(outside))).toEqual(TREE.rmOutside);
    expect(await readFile(path.join(outside, 'claude'), 'utf8')).toBe('건드리지 마라\n');
  });

  it('지우기: 관문 폴더 자체가 링크면 링크 자리만 지우고 대상 폴더의 나무는 그대로 둔다', async () => {
    const run = async (remove: (sandboxId: string, root: string) => Promise<void>) => {
      const root = await tempDir('b-studio-gateway-root-link-');
      const outside = await tempDir('b-studio-gateway-root-out-');
      // 링크 너머에 관문 파일 이름과 같은 파일·폴더를 진짜로 둔다
      await mkdir(path.join(outside, 'bin'), { recursive: true });
      await mkdir(path.join(outside, 'shell/zsh'), { recursive: true });
      await writeFile(path.join(outside, 'settings.json'), '남의 설정\n');
      await writeFile(path.join(outside, 'mcp.json'), '남의 mcp\n');
      await writeFile(path.join(outside, 'bin/claude'), '남의 감싸개\n');
      await writeFile(path.join(outside, 'shell/bashrc'), '남의 bashrc\n');
      await writeFile(path.join(outside, 'shell/zsh/.zprofile'), '남의 zprofile\n');
      await writeFile(path.join(outside, 'shell/zsh/.zcompdump-host-5.9'), '남의 dump\n');
      await writeFile(path.join(outside, 'notes.txt'), '남겨 둘 것\n');
      const before = await snapshot(outside);

      const link = path.join(root, 'studio-orders-root-link');
      await symlink(outside, link);
      await remove('studio-orders-root-link', root);
      const linkGone = await lstat(link).then(() => false, () => true);
      return { linkGone, before, after: await snapshot(outside) };
    };

    const now = await run(removeHostGatewayConfig);
    for (const [name, result] of [['new', now]] as const) {
      // (a) 관문 폴더 자리(링크)가 없어졌다
      expect({ name, linkGone: result.linkGone }).toEqual({ name, linkGone: true });
      // (b) 링크 너머의 나무는 그대로다 — 같은 이름의 파일·폴더와 .zcompdump까지
      expect({ name, tree: result.after }).toEqual({ name, tree: result.before });
    }
  });
});
