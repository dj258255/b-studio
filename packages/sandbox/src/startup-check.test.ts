import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiConfigRefusal } from './gemini-config';
import { GEMINI_SETTINGS_NAME } from './gemini-hook';
import { hostGeminiWrapper, hostOpenCodeWrapper } from './host-terminal';
import { openCodeConfigRefusal } from './opencode-config';
import { STARTUP_CHECK, STARTUP_CHECK_NAME } from './startup-check';

/**
 * 감싸개가 exec 직전에 돌리는 검사 스크립트(#1475)와 띄우기 전 검사(TS)가 같은 입력에 같은 답(거절 글까지)을 내는지, 그리고 진짜 `/bin/sh`로 돌린 감싸개가 거절·검사 실패에서 CLI를 띄우지 않는지 본다.
 * 진짜 opencode·gemini는 띄우지 않는다(CLI 자리에는 "RAN"을 찍는 가짜 스크립트). 임시 폴더만 쓴다.
 */
let root = '';
let work = '';
let gateway = '';
let home = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-startchk-'));
  work = path.join(root, 'work', 'project');
  gateway = path.join(root, 'gw');
  home = path.join(root, 'home');
  await mkdir(work, { recursive: true });
  await mkdir(path.join(gateway, 'bin'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(gateway, STARTUP_CHECK_NAME), STARTUP_CHECK);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (file: string, args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) =>
    execFile(file, args, { cwd: options.cwd, env: { PATH: process.env.PATH ?? '', ...options.env }, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );

/** 스크립트가 낸 거절 글(없으면 undefined). 종료 코드 2가 거절이다 */
async function scriptRefusal(cli: 'opencode' | 'gemini', cwd: string): Promise<string | undefined> {
  const result = await run(process.execPath, [path.join(gateway, STARTUP_CHECK_NAME), cli, cwd], { cwd });
  if (result.code === 0) return undefined;
  expect(result.code, result.stderr).toBe(2);
  return result.stderr.trim().replace(/^\[b-studio\] /u, '');
}
const tsOpencode = (cwd: string) => openCodeConfigRefusal({ cwd, home, managedDirs: [path.join(root, 'managed')] });
const tsGemini = (cwd: string) => geminiConfigRefusal({ cwd, systemSettingsDir: path.join(root, 'sys') });

/** [이름, 내용]. 같은 입력을 두 쪽에 넣는다 */
const FIXTURES: Array<[string, string, string]> = [
  ['평범한 .env', '.env', 'DATABASE_URL=postgres://x\nNODE_ENV=production\nPORT=3000\nGITHUB_TOKEN=x\n'],
  ['OPENCODE_ 열쇠', '.env', 'A=1\nOPENCODE_CONFIG_CONTENT={"plugin":["x"]}\n'],
  ['소문자 열쇠와 export', '.env.local', 'export opencode_permission: {}\n'],
  ['코드 적재', '.env.production', 'NODE_OPTIONS=--require /x.js\n'],
  ['캐리지 리턴만으로 나뉜 줄', '.env', 'A=1\rNODE_PATH=/x\r'],
  ['CRLF', '.env.test', 'A=1\r\nBASH_ENV=/x\r\n'],
  ['따옴표 안의 줄', '.env', 'A="x\nOPENCODE_PURE=1\n"\n'],
  ['GEMINI_ 모르는 열쇠', '.env', 'GEMINI_SANDBOX=docker\n'],
  ['GEMINI_ 안전한 열쇠', '.env', 'GEMINI_API_KEY=x\n'],
  ['bunfig', 'bunfig.toml', 'preload = ["./x.ts"]\n'],
  ['전각 이름', '．ｅｎｖ', 'OPENCODE_PERMISSION={}\n'],
  ['큰 파일', '.env', `A=${'x'.repeat(1024 * 1024 + 1)}\n`],
];

describe('검사 스크립트와 TS 판정이 같은 답을 낸다', () => {
  it.each(FIXTURES)('%s', async (_name, file, content) => {
    await writeFile(path.join(work, file), content);
    expect(await scriptRefusal('opencode', work)).toBe(await tsOpencode(work));
    expect(await scriptRefusal('gemini', work)).toBe(await tsGemini(work));
  });

  it('위 폴더의 .env: Gemini는 거절하고(위로 올라가며 본다) OpenCode는 작업 폴더만 본다. 두 쪽이 같다', async () => {
    await writeFile(path.join(root, 'work', '.env'), 'GEMINI_SANDBOX=1\nOPENCODE_PERMISSION={}\n');
    expect(await scriptRefusal('gemini', work)).toBe(await tsGemini(work));
    expect(await scriptRefusal('gemini', work)).toContain('GEMINI_SANDBOX');
    expect(await scriptRefusal('opencode', work)).toBe(await tsOpencode(work));
    expect(await scriptRefusal('opencode', work)).toBeUndefined();
  });

  it('모르는 CLI나 작업 폴더가 없으면 거절이다', async () => {
    const result = await run(process.execPath, [path.join(gateway, STARTUP_CHECK_NAME), 'claude', work], { cwd: work });
    expect(result.code).toBe(2);
    const none = await run(process.execPath, [path.join(gateway, STARTUP_CHECK_NAME), 'opencode'], { cwd: work });
    expect(none.code).toBe(2);
  });
});

/** 설정 자리·홈·셸·플러그인·통신 경로를 바꾸는 변수(커밋 보안 검토): 각각 거절이어야 한다 */
const NEW_RISKY = [
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'HOMEPATH',
  'SHELL', 'COMSPEC', 'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
  'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_EXEC_PATH', 'GIT_ASKPASS',
  'HTTP_PROXY', 'https_proxy', 'ALL_PROXY', 'NO_PROXY', 'no_proxy', 'NOPROXY',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SSL_KEYLOGFILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH',
  'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'GEM_HOME', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'npm_config_registry', 'NPM_CONFIG_PREFIX', 'YARN_RC_FILENAME', 'PNPM_HOME', 'DOTENV_KEY', 'ZDOTDIR', 'VIRTUAL_ENV', 'PATHEXT',
];

describe('설정 자리·코드 실행 경로를 바꾸는 변수는 .env에서 거절한다(OpenCode·Gemini 공통)', () => {
  it.each(NEW_RISKY)('%s', async (key) => {
    await writeFile(path.join(work, '.env'), `A=1\n${key}=x\n`);
    for (const message of [await tsOpencode(work), await tsGemini(work), await scriptRefusal('opencode', work), await scriptRefusal('gemini', work)]) {
      expect(message, key).toContain(key);
    }
  });

  it('평범한 이름은 계속 열린다(허용 목록으로 바꾸지 않았다)', async () => {
    await writeFile(path.join(work, '.env'), 'DATABASE_URL=x\nGITHUB_TOKEN=x\nHOMEPAGE=x\nSHELLCHECK=1\nPROXYLESS=1\nNODE_ENV=test\nSECRET_KEY=x\nAWS_REGION=x\nPORT=1\n');
    expect(await tsOpencode(work)).toBeUndefined();
    expect(await tsGemini(work)).toBeUndefined();
    expect(await scriptRefusal('opencode', work)).toBeUndefined();
    expect(await scriptRefusal('gemini', work)).toBeUndefined();
  });
});

describe('감싸개: exec 직전에 같은 검사를 돌린다(진짜 /bin/sh)', () => {
  const fake = () => path.join(root, 'fake-cli.sh');
  async function install(kind: 'opencode' | 'gemini', nodePath = process.execPath): Promise<string> {
    await writeFile(fake(), '#!/bin/sh\nprintf "RAN\\n"\n');
    await chmod(fake(), 0o755);
    const wrapper = path.join(gateway, 'bin', kind);
    if (kind === 'opencode') await writeFile(wrapper, hostOpenCodeWrapper(gateway, { cliPath: fake(), nodePath }));
    else {
      await writeFile(path.join(gateway, GEMINI_SETTINGS_NAME), '{}\n');
      await writeFile(wrapper, hostGeminiWrapper(gateway, { cliPath: fake(), nodePath }));
    }
    await chmod(wrapper, 0o755);
    return wrapper;
  }
  const env = () => ({ HOME: home });

  describe.each(['opencode', 'gemini'] as const)('%s', (kind) => {
    it('평범한 .env면 CLI를 띄운다', async () => {
      await writeFile(path.join(work, '.env'), 'DATABASE_URL=x\n');
      const result = await run(await install(kind), [], { cwd: work, env: env() });
      expect(result.stdout).toContain('RAN');
      expect(result.code).toBe(0);
    });

    it('.env가 설정·권한·코드 적재 변수를 정하면 띄우지 않고 이유를 찍는다(셸이 쓴 파일도 다시 볼 때 막힌다)', async () => {
      const wrapper = await install(kind);
      for (const line of [kind === 'opencode' ? 'OPENCODE_CONFIG_CONTENT={"plugin":["x"]}' : 'GEMINI_SANDBOX=docker', 'NODE_OPTIONS=--require /x.js', 'HOME=/evil']) {
        await writeFile(path.join(work, '.env'), `${line}\n`);
        const result = await run(wrapper, [], { cwd: work, env: env() });
        expect(result.stdout, line).not.toContain('RAN');
        expect(result.code, line).toBe(1);
        expect(result.stderr, line).toContain('.env');
      }
    });

    it('검사 스크립트가 없거나 죽거나 node가 없으면 띄우지 않는다(fail-closed)', async () => {
      const wrapper = await install(kind);
      await rm(path.join(gateway, STARTUP_CHECK_NAME));
      const missing = await run(wrapper, [], { cwd: work, env: env() });
      expect(missing.stdout).not.toContain('RAN');
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('띄우지 않았습니다');
      await writeFile(path.join(gateway, STARTUP_CHECK_NAME), 'process.exit(1);\n');
      const crashed = await run(wrapper, [], { cwd: work, env: env() });
      expect(crashed.stdout).not.toContain('RAN');
      expect(crashed.code).toBe(1);
      await writeFile(path.join(gateway, STARTUP_CHECK_NAME), STARTUP_CHECK);
      const noNode = await run(await install(kind, '/nonexistent/node'), [], { cwd: work, env: env() });
      expect(noNode.stdout).not.toContain('RAN');
      expect(noNode.code).toBe(1);
    });

    it('검사는 빈 환경에서 돈다: 사용자 셸의 NODE_OPTIONS 코드는 검사 스크립트 안에서 돌지 않는다', async () => {
      const marker = path.join(root, 'evil-ran');
      const evil = path.join(root, 'evil.cjs');
      await writeFile(evil, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
      const result = await run(await install(kind), [], { cwd: work, env: { ...env(), NODE_OPTIONS: `--require ${evil}` } });
      // 감싸개가 아니라 가짜 CLI를 직접 부르는 것이 아니므로 검사 단계의 node에는 NODE_OPTIONS가 없다(가짜 CLI는 셸 스크립트라 node를 쓰지 않는다)
      expect(result.stdout).toContain('RAN');
      await expect(import('node:fs/promises').then((fs) => fs.readFile(marker, 'utf8'))).rejects.toThrow();
    });
  });
});
