import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as legacy from './host-terminal-legacy';
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
 * 이 컴퓨터 방식 터미널의 관문 글과 폴더를 Rust로 옮기면서(4f C1 5단계) 옛 TS 구현(`host-terminal-legacy.ts`)을 기준값으로 남겼다.
 * 같은 입력을 옛 구현과 지금 껍데기(Rust)에 넣어 결과가 같은지 견준다. 셸 주입·옵션 주입을 막는 자리라
 * 따옴표·작은따옴표·`$`·백틱·줄바꿈·NUL·`-`로 시작하는 글·유니코드를 넣는다.
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

const NASTY = [
  '',
  ' ',
  '  ',
  '\t',
  '\n',
  '\r\n',
  "'",
  "a b'c",
  '"',
  '\\',
  '\\\\n',
  '$',
  '${x}',
  '$(id)',
  '`',
  '`${1}`',
  '--',
  '--settings',
  '--settings=/x',
  '-x',
  '--dangerously-skip-permissions',
  'a b',
  'update',
  ' update ',
  '#',
  '; rm -rf /',
  '한글 😀 é',
  '\u00a0x\u00a0',
  '\u0007\u001f\u007f',
  '\0',
  'a\0b',
  '﻿',
];

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

function compared(label: string, oldValue: unknown, newValue: unknown): void {
  expect({ label, value: newValue }).toEqual({ label, value: oldValue });
}

describe('관문 글: 옛 TS와 바이트까지 같다', () => {
  it('shellQuote: 모든 자리에 그대로 넣어도 같다', () => {
    for (const value of NASTY) compared(value, legacy.shellQuote(value), shellQuote(value));
  });

  it('firstPromptArg: 값과 거절(빈 글·NUL·길이)이 같다', () => {
    const values = [...NASTY, 'x'.repeat(10_001), 'x'.repeat(10_000), 'a\0b c', '\0'];
    for (const value of values) compared(value, observe(() => legacy.firstPromptArg(value)), observe(() => firstPromptArg(value)));
  });

  it('resumeConversationArg·isResumableConversation: 꼴과 거절이 같다', () => {
    const values = [...NASTY, '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', 'abc_123', 'x'.repeat(128), 'x'.repeat(129), 'a b', '-x'];
    for (const value of values) {
      compared(value, observe(() => legacy.resumeConversationArg(value)), observe(() => resumeConversationArg(value)));
      compared(value, legacy.isResumableConversation(value), isResumableConversation(value));
    }
    expect(legacy.isResumableConversation(42)).toBe(isResumableConversation(42));
    expect(legacy.isResumableConversation(undefined)).toBe(isResumableConversation(undefined));
  });

  it('cliModelArg: 꼴과 거절이 같다', () => {
    const values = [...NASTY, 'sonnet', 'claude-sonnet-5[1m]', 'openai/gpt-5.5', 'model:tag_1', 'x'.repeat(128), 'x'.repeat(129)];
    for (const value of values) compared(value, observe(() => legacy.cliModelArg(value)), observe(() => cliModelArg(value)));
  });

  it('hostTerminalEnv: 허용 이름·접두어·추가 이름·PATH가 같다', () => {
    const envs: Array<Record<string, string | undefined>> = [
      { PATH: '/repo/node_modules/.bin:/usr/bin', HOME: '/home/kim', LANG: 'ko_KR.UTF-8', LC_ALL: 'C', XDG_CONFIG_HOME: '/home/kim/.config', CLAUDECODE: '1', NODE_ENV: 'development', B_STUDIO_SECRET: 'x' },
      { B_STUDIO_TERMINAL_ENV: 'HTTPS_PROXY, AWS_PROFILE', HTTPS_PROXY: "http://p'x", AWS_PROFILE: 'dev', OTHER: 'x' },
      { B_STUDIO_TERMINAL_ENV: ' , , TERM ', TERM: 'screen' },
      { B_STUDIO_TERMINAL_ENV: 'LANG' },
      { B_STUDIO_TERMINAL_ENV: 'A-B' },
      { B_STUDIO_TERMINAL_ENV: 'B_STUDIO_TOKEN' },
      { B_STUDIO_TERMINAL_ENV: 'BAD NAME' },
      { B_STUDIO_TERMINAL_ENV: '한글' },
    ];
    for (const env of envs) {
      for (const gateway of [undefined, '', '/gateway', "/gw 'q' $x `y`\n한"]) {
        compared(JSON.stringify([gateway, env]), observe(() => legacy.hostTerminalEnv(gateway, env)), observe(() => hostTerminalEnv(gateway, env)));
      }
    }
  });

  it('hostTerminalCommand·hostShellLaunch(대체 명령): 감싸개와 첫 실행 글이 같다', () => {
    for (const kind of ['claude', 'codex'] as const) {
      compared(kind, legacy.hostTerminalCommand(kind), hostTerminalCommand(kind));
      for (const dir of ["/gw", "/gw 'q' $x `y`\n한"]) {
        compared(`${kind} ${dir}`, legacy.hostShellLaunch(dir, { SHELL: '/usr/bin/fish' }, kind), hostShellLaunch(dir, { SHELL: '/usr/bin/fish' }, kind));
      }
    }
  });

  it('hostGatewaySettings: 디렉터리·노드 경로에 셸 글자가 있어도 같다', () => {
    for (const dir of ['/gateway', "/gw 'q' $x `y`\n한"]) {
      for (const node of ['/usr/local/bin/node', "/n o'de $x `y`"]) {
        compared(`${dir} ${node}`, legacy.hostGatewaySettings(address, dir, node), hostGatewaySettings(address, dir, node));
      }
    }
  });

  it('hostCliWrapper: 감싸개 인자 순서와 계정 줄이 같다', () => {
    for (const dir of ['/gateway', "/gw 'q' $x `y`\n한"]) {
      for (const claudePath of ['/usr/local/bin/claude', "/c 'l' $x"]) {
        for (const configDir of [undefined, '/home/kim/.claude', "/a 'c' $x `y`"]) {
          compared(`${dir} ${claudePath} ${configDir}`, legacy.hostCliWrapper(dir, claudePath, configDir), hostCliWrapper(dir, claudePath, configDir));
        }
      }
    }
  });

  it('hostZshFiles·hostBashRc: 사용자 파일·별칭·첫 실행 줄이 같다', () => {
    for (const dir of ['/gateway', "/gw 'q' $x `y`\n한"]) {
      for (const kind of ['claude', 'codex'] as const) {
        compared(`${kind} ${dir}`, legacy.hostZshFiles(dir, kind), hostZshFiles(dir, kind));
        compared(`${kind} ${dir} bash`, legacy.hostBashRc(dir, kind), hostBashRc(dir, kind));
      }
    }
  });

  it('expectedHostGatewayFiles: 기대 파일·내용·권한이 같다', () => {
    const variants: HostCli[] = [
      cli,
      { ...cli, configDir: "/a 'c' $x", statusLine: 'my-line' },
      { kind: 'codex', cliPath: '/opt/bin/codex', nodePath: '/usr/local/bin/node' },
    ];
    for (const variant of variants) {
      compared(variant.kind, legacy.expectedHostGatewayFiles(address, '/gateway', variant), expectedHostGatewayFiles(address, '/gateway', variant));
    }
  });

  it('환경 변수 이름 상수는 옛 것과 같다', () => {
    expect(FIRST_PROMPT_ENV).toBe(legacy.FIRST_PROMPT_ENV);
    expect(RESUME_CONVERSATION_ENV).toBe(legacy.RESUME_CONVERSATION_ENV);
    expect(CLI_MODEL_ENV).toBe(legacy.CLI_MODEL_ENV);
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

describe('관문 폴더: 옛 TS와 같은 상태를 만든다', () => {
  it('쓰기·검사·지우기: 같은 파일·권한·내용, 같은 위반 목록, 같은 지운 뒤 모습', async () => {
    const root = await tempDir('b-studio-gateway-diff-');
    const legacyDir = await legacy.writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    const legacyWritten = await snapshot(root);
    const legacyExpected = legacy.expectedHostGatewayFiles(address, legacyDir, cli);
    expect(await legacy.checkHostGatewayConfig(legacyDir, legacyExpected)).toEqual([]);
    await legacy.removeHostGatewayConfig('studio-orders-abc', root);
    const legacyRemoved = await snapshot(root);

    const dir = await writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    expect(dir).toBe(legacyDir);
    expect(await snapshot(root)).toEqual(legacyWritten);
    const expected = expectedHostGatewayFiles(address, dir, cli);
    expect(expected).toEqual(legacyExpected);
    expect(await checkHostGatewayConfig(dir, expected)).toEqual([]);

    // 같은 변형에 같은 위반 목록
    await writeFile(path.join(dir, 'settings.json'), '{}\n');
    await chmod(path.join(dir, 'bin'), 0o755);
    await chmod(dir, 0o755);
    expect((await checkHostGatewayConfig(dir, expected)).sort()).toEqual((await legacy.checkHostGatewayConfig(dir, legacyExpected)).sort());

    // 고친 뒤 다시 쓰면 양쪽 다 깨끗해진다
    await writeHostGatewayConfig('studio-orders-abc', address, cli, root);
    expect(await checkHostGatewayConfig(dir, expected)).toEqual([]);
    expect(await legacy.checkHostGatewayConfig(dir, legacyExpected)).toEqual([]);

    await removeHostGatewayConfig('studio-orders-abc', root);
    expect(await snapshot(root)).toEqual(legacyRemoved);
  });

  it('상태 줄·계정 폴더·codex 갈래도 같은 나무를 만든다', async () => {
    for (const variant of [{ ...cli, configDir: '/tmp/acct', statusLine: 'my-line' }, { kind: 'codex' as const, cliPath: '/opt/bin/codex', nodePath: '/usr/local/bin/node' }]) {
      const root = await tempDir('b-studio-gateway-diff-');
      const legacyDir = await legacy.writeHostGatewayConfig('s-one', address, variant, root);
      const legacyWritten = await snapshot(root);
      await legacy.removeHostGatewayConfig('s-one', root);
      const legacyRemoved = await snapshot(root);

      const dir = await writeHostGatewayConfig('s-one', address, variant, root);
      expect(dir).toBe(legacyDir);
      expect(await snapshot(root)).toEqual(legacyWritten);
      await removeHostGatewayConfig('s-one', root);
      expect(await snapshot(root)).toEqual(legacyRemoved);
    }
  });

  it('관문 폴더 자체가 링크면 둘 다 쓰지 않고 같은 글로 거절하며 너머를 건드리지 않는다', async () => {
    const run = async (write: typeof legacy.writeHostGatewayConfig): Promise<{ failure: unknown; outside: Entry[] }> => {
      const root = await tempDir('b-studio-gateway-link-');
      const outside = await tempDir('b-studio-gateway-link-out-');
      await writeFile(path.join(outside, 'keep'), '건드리지 마라\n');
      await symlink(outside, path.join(root, 'studio-orders-link'));
      const failure = await write('studio-orders-link', address, cli, root).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      return { failure: failure ? { name: failure.name, message: failure.message.split(root).join('<ROOT>') } : undefined, outside: await snapshot(outside) };
    };
    const old = await run(legacy.writeHostGatewayConfig);
    const now = await run(writeHostGatewayConfig);
    expect(now).toEqual(old);
    expect((old.failure as { name: string }).name).toBe('SandboxError');
    expect((old.failure as { message: string }).message.startsWith('관문 폴더가 심볼릭 링크입니다\n')).toBe(true);
  });

  it('지우기: 하위 폴더가 링크면 링크만 지우고, .zcompdump*는 파일·링크만 지운다(#1296)', async () => {
    const root = await tempDir('b-studio-gateway-remove-');
    const outside = await tempDir('b-studio-gateway-remove-out-');
    await writeFile(path.join(outside, 'claude'), '건드리지 마라\n');
    await writeFile(path.join(outside, 'keep'), '건드리지 마라\n');

    // 옛 구현
    const legacyDir = await legacy.writeHostGatewayConfig('studio-orders-rm', address, cli, root);
    await rm(path.join(legacyDir, 'bin'), { recursive: true, force: true });
    await symlink(outside, path.join(legacyDir, 'bin'));
    const zsh = path.join(legacyDir, 'shell/zsh');
    await writeFile(path.join(zsh, '.zcompdump-host-5.9'), 'dump');
    await writeFile(path.join(zsh, '.zcompdump-host-5.9.zwc'), 'zwc');
    await symlink(path.join(outside, 'keep'), path.join(zsh, '.zcompdump-link'));
    await mkdir(path.join(zsh, '.zcompdump-dir'));
    await writeFile(path.join(zsh, '.zcompdump-dir/inner'), '폴더 안');
    await writeFile(path.join(zsh, 'notes.txt'), '남겨 둘 것');
    await legacy.removeHostGatewayConfig('studio-orders-rm', root);
    const legacyTree = await snapshot(root);
    const legacyOutside = await snapshot(outside);

    // 새 구현
    const dir = await writeHostGatewayConfig('studio-orders-rm', address, cli, root);
    expect(dir).toBe(legacyDir);
    await rm(path.join(dir, 'bin'), { recursive: true, force: true });
    await symlink(outside, path.join(dir, 'bin'));
    await writeFile(path.join(zsh, '.zcompdump-host-5.9'), 'dump');
    await writeFile(path.join(zsh, '.zcompdump-host-5.9.zwc'), 'zwc');
    await symlink(path.join(outside, 'keep'), path.join(zsh, '.zcompdump-link'));
    await mkdir(path.join(zsh, '.zcompdump-dir'), { recursive: true });
    await writeFile(path.join(zsh, '.zcompdump-dir/inner'), '폴더 안');
    await writeFile(path.join(zsh, 'notes.txt'), '남겨 둘 것');
    await removeHostGatewayConfig('studio-orders-rm', root);
    expect(await snapshot(root)).toEqual(legacyTree);
    expect(await snapshot(outside)).toEqual(legacyOutside);
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

    const old = await run(legacy.removeHostGatewayConfig);
    const now = await run(removeHostGatewayConfig);
    for (const [name, result] of [
      ['legacy', old],
      ['new', now],
    ] as const) {
      // (a) 관문 폴더 자리(링크)가 없어졌다
      expect({ name, linkGone: result.linkGone }).toEqual({ name, linkGone: true });
      // (b) 링크 너머의 나무는 그대로다 — 같은 이름의 파일·폴더와 .zcompdump까지
      expect({ name, tree: result.after }).toEqual({ name, tree: result.before });
    }
    expect(now.after).toEqual(old.after);
    expect(now.linkGone).toBe(old.linkGone);
  });
});
