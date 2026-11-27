import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startupCheckAnswer, startupConfigRefusal } from './session-terminal';
import { terminalHookRoutes, type TerminalGatewayHandlers } from './terminal-gateway';

/**
 * 감싸개의 exec 직전 검사(#1475)가 묻는 관문 경로 `/startup-check`. 판정은 터미널을 열기 전 검사와 같은 코드(`startupConfigRefusal`)다.
 * 임시 폴더만 쓰고 HOME도 임시 폴더로 바꾼다(사용자의 실제 전역 설정을 읽지 않는다).
 */
let root = '';
let work = '';
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'b-studio-startroute-')));
  work = path.join(root, 'work');
  await mkdir(path.join(work, 'sub'), { recursive: true });
  await mkdir(path.join(root, 'home'), { recursive: true });
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'home', '.config'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('관문 경로 /startup-check', () => {
  const routes = (handlers: Partial<TerminalGatewayHandlers>) => terminalHookRoutes(handlers as TerminalGatewayHandlers);
  it('열어도 되면 {ok:true}, 거절하면 {refusal}이다', async () => {
    expect(await routes({ startupCheck: async () => undefined })['/startup-check']!({ cli: 'gemini', cwd: '/x' })).toEqual({ ok: true });
    expect(await routes({ startupCheck: async () => '거절' })['/startup-check']!({})).toEqual({ refusal: '거절' });
  });
  it('핸들러가 없으면 거절이고, 던지면 던진다(훅 서버가 5xx로 답해 감싸개가 띄우지 않는다)', async () => {
    expect(await routes({})['/startup-check']!({})).toEqual({ refusal: expect.stringContaining('띄우지 않았습니다') });
    await expect(
      routes({
        startupCheck: async () => {
          throw new Error('x');
        },
      })['/startup-check']!({}),
    ).rejects.toThrow('x');
  });
});

describe('startupCheckAnswer', () => {
  it('작업 폴더 안(하위 폴더 포함)이고 문제가 없으면 undefined다', async () => {
    expect(await startupCheckAnswer(work, { cli: 'opencode', cwd: work })).toBeUndefined();
    expect(await startupCheckAnswer(work, { cli: 'gemini', cwd: path.join(work, 'sub') })).toBeUndefined();
  });

  it('모르는 CLI·상대 경로·없는 폴더·작업 폴더 밖(링크로 빠져나가는 것 포함)은 거절이다', async () => {
    expect(await startupCheckAnswer(work, { cli: 'claude', cwd: work })).toContain('모르는 CLI');
    expect(await startupCheckAnswer(work, { cli: 'gemini' })).toContain('작업 폴더를 알 수 없어');
    expect(await startupCheckAnswer(work, { cli: 'gemini', cwd: 'sub' })).toContain('작업 폴더를 알 수 없어');
    expect(await startupCheckAnswer(work, { cli: 'gemini', cwd: path.join(work, 'nope') })).toContain('검사하지 못해');
    expect(await startupCheckAnswer(work, { cli: 'gemini', cwd: root })).toContain('작업 폴더 밖');
    await symlink(path.join(root, 'home'), path.join(work, 'out'));
    expect(await startupCheckAnswer(work, { cli: 'opencode', cwd: path.join(work, 'out') })).toContain('작업 폴더 밖');
  });

  it('띄우기 전 검사와 같은 판정이다: 설정 JSON의 hooks·샌드박스, OpenCode의 위 폴더 설정 파일·플러그인 폴더, .env·bunfig를 모두 본다', async () => {
    const cases: Array<['opencode' | 'gemini', string, string, RegExp]> = [
      ['gemini', '.gemini/settings.json', JSON.stringify({ hooks: { BeforeTool: [{ x: 1 }] } }), /hooks/],
      ['gemini', '.gemini/settings.json', JSON.stringify({ tools: { sandbox: 'docker' } }), /샌드박스/],
      ['gemini', '.env', 'GEMINI_SANDBOX=docker\n', /GEMINI_SANDBOX/],
      ['opencode', 'opencode.json', JSON.stringify({ plugin: ['evil'] }), /플러그인|plugin/],
      ['opencode', '.opencode/plugins/evil.js', 'export default {}', /evil/],
      ['opencode', '.env.local', 'OPENCODE_PERMISSION={}\n', /OPENCODE_PERMISSION/],
      ['opencode', 'bunfig.toml', 'preload = ["x"]\n', /bunfig/],
    ];
    for (const [cli, file, content, pattern] of cases) {
      const target = path.join(work, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      // OpenCode의 설정 파일·플러그인 폴더는 위 폴더까지 보고(하위 폴더에서 띄운다), Gemini의 작업 폴더 설정과 Bun의 .env·bunfig는 띄우는 폴더만 본다
      const cwd = file === 'opencode.json' || file.startsWith('.opencode/') ? path.join(work, 'sub') : work;
      const viaRoute = await startupCheckAnswer(work, { cli, cwd });
      expect(viaRoute, `${cli} ${file}`).toMatch(pattern);
      expect(viaRoute).toBe(await startupConfigRefusal(cli, cwd));
      await rm(path.join(work, file.split('/')[0]!), { recursive: true, force: true });
    }
  });
});
