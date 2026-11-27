import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_CODEX_IMAGE, AGENT_CODEX_TERMINAL_COMMAND, firstPromptArg } from '@b-studio/sandbox';
import { afterEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ calls: [] as Array<{ sandboxId: string; root: string; options: Record<string, unknown> }> }));
// 진짜 도커를 부르지 않는다: 컨테이너를 띄우는 함수만 가짜로 바꿔 넘긴 옵션(이미지·홈 사용자·관문 폴더)을 본다
vi.mock('@b-studio/sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@b-studio/sandbox')>()),
  ensureAgentContainer: async (sandboxId: string, root: string, options: Record<string, unknown>) => {
    captured.calls.push({ sandboxId, root, options });
    return 'fake-container';
  },
}));
import { containerOpenOptions, containerPreflight, terminalBackend } from './session-terminal';

/**
 * 컨테이너 방식 터미널의 codex(ADR-245): 이미지 확인, 명령 고르기, 관문 없는 열기 거절. 도커는 부르지 않는다(이미지 확인은 주입한 가짜).
 */
describe('containerPreflight: 띄우기 전 이미지 확인', () => {
  it('codex는 에이전트 이미지가 이 도커에 있어야 한다. 없으면 만드는 명령을 알리며 거절한다', async () => {
    const exists = vi.fn(async () => false);
    const refused = await containerPreflight({ cli: 'codex', backend: 'codex' }, exists);
    expect(exists).toHaveBeenCalledWith(AGENT_CODEX_IMAGE);
    expect(refused).toContain(AGENT_CODEX_IMAGE);
    expect(refused).toContain('pnpm agent-image:build');
  });

  it('이미지가 있으면 통과한다', async () => {
    expect(await containerPreflight({ cli: 'codex', backend: 'codex' }, async () => true)).toBeUndefined();
  });

  it('claude는 이미지 확인을 하지 않는다. 모르는 CLI 이름도 codex로 읽지 않는다', async () => {
    const exists = vi.fn(async () => false);
    expect(await containerPreflight({ cli: 'claude', backend: 'claude-code' }, exists)).toBeUndefined();
    expect(await containerPreflight({ backend: 'claude-code' }, exists)).toBeUndefined();
    expect(exists).not.toHaveBeenCalled();
  });

  it('컨테이너가 띄우지 못하는 백엔드(api)·모르는 백엔드·백엔드를 알려 주지 않은 대상은 claude로 대신 띄우지 않고 거절한다', async () => {
    const exists = vi.fn(async () => true);
    for (const backend of ['api', 'gemini', 'commandcode', 'opencode', 'demo', '', 'CODEX']) {
      expect(await containerPreflight({ cli: 'claude', backend }, exists), backend).toContain('띄우지 못합니다');
    }
    expect(await containerPreflight({ cli: 'claude' }, exists)).toContain('띄우지 못합니다');
    expect(await containerPreflight({ cli: 'codex' }, exists)).toContain('띄우지 못합니다');
    expect(exists).not.toHaveBeenCalled();
  });

  it('컨테이너 백엔드가 이 검사를 건다', () => {
    expect(typeof terminalBackend('container').preflight).toBe('function');
  });
});

describe('containerOpenOptions: 터미널 명령 고르기', () => {
  const base = { id: 'main', size: { cols: 80, rows: 24 } };

  it('codex만 감싸개를 띄우는 명령을 쓰고, claude는 기본 명령(옵션 없음)이다', () => {
    expect(containerOpenOptions(base, 'codex').command).toBe(AGENT_CODEX_TERMINAL_COMMAND);
    expect(containerOpenOptions(base, 'claude')).not.toHaveProperty('command');
    expect(containerOpenOptions(base)).not.toHaveProperty('command');
    // 이 컴퓨터 방식 전용 CLI 이름이 컨테이너 명령으로 새지 않는다
    for (const cli of ['commandcode', 'opencode'] as const) expect(containerOpenOptions(base, cli)).not.toHaveProperty('command');
  });

  it('첫 요청은 codex에서도 같은 꼴로 넘긴다', () => {
    expect(containerOpenOptions({ ...base, initialPrompt: '요청' }, 'codex').firstPrompt).toBe(firstPromptArg('요청'));
  });
});

describe('컨테이너 방식 codex는 관문 없이 열 수 없다', () => {
  it('관문이 없으면 claude로 대신하지 않고 docker를 부르기 전에 409로 거절한다', async () => {
    const backend = terminalBackend('container');
    await expect(backend.prepare({ sandboxId: 'studio-x-abc', root: '/tmp/none', projectId: 'p', cli: 'codex' } as never)).rejects.toMatchObject({ status: 409 });
  });
});

describe('컨테이너 방식 prepare: 어떤 이미지와 관문 파일로 띄우는가', () => {
  const address = { hookUrl: 'http://host.docker.internal:1/hook', hookToken: 'h-token', mcpUrl: 'http://host.docker.internal:2/mcp', mcpToken: 'm-token' };
  let dir: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    captured.calls.length = 0;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function prepare(target: Record<string, unknown>): Promise<{ options: Record<string, unknown>; files: string[] }> {
    dir = await mkdtemp(path.join(tmpdir(), 'b-studio-prep-'));
    vi.stubEnv('B_STUDIO_AGENT_GATEWAY_DIR', dir);
    await terminalBackend('container').prepare({ sandboxId: 'studio-p-abc', root: '/tmp/none', projectId: 'orders', ...target } as never, address as never);
    const options = captured.calls.at(-1)!.options;
    return { options, files: (await readdir(options.gatewayDir as string)).sort() };
  }

  it('codex는 에이전트 이미지로 띄우고 관문 폴더에 codex 파일을 더한다. 서버 방식의 홈 사용자를 넘긴다', async () => {
    const { options, files } = await prepare({ cli: 'codex', homeUser: 'kim' });
    expect(options.image).toBe(AGENT_CODEX_IMAGE);
    expect(options.userId).toBe('kim');
    expect(options.projectId).toBe('orders');
    expect(files).toEqual(expect.arrayContaining(['codex-wrapper', 'codex.env', 'codex-rc', 'b-studio-codex-hook.mjs', 'managed-settings.json']));
  });

  it('claude는 기본 이미지(image 옵션 없음)와 기본 관문 파일만 쓴다. 개인 PC는 홈 사용자가 없다', async () => {
    const { options, files } = await prepare({ cli: 'claude' });
    expect(options).not.toHaveProperty('image');
    expect(options).not.toHaveProperty('userId');
    expect(files).not.toContain('codex-wrapper');
    expect(files).toContain('managed-settings.json');
  });
});
