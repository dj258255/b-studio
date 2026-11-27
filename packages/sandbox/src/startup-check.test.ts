import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
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
 * 감싸개가 exec 직전에 돌리는 검사 스크립트(#1475)는 판정 코드가 없고 관문의 `/startup-check`에 묻는다. 여기서는 스튜디오 대신 임시 루프백 서버(임의 포트)가
 * 같은 TS 판정(`openCodeConfigRefusal`·`geminiConfigRefusal`)으로 답한다(스튜디오 쪽 연결은 `apps/studio/lib/server/terminal-gateway-startup-check.test.ts`).
 * 진짜 `/bin/sh`로 감싸개를 돌려, 거절·검사 실패에서 CLI를 띄우지 않는지 본다. 진짜 opencode·gemini는 띄우지 않는다(CLI 자리에는 "RAN"을 찍는 가짜 스크립트). 임시 폴더만 쓴다.
 */
let root = '';
let work = '';
let gateway = '';
let home = '';
let server: Server | undefined;
let behavior: 'judge' | 'error' | 'garbage' | 'extra' = 'judge';
const asked: Array<{ cli: string; cwd: string; authorization: string | undefined }> = [];

const tsOpencode = (cwd: string) => openCodeConfigRefusal({ cwd, home, managedDirs: [path.join(root, 'managed')] });
const tsGemini = (cwd: string) => geminiConfigRefusal({ cwd, systemSettingsDir: path.join(root, 'sys') });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-startchk-'));
  work = path.join(root, 'work', 'project');
  gateway = path.join(root, 'gw');
  home = path.join(root, 'home');
  behavior = 'judge';
  asked.length = 0;
  await mkdir(work, { recursive: true });
  await mkdir(path.join(gateway, 'bin'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(gateway, STARTUP_CHECK_NAME), STARTUP_CHECK);
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { cli: 'opencode' | 'gemini'; cwd: string };
      asked.push({ cli: input.cli, cwd: input.cwd, authorization: request.headers.authorization });
      if (request.url !== '/startup-check') return void response.writeHead(404).end();
      if (behavior === 'error') return void response.writeHead(500).end('{}');
      if (behavior === 'garbage') return void response.writeHead(200).end('not json');
      if (behavior === 'extra') return void response.writeHead(200).end(JSON.stringify({ ok: true, more: 1 }));
      const refusal = input.cli === 'gemini' ? await tsGemini(input.cwd) : await tsOpencode(input.cwd);
      response.writeHead(200).end(JSON.stringify(refusal ? { refusal } : { ok: true }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  await writeAddress(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  await rm(root, { recursive: true, force: true });
});
const writeAddress = (url: string) => writeFile(path.join(gateway, 'b-studio-gateway.json'), JSON.stringify({ url, token: 'tok' }));

const run = (file: string, args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) =>
    execFile(file, args, { cwd: options.cwd, env: { PATH: process.env.PATH ?? '', ...options.env }, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );
const script = (cli: string, cwd: string) => run(process.execPath, [path.join(gateway, STARTUP_CHECK_NAME), cli, cwd], { cwd });

describe('검사 스크립트: 판정은 관문이 하고, 답이 없거나 낯설면 띄우지 않는다', () => {
  it('열어도 되면 0, 관문의 거절이면 2와 그 글, 관문이 받은 것은 CLI와 작업 폴더와 토큰이다', async () => {
    expect((await script('opencode', work)).code).toBe(0);
    expect(asked[0]).toEqual({ cli: 'opencode', cwd: work, authorization: 'Bearer tok' });
    await writeFile(path.join(work, '.env'), 'OPENCODE_PERMISSION={}\n');
    const refused = await script('opencode', work);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(`${path.join(work, '.env')}이(가) OPENCODE_PERMISSION`);
  });

  it('관문의 오류·이상한 답·여분의 열쇠가 든 답·닿지 못함·주소 파일 없음·루프백이 아닌 주소는 모두 3이다(통과가 아니다)', async () => {
    for (const mode of ['error', 'garbage', 'extra'] as const) {
      behavior = mode;
      expect((await script('gemini', work)).code, mode).toBe(3);
    }
    behavior = 'judge';
    await writeAddress('http://127.0.0.1:1');
    expect((await script('gemini', work)).code, '닿지 못함').toBe(3);
    await writeAddress('http://example.com:80');
    expect((await script('gemini', work)).code, '다른 주소').toBe(3);
    await rm(path.join(gateway, 'b-studio-gateway.json'));
    expect((await script('gemini', work)).code, '주소 파일 없음').toBe(3);
    expect((await script('', '')).code).toBe(3);
  });
});

/** 스크립트를 거쳐 받은 거절 글(없으면 undefined) */
async function refusalVia(cli: 'opencode' | 'gemini'): Promise<string | undefined> {
  const result = await script(cli, work);
  if (result.code === 0) return undefined;
  expect(result.code, result.stderr).toBe(2);
  return result.stderr.trim().replace(/^\[b-studio\] /u, '');
}

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
    for (const message of [await tsOpencode(work), await tsGemini(work), await refusalVia('opencode'), await refusalVia('gemini')]) {
      expect(message, key).toContain(key);
    }
  });

  it('평범한 이름은 계속 열린다(허용 목록으로 바꾸지 않았다)', async () => {
    await writeFile(path.join(work, '.env'), 'DATABASE_URL=x\nGITHUB_TOKEN=x\nHOMEPAGE=x\nSHELLCHECK=1\nPROXYLESS=1\nNODE_ENV=test\nSECRET_KEY=x\nAWS_REGION=x\nPORT=1\n');
    expect(await tsOpencode(work)).toBeUndefined();
    expect(await tsGemini(work)).toBeUndefined();
    expect(await refusalVia('opencode')).toBeUndefined();
    expect(await refusalVia('gemini')).toBeUndefined();
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


    it('설정 JSON·플러그인 설정도 같은 판정으로 막는다(.env만이 아니다): 셸로 쓴 hooks·plugin을 다시 띄울 때 잡는다', async () => {
      const wrapper = await install(kind);
      if (kind === 'gemini') {
        await mkdir(path.join(work, '.gemini'), { recursive: true });
        await writeFile(path.join(work, '.gemini', 'settings.json'), JSON.stringify({ hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
      } else {
        await writeFile(path.join(root, 'work', 'opencode.json'), JSON.stringify({ plugin: ['evil'] }));
      }
      const result = await run(wrapper, [], { cwd: work, env: env() });
      expect(result.stdout).not.toContain('RAN');
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(kind === 'gemini' ? /hooks/ : /플러그인|plugin/);
    });

    it('관문이 오류로 답하면 띄우지 않는다', async () => {
      const wrapper = await install(kind);
      behavior = 'error';
      const result = await run(wrapper, [], { cwd: work, env: env() });
      expect(result.stdout).not.toContain('RAN');
      expect(result.code).toBe(1);
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
