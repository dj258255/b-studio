import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBwrapArgs, buildSeatbeltProfile, planSandbox, sbplString, type BashSandboxOptions } from './bash-sandbox';
import { createTools } from './tools';

const mac = process.platform === 'darwin';
const macOnly = mac ? describe : describe.skip;
// 쓰기를 가두는 도구가 실제로 동작하는 환경(macOS sandbox-exec, 쓸 수 있는 Linux bwrap)에서만 도는 시험
const sandboxed = planSandbox('true', tmpdir()).kind === 'wrapped';
const sandboxedOnly = sandboxed ? describe : describe.skip;
const DENIED = /Operation not permitted|Read-only file system|Permission denied/;

let base: string;
let work: string;
let tmp: string;
let outside: string;
let gateway: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bash-sbx-'));
  work = path.join(base, 'work');
  tmp = path.join(base, 'tmp');
  outside = path.join(base, 'outside');
  gateway = path.join(tmp, 'gw');
  for (const dir of [work, tmp, outside, gateway]) await mkdir(dir);
  await writeFile(path.join(gateway, 'b-studio-hook.mjs'), 'ORIGINAL\n');
  await writeFile(path.join(outside, 'secret.txt'), 'secret\n');
});
afterEach(() => rm(base, { recursive: true, force: true }));

/** 임시 폴더를 base/tmp로 좁혀(형제 폴더 outside가 허용 범위 밖이 되게) 명령을 돌린다 */
const sandbox = (extra: BashSandboxOptions = {}): BashSandboxOptions => ({ tmpDirs: [tmp], denyWrite: [gateway], ...extra });
const bash = (command: string, extra: BashSandboxOptions = {}) => createTools(work, { killGraceMs: 200, sandbox: sandbox(extra) }).execute('Bash', { command });

sandboxedOnly('Bash 쓰기 샌드박스(macOS sandbox-exec, Linux bwrap)', () => {
  it('작업 폴더 안에는 쓰고, 읽기는 밖도 된다', async () => {
    const result = await bash(`echo hi > inside.txt && mkdir -p a/b && echo x > a/b/c.txt && cat ${outside}/secret.txt`);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('secret');
    expect(await readFile(path.join(work, 'a/b/c.txt'), 'utf8')).toBe('x\n');
  });

  it('작업 폴더 밖의 형제 폴더에는 쓰지 못한다', async () => {
    const result = await bash(`echo no > ${outside}/new.txt`);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(DENIED);
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
    // 기존 파일을 덮어쓰거나 지우지도 못한다
    expect((await bash(`echo no > ${outside}/secret.txt`)).isError).toBe(true);
    expect((await bash(`rm ${outside}/secret.txt`)).isError).toBe(true);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n');
  });

  it('임시 폴더가 허용 범위 안에 있어도 관문 폴더는 쓰지 못한다(허용 뒤의 거부가 이긴다)', async () => {
    expect((await bash('echo ok > tmp-ok.txt && cp tmp-ok.txt ' + tmp + '/free.txt')).isError).toBe(false);
    const result = await bash(`echo EVIL > ${gateway}/b-studio-hook.mjs`);
    expect(result.isError).toBe(true);
    expect(await readFile(path.join(gateway, 'b-studio-hook.mjs'), 'utf8')).toBe('ORIGINAL\n');
    // 새 파일·지우기·이름 바꾸기·링크로 덮기도 막힌다
    for (const command of [`echo x > ${gateway}/new.txt`, `rm ${gateway}/b-studio-hook.mjs`, `mv ${gateway}/b-studio-hook.mjs ${tmp}/moved.mjs`, `ln -sf /bin/sh ${gateway}/b-studio-hook.mjs`, `chmod 777 ${gateway}`]) {
      expect((await bash(command)).isError, command).toBe(true);
    }
    expect(await readFile(path.join(gateway, 'b-studio-hook.mjs'), 'utf8')).toBe('ORIGINAL\n');
    expect(existsSync(path.join(tmp, 'moved.mjs'))).toBe(false);
  });

  it('이름 꼴이 관문 폴더인 임시 폴더 안의 폴더(다른 세션의 관문)도 쓰지 못한다', async () => {
    const other = path.join(tmp, 'b-studio-gateway-abc123');
    await mkdir(other);
    await writeFile(path.join(other, 'b-studio-hook.mjs'), 'OTHER\n');
    const result = await bash(`echo EVIL > ${other}/b-studio-hook.mjs`);
    expect(result.isError).toBe(true);
    expect(await readFile(path.join(other, 'b-studio-hook.mjs'), 'utf8')).toBe('OTHER\n');
  });

  it('작업 폴더 안의 링크가 밖을 가리켜도 그 너머에는 쓰지 못한다', async () => {
    await symlink(outside, path.join(work, 'link-dir'));
    await symlink(path.join(outside, 'secret.txt'), path.join(work, 'link-file'));
    expect((await bash('echo no > link-dir/new.txt')).isError).toBe(true);
    expect((await bash('echo no > link-file')).isError).toBe(true);
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n');
  });

  it('`..`로 작업 폴더를 벗어나도 쓰지 못한다', async () => {
    expect((await bash('echo no > ../outside/dotdot.txt')).isError).toBe(true);
    expect((await bash(`echo no > ${work}/../outside/dotdot2.txt`)).isError).toBe(true);
    expect((await bash('mkdir -p sub && cd sub && echo no > ../../outside/dotdot3.txt')).isError).toBe(true);
    expect(existsSync(path.join(outside, 'dotdot.txt'))).toBe(false);
  });

  it('대소문자를 바꾼 경로로도 밖에 쓰지 못한다(대소문자를 구분하지 않는 볼륨에서도 같은 폴더로 읽힌다)', async () => {
    const swapped = outside.replace(/outside$/, 'OUTSIDE');
    const result = await bash(`echo no > ${swapped}/case.txt`);
    expect(result.isError).toBe(true);
    expect(existsSync(path.join(outside, 'case.txt'))).toBe(false);
    // 관문 폴더의 대소문자 변형도 같다
    const gw = gateway.replace(/gw$/, 'GW');
    expect((await bash(`echo EVIL > ${gw}/b-studio-hook.mjs`)).isError).toBe(true);
    expect(await readFile(path.join(gateway, 'b-studio-hook.mjs'), 'utf8')).toBe('ORIGINAL\n');
  });

  it('작업 폴더를 /var 같은 링크 경로로 받아도(실제 경로는 /private/var) 안에는 쓴다', async () => {
    const real = await realpath(work);
    const given = real.replace(/^\/private/, '');
    if (given === real) return;
    const result = await createTools(given, { sandbox: sandbox() }).execute('Bash', { command: 'echo hi > viaLink.txt' });
    expect(result.isError, result.text).toBe(false);
    expect(existsSync(path.join(work, 'viaLink.txt'))).toBe(true);
  });

  it('임시 폴더와 /dev/null·표준 오류 장치에는 쓸 수 있다', async () => {
    const result = await bash(`echo a > ${tmp}/t.txt && echo b > /dev/null && echo c > /dev/stderr && mktemp -d ${tmp}/x.XXXX >/dev/null`);
    expect(result.isError, result.text).toBe(false);
    expect(await readFile(path.join(tmp, 't.txt'), 'utf8')).toBe('a\n');
  });

  it('작업 폴더의 .git 안은 쓰지 못한다(서버의 git이 그 설정·훅을 서버 권한으로 실행한다). 읽기와 밖의 .git은 된다', async () => {
    execFileSync('git', ['init', '-q'], { cwd: work });
    const hooks = await bash(`printf '#!/bin/sh\\ntouch pwned\\n' > .git/hooks/pre-commit`);
    expect(hooks.isError).toBe(true);
    expect((await bash('git config core.fsmonitor "touch pwned"')).isError).toBe(true);
    expect((await bash('git add -A && git commit -qm x --allow-empty')).isError).toBe(true);
    expect(existsSync(path.join(work, '.git/hooks/pre-commit'))).toBe(false);
    // 대소문자를 바꾼 이름(.GIT)도 같은 폴더다
    expect((await bash('echo x > .GIT/config')).isError).toBe(true);
    // 읽기 명령은 된다(status는 인덱스를 새로 쓰지 못해도 동작한다)
    expect((await bash('git status --short && git log --oneline -1 2>/dev/null; git rev-parse --git-dir')).text).toContain('.git');
    // 하위 폴더의 새 저장소(npm create 등)는 쓸 수 있다
    expect((await bash('mkdir sub && git init -q sub && echo y > sub/.git/x')).isError).toBe(false);
  });

  it('기본 설정에서는 사용자 임시 폴더($TMPDIR)와 /tmp에 쓸 수 있고, 형제 폴더인 홈 직하에는 쓰지 못한다', async () => {
    const tools = createTools(work, { sandbox: { denyWrite: [gateway] } });
    const dir = await mkdtemp(path.join(tmpdir(), 'bash-sbx-default-'));
    const legacy = path.join('/tmp', `bash-sbx-legacy-${process.pid}`);
    try {
      const ok = await tools.execute('Bash', { command: `echo a > ${dir}/a.txt && echo b > ${legacy} && echo c > $TMPDIR/bash-sbx-c-${process.pid}` });
      expect(ok.isError, ok.text).toBe(false);
      const blocked = await tools.execute('Bash', { command: `echo a > ${homedir()}/.b-studio-sbx-probe-${process.pid}` });
      expect(blocked.isError).toBe(true);
      expect(existsSync(path.join(homedir(), `.b-studio-sbx-probe-${process.pid}`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(legacy, { force: true });
      await rm(path.join(tmpdir(), `bash-sbx-c-${process.pid}`), { force: true });
    }
  });


  it('샌드박스 밖에 일을 시키는 길(open, osascript, launchctl)은 실패하고 밖에 파일이 생기지 않는다', async () => {
    const probe = path.join(outside, 'ipc');
    await mkdir(probe);
    await writeFile(path.join(work, 'x.command'), `#!/bin/sh\ntouch ${probe}/open\n`, { mode: 0o755 });
    const label = `b-studio-sbx-test-${process.pid}`;
    try {
      const cases = [
        `open -a Terminal ${work}/x.command`,
        `osascript -e 'do shell script "touch ${probe}/osa"'`,
        `launchctl submit -l ${label} -- /usr/bin/touch ${probe}/lc`,
        `echo 'touch ${probe}/at' | at now`,
        // 도구를 복사해 와도(경로 거부를 비켜 가도) IPC 자체가 막힌다
        `cp /usr/bin/osascript ./osa-copy && ./osa-copy -e 'do shell script "touch ${probe}/osa2"'`,
        `cp /usr/bin/open ./open-copy && ./open-copy -a Terminal ${work}/x.command`,
      ];
      for (const command of cases) {
        const result = await bash(command);
        expect(result.isError, command + '\n' + result.text).toBe(true);
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(await readdir(probe)).toEqual([]);
    } finally {
      try {
        execFileSync('launchctl', ['remove', label], { stdio: 'ignore' });
      } catch {
        // 만들어지지 않았다
      }
    }
  }, 30_000);

  it('쓸 수 있는 구역 안의 작업 폴더·관문 폴더의 위쪽 폴더는 옮기거나 지우지 못한다(옮긴 자리에 새 .git을 만들어 거부를 비켜 가는 길)', async () => {
    const nested = path.join(tmp, 'a', 'work');
    const nestedGateway = path.join(tmp, 'sub', 'gw');
    await mkdir(nested, { recursive: true });
    await mkdir(nestedGateway, { recursive: true });
    await mkdir(path.join(nested, '.git'));
    await writeFile(path.join(nestedGateway, 'b-studio-hook.mjs'), 'ORIGINAL\n');
    const run = (command: string, cwd = nested) => createTools(cwd, { killGraceMs: 200, sandbox: { tmpDirs: [tmp], denyWrite: [nestedGateway] } }).execute('Bash', { command });
    // 작업 폴더 안 쓰기는 그대로 된다
    expect((await run('mkdir -p src && echo ok > src/a.txt')).isError).toBe(false);
    for (const command of [`mv ${nested} ${nested}.old`, `mv ${path.dirname(nested)} ${path.dirname(nested)}.old`, `rm -rf ${nested}`, `rmdir ${path.dirname(nested)}`]) {
      const result = await run(command);
      expect(result.isError, command).toBe(true);
    }
    for (const command of [`mv ${nestedGateway} ${nestedGateway}.old`, `mv ${path.dirname(nestedGateway)} ${path.dirname(nestedGateway)}.old`, `rm -rf ${path.dirname(nestedGateway)}`]) {
      expect((await run(command)).isError, command).toBe(true);
    }
    expect(existsSync(path.join(nested, '.git'))).toBe(true);
    expect(await readFile(path.join(nestedGateway, 'b-studio-hook.mjs'), 'utf8')).toBe('ORIGINAL\n');
    expect(existsSync(`${nested}.old`)).toBe(false);
    expect(existsSync(`${path.dirname(nestedGateway)}.old`)).toBe(false);
  });

  it('쓰기를 막아도 프로세스 그룹 kill·시간 초과는 그대로다', async () => {
    const result = await createTools(work, { killGraceMs: 200, sandbox: sandbox() }).execute('Bash', { command: '(sleep 300 & echo $! > gc.pid; wait) & echo $! > c.pid; wait', timeout: 400 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('시간 초과');
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(Number((await readFile(path.join(work, 'gc.pid'), 'utf8')).trim()))).toBe(false);
  });

  it('프로필로 적을 수 없는 경로(개행·NUL 등)는 감싸지 못하므로 실행하지 않는다', async () => {
    const weird = path.join(base, 'we\nird');
    await mkdir(weird);
    const result = await createTools(weird, { sandbox: sandbox() }).execute('Bash', { command: 'echo ran > ran.txt' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('실행하지 않았습니다');
    expect(existsSync(path.join(weird, 'ran.txt'))).toBe(false);
  });

  it('따옴표·역슬래시·공백·괄호·한글이 든 경로도 프로필 글에서 안전하게 쓴다', async () => {
    const odd = path.join(base, 'a "q" \\b (c) 한글');
    await mkdir(odd);
    const result = await createTools(odd, { sandbox: sandbox() }).execute('Bash', { command: 'echo ok > f.txt' });
    expect(result.isError, result.text).toBe(false);
    expect(await readFile(path.join(odd, 'f.txt'), 'utf8')).toBe('ok\n');
    expect((await createTools(odd, { sandbox: sandbox() }).execute('Bash', { command: `echo no > ${outside}/q.txt` })).isError).toBe(true);
  });

  it('작업 폴더가 루트나 홈 폴더(또는 그 위)이면 가둘 수 없으므로 실행하지 않는다', async () => {
    for (const dir of ['/', homedir(), path.dirname(homedir())]) {
      const result = await createTools(dir, { sandbox: sandbox() }).execute('Bash', { command: 'echo ran > /dev/null' });
      expect(result.isError, dir).toBe(true);
      expect(result.text, dir).toContain('실행하지 않았습니다');
    }
  });

  it('홈의 허용 목록 밖(.ssh·.cargo/bin·.gradle/init.d)과 홈 직하에는 쓰지 못하고, npm 캐시 폴더는 허용 목록에 있다', () => {
    const profile = buildSeatbeltProfile(work, sandbox());
    for (const forbidden of ['.ssh', '.cargo/bin', '.gradle/init.d', '.zshrc', '.cache/b-studio']) expect(profile).not.toContain(path.join(homedir(), forbidden));
    expect(profile).toContain(`(subpath ${sbplString(path.join(homedir(), '.npm'))})`);
  });
});

describe('프로필·인자 만들기(어느 플랫폼에서나)', () => {
  it('SBPL 문자열은 따옴표와 역슬래시를 이스케이프한다', () => {
    expect(sbplString('/a "b" \\c')).toBe('"/a \\"b\\" \\\\c"');
  });

  it('허용 줄 뒤에 거부 줄이 온다(마지막으로 맞은 규칙이 이긴다)', () => {
    const profile = buildSeatbeltProfile(work, sandbox({ platform: 'darwin' }));
    const lines = profile.split('\n');
    const allow = lines.findIndex((line) => line.startsWith('(allow file-write* (subpath'));
    const deny = lines.findIndex((line) => line.startsWith('(deny file-write* (subpath') && line.includes(gateway));
    expect(allow).toBeGreaterThan(0);
    expect(deny).toBeGreaterThan(allow);
    expect(profile).toContain(`${path.join(work, '.git')}`);
  });

  it('Linux 인자는 읽기 전용 루트 위에 쓸 곳만 연결하고 관문·.git은 마지막에 읽기 전용으로 덮는다', async () => {
    await mkdir(path.join(work, '.git'));
    const args = buildBwrapArgs(work, sandbox());
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    const realWork = await realpath(work);
    const realGateway = await realpath(gateway);
    const bindWork = args.findIndex((arg, i) => arg === '--bind' && args[i + 1] === realWork && args[i + 2] === realWork);
    expect(bindWork).toBeGreaterThan(0);
    const roGateway = args.findIndex((arg, i) => arg === '--ro-bind' && args[i + 1] === realGateway);
    expect(roGateway).toBeGreaterThan(bindWork);
    expect(args).toContain(path.join(realWork, '.git'));
  });


  it('Linux: 아직 없는 거부 경로(.git·관문 폴더)는 읽기 전용 tmpfs로 막아 새로 만들지 못하게 하고, 위쪽 폴더도 없으면 실행하지 않는다', async () => {
    const realWork = await realpath(work);
    const realTmp = await realpath(tmp);
    // work/.git은 없고, 관문 폴더는 쓸 수 있는 임시 폴더 안에 아직 없다
    const missingGateway = path.join(tmp, 'b-studio-gateway-later');
    const args = buildBwrapArgs(work, { tmpDirs: [tmp], denyWrite: [missingGateway] });
    const at = (flag: string, dir: string) => args.findIndex((arg, i) => arg === flag && args[i + 1] === dir);
    expect(at('--tmpfs', path.join(realWork, '.git'))).toBeGreaterThan(0);
    expect(args[at('--tmpfs', path.join(realWork, '.git')) + 2]).toBe('--remount-ro');
    expect(at('--tmpfs', path.join(realTmp, 'b-studio-gateway-later'))).toBeGreaterThan(0);
    expect(at('--ro-bind', path.join(realWork, '.git'))).toBe(-1);
    // 위쪽 폴더도 없는 거부 경로: 막을 수 없다
    expect(() => buildBwrapArgs(work, { tmpDirs: [tmp], denyWrite: [path.join(tmp, 'none', 'gw')] })).toThrow(/막을 수 없습니다/);
    // 쓸 수 있는 구역 밖의 없는 경로는 쓰기 자체가 막혀 있어 따로 덮지 않는다
    const outsideArgs = buildBwrapArgs(work, { tmpDirs: [tmp], denyWrite: [path.join(outside, 'none', 'gw')] });
    expect(outsideArgs.includes(path.join(outside, 'none', 'gw'))).toBe(false);
    // 있는 거부 경로는 읽기 전용으로 덮는다
    await mkdir(path.join(work, '.git'));
    expect(at('--ro-bind', path.join(realWork, '.git'))).toBe(-1);
    const withGit = buildBwrapArgs(work, { tmpDirs: [tmp], denyWrite: [gateway] });
    expect(withGit.findIndex((arg, i) => arg === '--ro-bind' && withGit[i + 1] === path.join(realWork, '.git'))).toBeGreaterThan(0);
  });

  it('Linux: 쓸 수 있는 구역 안에서 거부 경로의 위쪽 폴더도 마운트 지점으로 만들어(이름을 바꿀 수 없게) 얕은 것부터 연결한다', async () => {
    const nested = path.join(tmp, 'a', 'work');
    await mkdir(nested, { recursive: true });
    const nestedGateway = path.join(tmp, 'sub', 'gw');
    await mkdir(nestedGateway, { recursive: true });
    const args = buildBwrapArgs(nested, { tmpDirs: [tmp], denyWrite: [nestedGateway] });
    const binds = args.flatMap((arg, i) => (arg === '--bind' ? [args[i + 1]!] : []));
    const realTmp = await realpath(tmp);
    for (const dir of [path.join(realTmp, 'a'), path.join(realTmp, 'a', 'work'), path.join(realTmp, 'sub')]) expect(binds, dir).toContain(dir);
    expect(binds.indexOf(realTmp)).toBeLessThan(binds.indexOf(path.join(realTmp, 'a')));
    expect(binds.indexOf(path.join(realTmp, 'a'))).toBeLessThan(binds.indexOf(path.join(realTmp, 'a', 'work')));
  });

  it('Linux에서 bwrap이 없으면(또는 못 쓰면) 감싸지 않고 알림을 낸다. macOS에서 못 감싸면 실행을 거절한다', () => {
    if (process.platform === 'linux') {
      const plan = planSandbox('true', work, sandbox());
      expect(['wrapped', 'unsandboxed']).toContain(plan.kind);
    }
    const unsupported = planSandbox('true', work, sandbox({ platform: 'freebsd' }));
    expect(unsupported.kind).toBe('unsandboxed');
    const refused = planSandbox('true', '/', sandbox({ platform: 'linux' }));
    expect(['refused', 'unsandboxed']).toContain(refused.kind);
  });
});
