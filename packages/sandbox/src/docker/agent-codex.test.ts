import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexGatewayArgs, shellQuote } from '../host-terminal';
import { EDGE_IMAGE } from '../edge-config';
import { AGENT_CODEX_TERMINAL_COMMAND, AGENT_CODEX_WRAPPER_PATH, agentCodexFiles, agentCodexWrapper } from './agent-codex';
import { AGENT_CODEX_BIN, AGENT_CODEX_IMAGE, agentImageExists } from './agent-image';
import {
  AGENT_GATEWAY_TARGET,
  AGENT_HOOK_SCRIPT,
  AGENT_HOME_VOLUME_PREFIX,
  AGENT_NODE,
  CODEX_HOOK_SCRIPT_NAME,
  agentRunArgs,
  removeAgentGatewayConfig,
  writeAgentGatewayConfig,
  type AgentGatewayAddress,
} from './agent-terminal';

const address: AgentGatewayAddress = { hookUrl: 'http://host.docker.internal:4101/hook', hookToken: 'hook-secret-TOKEN', mcpUrl: 'http://host.docker.internal:4102/mcp', mcpToken: 'mcp-secret-TOKEN' };

describe('컨테이너 방식 codex 감싸개(ADR-245)', () => {
  const wrapper = agentCodexWrapper(address);

  it('호스트(이 컴퓨터 방식)의 설정 덮어쓰기를 그대로 쓴다 — 훅 명령은 컨테이너의 관문 폴더 스크립트를 가리킨다', () => {
    const hostArgs = codexGatewayArgs(address, AGENT_GATEWAY_TARGET, AGENT_NODE);
    // 훅 명령 글이 세션마다 같다(Codex는 명령 글의 해시로 신뢰를 기억한다)
    expect(hostArgs.some((arg) => arg.includes(`${AGENT_GATEWAY_TARGET}/${CODEX_HOOK_SCRIPT_NAME}`))).toBe(true);
    for (const arg of hostArgs) expect(wrapper, arg).toContain(shellQuote(arg));
    expect(wrapper).toContain(shellQuote(AGENT_CODEX_BIN));
  });

  it('토큰은 감싸개·인자·훅 스크립트에 없고 환경 파일에만 있다', () => {
    const files = agentCodexFiles(address);
    for (const [name, content] of Object.entries(files)) {
      if (name === 'codex.env') continue;
      expect(content, name).not.toContain(address.hookToken);
      expect(content, name).not.toContain(address.mcpToken);
    }
    expect(files['codex.env']).toContain(address.mcpToken);
    expect(files['codex.env']).toContain(address.hookToken.replace(/ /g, '%20'));
  });

  it('훅 스크립트는 claude와 같은 것이고 이름은 호스트 codex와 같다', () => {
    const files = agentCodexFiles(address);
    expect(files[CODEX_HOOK_SCRIPT_NAME]).toBe(AGENT_HOOK_SCRIPT);
    expect(Object.keys(files).sort()).toEqual(['codex-rc', 'codex-wrapper', 'codex.env', CODEX_HOOK_SCRIPT_NAME].sort());
  });

  it('대화형일 때만 세션 시작·끝을 알리고, 하위 명령·도움말은 알리지 않는다', () => {
    expect(wrapper).toContain('session-start');
    expect(wrapper).toContain('session-end');
    expect(wrapper).toContain("''|-*|resume|fork) interactive=1");
    expect(wrapper).toContain('-h|--help|-V|--version) ;;');
    expect(wrapper).toMatch(/\[ -n "\$interactive" \] \|\| exec /);
  });

  it('실행 파일은 이미지의 에이전트가 쓸 수 없는 자리다: 읽기 전용 루트, root가 아닌 사용자, 홈·작업·tmp 밖', () => {
    expect(AGENT_CODEX_BIN.startsWith('/opt/b-studio/')).toBe(true);
    const args = agentRunArgs({ name: 'n', sandboxId: 's', projectRoot: '/tmp/p', masks: [], homeVolume: `${AGENT_HOME_VOLUME_PREFIX}-p`, image: AGENT_CODEX_IMAGE });
    expect(args).toContain('--read-only');
    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2)).toEqual(['--user', 'node']);
    // 어떤 마운트도 /opt를 덮지 않는다(에이전트가 쓸 수 있는 볼륨·바인드가 codex 자리에 올라오지 않는다)
    const targets = args.filter((value) => value.startsWith('type=')).map((value) => /target=([^,]+)/.exec(value)?.[1] ?? '');
    for (const target of targets) expect(target.startsWith('/opt'), target).toBe(false);
    expect(args).toContain(AGENT_CODEX_IMAGE);
    // tmpfs도 /opt가 아니다
    expect(args.filter((value) => value.startsWith('/tmp:')).length).toBe(1);
  });
});

describe('codex 터미널 명령', () => {
  /** 감싸개와 rcfile 자리를 임시 폴더의 가짜로 바꿔 진짜 sh로 돌린다(진짜 codex·도커 없음) */
  async function run(env: Record<string, string>): Promise<{ stdout: string; args: string[] }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-codexcmd-'));
    try {
      const fakeWrapper = path.join(dir, 'wrapper');
      await writeFile(fakeWrapper, '#!/bin/sh\nprintf "ARGC=%s\\n" "$#"\nfor a in "$@"; do printf "ARG=%s\\n" "$a"; done\nprintf "ENV=%s\\n" "${B_STUDIO_FIRST_PROMPT-unset}"\n');
      await chmod(fakeWrapper, 0o755);
      // exec bash --rcfile …은 끝에서 셸로 남는 줄이라 `true`로 바꾼다
      const command = AGENT_CODEX_TERMINAL_COMMAND.replaceAll(AGENT_CODEX_WRAPPER_PATH, fakeWrapper).replace(/exec bash --rcfile .*$/m, 'true');
      const stdout = execFileSync('sh', ['-c', command], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
      return { stdout, args: stdout.split('\n').filter((line) => line.startsWith('ARG=')).map((line) => line.slice(4)) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('첫 요청은 인자 하나로 한 번만 넘기고 환경에서 지운다(따옴표·$()·백틱이 셸에 해석되지 않는다)', async () => {
    const prompt = `요청 "큰따옴표" '작은따옴표' $(touch /tmp/x) \`id\` $HOME`;
    const result = await run({ B_STUDIO_FIRST_PROMPT: prompt });
    expect(result.args).toEqual([prompt]);
    expect(result.stdout).toContain('ENV=unset');
  });

  it('첫 요청이 없으면 인자 없이 띄운다', async () => {
    const result = await run({});
    expect(result.args).toEqual([]);
  });

  it('설치 단계가 없다(이미지에 있다) — 홈 볼륨에 npm으로 깔지 않는다', () => {
    expect(AGENT_CODEX_TERMINAL_COMMAND).not.toContain('npm');
    expect(AGENT_CODEX_TERMINAL_COMMAND).toContain('exec bash --rcfile');
  });
});

describe('관문 폴더의 codex 파일 쓰기와 정리', () => {
  async function tmp(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'b-studio-codexgw-'));
  }

  it('codex 파일을 더 쓰고, 세션이 멈추면 이 코드가 쓴 파일만 지운다', async () => {
    const root = await tmp();
    try {
      const dir = await writeAgentGatewayConfig('studio-x-abc', address, root, agentCodexFiles(address));
      const names = (await readdir(dir)).sort();
      expect(names).toEqual(expect.arrayContaining(['b-studio-codex-hook.mjs', 'codex-rc', 'codex-wrapper', 'codex.env', 'managed-settings.json']));
      expect(await readFile(path.join(dir, 'codex-wrapper'), 'utf8')).toBe(agentCodexWrapper(address));
      // 남의 파일이 있으면 폴더는 남긴다
      await writeFile(path.join(dir, 'keep.txt'), 'x');
      await removeAgentGatewayConfig('studio-x-abc', root);
      expect((await readdir(dir)).sort()).toEqual(['keep.txt']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('정해 둔 이름이 아닌 파일은 더하지 않는다(정리 목록 밖의 파일이 남지 않게)', async () => {
    const root = await tmp();
    try {
      for (const name of ['evil.sh', '../escape', 'managed-settings.json', 'b-studio-hook.mjs']) {
        await expect(writeAgentGatewayConfig('studio-y-abc', address, root, { [name]: 'x' }), name).rejects.toThrow();
      }
      await mkdir(path.join(root, 'ok'), { recursive: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('에이전트 이미지 파일', () => {
  const dockerfile = path.resolve(__dirname, '../../agent-image/Dockerfile');
  const buildScript = path.resolve(__dirname, '../../agent-image/build.sh');
  const imageSource = path.resolve(__dirname, './agent-image.ts');

  it('Dockerfile: 기본 이미지와 같은 바탕, 고정한 codex 판, root 소유·쓰기 불가 자리, 마지막은 node 사용자', async () => {
    const text = await readFile(dockerfile, 'utf8');
    const instructions = text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
    expect(instructions[0]).toBe(`FROM ${EDGE_IMAGE}`);
    expect(text).toMatch(/ARG CODEX_VERSION=\d+\.\d+\.\d+\n/);
    expect(text).toContain('--prefix /opt/b-studio/codex');
    expect(text).toContain('chown -R root:root /opt/b-studio');
    expect(text).toMatch(/chmod -R go-w/);
    // 마지막 USER가 node다(컨테이너가 root로 돌지 않는다) — agentRunArgs도 --user node를 준다
    const users = instructions.filter((line) => line.startsWith('USER '));
    expect(users.at(-1)).toBe('USER node');
    // 받아서 바로 실행하는 설치, 홈·작업 폴더 설치, 최신 판 태그는 쓰지 않는다
    expect(instructions.join('\n')).not.toMatch(/curl|wget|\| *(ba)?sh|@latest|\/home\/node|\/workspace/);
    // 모델 키·토큰을 이미지에 넣지 않는다
    expect(instructions.join('\n')).not.toMatch(/API_KEY|TOKEN|SECRET/);
  });

  it('build.sh가 읽는 이미지 이름이 AGENT_CODEX_IMAGE와 같다', async () => {
    const source = await readFile(imageSource, 'utf8');
    const match = /^export const AGENT_CODEX_IMAGE = '(.*)';$/m.exec(source);
    expect(match?.[1]).toBe(AGENT_CODEX_IMAGE);
    const script = await readFile(buildScript, 'utf8');
    expect(script).toContain('docker build --tag "$tag" "$here"');
    expect(script).not.toMatch(/prune|rm -rf|--no-cache|push/);
  });

  it('이미지가 있는지 묻는다: 있으면 참, 없거나 도커가 답하지 않으면 거짓', async () => {
    const dir = await tmp2();
    try {
      const ok = path.join(dir, 'docker-ok');
      const bad = path.join(dir, 'docker-bad');
      await writeFile(ok, '#!/bin/sh\n[ "$1 $2" = "image inspect" ] || exit 9\nexit 0\n');
      await writeFile(bad, '#!/bin/sh\nexit 1\n');
      await chmod(ok, 0o755);
      await chmod(bad, 0o755);
      expect(await agentImageExists('img:1', { dockerBin: ok })).toBe(true);
      expect(await agentImageExists('img:1', { dockerBin: bad })).toBe(false);
      expect(await agentImageExists('img:1', { dockerBin: path.join(dir, 'nope') })).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function tmp2(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'b-studio-agentimg-'));
}
