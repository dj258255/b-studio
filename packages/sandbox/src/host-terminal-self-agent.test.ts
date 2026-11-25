import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkHostGatewayConfig,
  expectedHostGatewayFiles,
  hostCliWrapper,
  removeHostGatewayConfig,
  SELF_AGENT_LAUNCHER_FILE,
  SELF_AGENT_MODEL_FILE,
  selfAgentLauncher,
  writeHostGatewayConfig,
  type HostCli,
} from './host-terminal';

/** API 모드 세션의 자체 CLI 실행기와 모델 파일(ADR-226). 진짜 모델·CLI는 부르지 않는다 */

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
const plain: HostCli = { kind: 'claude', cliPath: '/usr/local/bin/claude', nodePath: '/usr/local/bin/node' };
const selfCli: HostCli = {
  ...plain,
  selfAgent: { entry: '/repo/apps/cli/src/agent-tty.ts', loader: '/repo/node_modules/tsx/dist/loader.mjs', model: { profile: { id: 'm', provider: 'openai' }, apiKey: 'sk-test' } },
};

describe('자체 CLI 기대 파일', () => {
  it('자체 CLI가 없으면 파일 집합이 그대로다', () => {
    const names = Object.keys(expectedHostGatewayFiles(address, '/gateway', plain));
    expect(names).not.toContain(SELF_AGENT_LAUNCHER_FILE);
    expect(names).not.toContain(SELF_AGENT_MODEL_FILE);
  });

  it('실행기(700, 정해진 글)와 모델 파일(600)이 더해지고 감싸개가 실행기를 부른다', () => {
    const files = expectedHostGatewayFiles(address, '/gateway', selfCli);
    expect(files[SELF_AGENT_LAUNCHER_FILE]).toEqual({
      content: `#!/bin/bash\nexec -a '/gateway/agent-tty' '/usr/local/bin/node' --import '/repo/node_modules/tsx/dist/loader.mjs' '/repo/apps/cli/src/agent-tty.ts' "$@"\n`,
      mode: 0o700,
    });
    expect(files[SELF_AGENT_MODEL_FILE]!.mode).toBe(0o600);
    expect(JSON.parse(files[SELF_AGENT_MODEL_FILE]!.content)).toEqual({ profile: { id: 'm', provider: 'openai' }, apiKey: 'sk-test' });
    expect(files['bin/claude']!.content).toBe(hostCliWrapper('/gateway', '/gateway/agent-tty'));
    expect(files['bin/claude']!.content).not.toContain('/usr/local/bin/claude');
    // 상태 줄은 쓰지 않는다
    expect(files['statusline.json']).toBeUndefined();
  });

  it('빈칸·작은따옴표가 든 경로도 한 덩어리로 넘어간다(진짜 bash로 돌려 본다)', async () => {
    const base = await tempDir('b-studio-selfagent-');
    const dir = path.join(base, "gate way's");
    await mkdir(dir);
    const fakeNode = path.join(base, "no de's");
    await writeFile(fakeNode, '#!/bin/bash\nprintf "%s\\n" "$0" "$@"\n');
    await chmod(fakeNode, 0o700);
    const launcher = path.join(dir, SELF_AGENT_LAUNCHER_FILE);
    await writeFile(launcher, selfAgentLauncher(dir, fakeNode, { entry: path.join(base, "e ntry's.ts"), loader: path.join(base, 'l oader.mjs') }), { mode: 0o700 });
    const out = execFileSync(launcher, ['--settings', 'a b', "c'd"], { encoding: 'utf8' }).split('\n');
    expect(out.slice(1, 8)).toEqual(['--import', path.join(base, 'l oader.mjs'), path.join(base, "e ntry's.ts"), '--settings', 'a b', "c'd", '']);
  });

  it('쓰면 모델 파일은 600이고 변조를 알아채며, 멈추면 두 파일이 지워진다', async () => {
    const root = await tempDir('b-studio-selfagent-gw-');
    const dir = await writeHostGatewayConfig('studio-self-agent', address, selfCli, root);
    expect((await stat(path.join(dir, SELF_AGENT_MODEL_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, SELF_AGENT_LAUNCHER_FILE))).mode & 0o777).toBe(0o700);
    const expected = expectedHostGatewayFiles(address, dir, selfCli);
    expect(await checkHostGatewayConfig(dir, expected)).toEqual([]);
    await writeFile(path.join(dir, SELF_AGENT_LAUNCHER_FILE), '#!/bin/bash\necho evil\n');
    await chmod(path.join(dir, SELF_AGENT_MODEL_FILE), 0o644);
    expect((await checkHostGatewayConfig(dir, expected)).sort()).toEqual([SELF_AGENT_MODEL_FILE, SELF_AGENT_LAUNCHER_FILE].sort());
    expect(await readFile(path.join(dir, SELF_AGENT_MODEL_FILE), 'utf8')).toContain('sk-test');
    await removeHostGatewayConfig('studio-self-agent', root);
    expect(existsSync(path.join(dir, SELF_AGENT_MODEL_FILE))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});
