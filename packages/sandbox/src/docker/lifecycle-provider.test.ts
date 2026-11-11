import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDGE_SERVICE } from '../edge-config';
import { SandboxError } from '../errors';
import { LocalDockerProvider } from './compose-provider';

/**
 * 끝맺음·`exec`·사내 API·만들기 실패 정리를 `LocalDockerProvider`를 통해 부른다(ADR-195 4f A4c-3c). 가짜 docker는 셸 스크립트이고 진짜 docker는 쓰지 않는다.
 * 옮기지 않은 `exec`·`execToFile`·`execFromFile`·`egressDenials`의 docker 인자와 시크릿 가림도 여기서 고정한다(C1에서 Rust로 옮길 때 같은 시험이 기준이다).
 */

const dirs: string[] = [];
const locked: string[] = [];
let savedTmpdir: string | undefined;

beforeEach(() => {
  savedTmpdir = process.env.TMPDIR;
});

afterEach(async () => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  await Promise.all(locked.splice(0).map((dir) => chmod(dir, 0o700).catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const project = {
  spec: { name: 'shop' },
  root: '/tmp/shop',
  composePath: '/tmp/shop/compose.yaml',
  managed: [['api', { port: 8080 }]],
  composeServices: ['api'],
  sharedVolumes: [],
  external: [['billing', { baseUrl: 'http://billing.internal', policy: {} }]],
  publicUrlRefs: [],
} as unknown as LoadedProject;

interface Fake {
  bin: string;
  dir: string;
  /** 인자 하나가 \037, 호출 하나가 \036으로 끝나는 기록을 호출 목록으로 */
  calls: () => Promise<string[][]>;
}

/** compose의 `config`는 늘 `{"services":{}}`로 답하고, 나머지는 `answers`의 명령 키(`exec`·`logs`·`down`·`imagels`·`imagerm`·`info`)로 답한다 */
async function fakeDocker(answers: Record<string, { out?: string; err?: string; code?: number }> = {}, { configFails = false } = {}): Promise<Fake> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lifecycle-provider-'));
  dirs.push(dir);
  const bin = path.join(dir, 'docker');
  const answer = (key: string) => {
    const item = answers[key];
    if (!item) return 'exit 0';
    return `printf '%s' '${(item.out ?? '').replace(/'/g, "'\\''")}'; printf '%s' '${(item.err ?? '').replace(/'/g, "'\\''")}' >&2; exit ${item.code ?? 0}`;
  };
  await writeFile(
    bin,
    `#!/bin/sh
US=$(printf '\\037'); RS=$(printf '\\036')
line=""; for a in "$@"; do line="$line$a$US"; done
printf '%s%s' "$line" "$RS" >> "${dir}/calls.log"
case "$1" in
  info) ${answer('info')} ;;
  image) if [ "$2" = rm ]; then ${answer('imagerm')}; else ${answer('imagels')}; fi ;;
esac
for a in "$@"; do
  case "$a" in
    config) ${configFails ? "echo 'compose config boom' >&2; exit 1" : `echo '{"services":{}}'; exit 0`} ;;
    exec) cat > "${dir}/stdin.txt"; ${answer('exec')} ;;
    logs) ${answer('logs')} ;;
    down) ${answer('down')} ;;
  esac
done
exit 0
`,
  );
  await chmod(bin, 0o755);
  return {
    bin,
    dir,
    calls: async () => {
      const text = await readFile(path.join(dir, 'calls.log'), 'utf8').catch(() => '');
      return text.split('\x1e').filter(Boolean).map((call) => call.split('\x1f').filter((_, index, all) => index < all.length - 1 || all[index] !== ''));
    },
  };
}

const SECRET = 'sk-live-abcdef123456';
const compose = (id: string, override: string, ...rest: string[]) => ['compose', '--project-name', id, '--project-directory', '/tmp/shop', '--file', '/tmp/shop/compose.yaml', '--file', override, ...rest];

async function overrideOf(fake: Fake): Promise<string> {
  // 마스크를 계산하는 `compose config`는 override 없이 돈다. override를 가리키는 호출(`--file`이 둘)에서 읽는다
  const call = (await fake.calls()).find((args) => args[0] === 'compose' && args.filter((arg) => arg === '--file').length === 2)!;
  return call[call.lastIndexOf('--file') + 1]!;
}

describe('exec (옮기지 않은 호출의 인자와 가림을 고정한다)', () => {
  it('compose exec -T로 서비스 안에서 돌리고 stdout·stderr의 시크릿을 가린다(raw는 가리지 않는다)', async () => {
    const fake = await fakeDocker({ exec: { out: `out ${SECRET}`, err: `err ${SECRET}`, code: 3 } });
    const sandbox = await new LocalDockerProvider({ dockerBin: fake.bin }).create(project, { secrets: { KEY: SECRET } });
    const result = await sandbox.exec('api', ['echo', 'a b']);
    expect(result).toEqual({ exitCode: 3, stdout: 'out [KEY 가림]', stderr: 'err [KEY 가림]' });
    expect(await sandbox.exec('api', ['echo'], { raw: true })).toMatchObject({ stdout: `out ${SECRET}` });
    const exec = (await fake.calls()).filter((args) => args.includes('exec'));
    expect(exec[0]).toEqual(compose(sandbox.id, await overrideOf(fake), 'exec', '-T', 'api', 'echo', 'a b'));
    expect(await readFile(path.join(fake.dir, 'stdin.txt'), 'utf8')).toBe('');
    // 표준 입력
    await sandbox.exec('api', ['cat'], { input: 'hello' });
    expect(await readFile(path.join(fake.dir, 'stdin.txt'), 'utf8')).toBe('hello');
  });

  it('execToFile은 stdout을 파일로, execFromFile은 파일을 stdin으로 보낸다', async () => {
    const fake = await fakeDocker({ exec: { out: 'payload', err: `warn ${SECRET}` } });
    const sandbox = await new LocalDockerProvider({ dockerBin: fake.bin }).create(project, { secrets: { KEY: SECRET } });
    const out = path.join(fake.dir, 'out.bin');
    const result = await sandbox.execToFile!('api', ['tar', 'c'], out);
    expect(result.stderr).toBe('warn [KEY 가림]');
    expect(await readFile(out, 'utf8')).toBe('payload');
    const input = path.join(fake.dir, 'in.bin');
    await writeFile(input, 'file-body');
    const fromFile = await sandbox.execFromFile!('api', ['tar', 'x'], input);
    expect(fromFile.stdout).toBe('payload');
    expect(await readFile(path.join(fake.dir, 'stdin.txt'), 'utf8')).toBe('file-body');
    expect((await fake.calls()).filter((args) => args.includes('exec')).map((args) => args.slice(args.indexOf('exec')))).toEqual([
      ['exec', '-T', 'api', 'tar', 'c'],
      ['exec', '-T', 'api', 'tar', 'x'],
    ]);
  });
});

describe('egressDenials', () => {
  it('edge 로그 마지막 500줄에서 거부 줄만, since 이후만 읽는다', async () => {
    const deny = (host: string, at: string) => `edge-1  | ${at} {"edge":"egress","decision":"deny","host":"${host}","port":443,"method":"GET","path":"/","reason":"차단","at":"${at}"}`;
    const logs = [deny('old.example', '2026-11-12T00:00:00.000Z'), `edge-1  | 2026-11-12T00:00:01.000Z {"edge":"egress","decision":"allow","host":"ok.example","port":443,"at":"2026-11-12T00:00:01.000Z"}`, deny('new.example', '2026-11-12T00:00:02.000Z')].join('\n');
    const fake = await fakeDocker({ logs: { out: `${logs}\n` } });
    const sandbox = await new LocalDockerProvider({ dockerBin: fake.bin }).create(project);
    const all = await sandbox.egressDenials!();
    expect(all.map((denial) => denial.host)).toEqual(['old.example', 'new.example']);
    const since = await sandbox.egressDenials!({ since: new Date('2026-11-12T00:00:01.500Z') });
    expect(since.map((denial) => denial.host)).toEqual(['new.example']);
    const logsCall = (await fake.calls()).find((args) => args.includes('logs'))!;
    expect(logsCall.slice(logsCall.indexOf('logs'))).toEqual(['logs', '--no-color', '--timestamps', '--tail', '500', EDGE_SERVICE]);
  });
});

describe('callExternal', () => {
  it('등록하지 않은 이름·잘못된 경로는 docker를 부르기 전에 거절한다', async () => {
    const fake = await fakeDocker();
    const sandbox = await new LocalDockerProvider({ dockerBin: fake.bin }).create(project);
    const before = (await fake.calls()).length;
    await expect(sandbox.callExternal!('payments', { method: 'GET', path: '/x' }, { via: 'agent' })).rejects.toThrow("'payments'은(는) 등록한 사내 API가 아닙니다");
    await expect(sandbox.callExternal!('billing', { method: 'GET', path: 'x' }, { via: 'agent' })).rejects.toThrow('경로는 "/"로 시작해야 합니다');
    expect((await fake.calls()).length).toBe(before);
  });

  it('edge에서 돌리고 본문의 시크릿을 가린다', async () => {
    const result = { decision: 'allow', status: 200, body: `{"k":"${SECRET}"}`, masked: 0 };
    const fake = await fakeDocker({ exec: { out: `${JSON.stringify(result)}\n` } });
    const sandbox = await new LocalDockerProvider({ dockerBin: fake.bin }).create(project, { secrets: { KEY: SECRET } });
    const got = await sandbox.callExternal!('billing', { method: 'GET', path: '/v1' }, { via: 'agent' });
    expect(got.body).toBe('{"k":"[KEY 가림]"}');
    const exec = (await fake.calls()).find((args) => args.includes('exec'))!;
    expect(exec).toEqual(compose(sandbox.id, await overrideOf(fake), 'exec', '-T', EDGE_SERVICE, 'node', '--input-type=module', '-'));
  });
});

/** 임시 폴더를 이 시험의 폴더로 바꾼다(작업 폴더가 거기에 만들어진다) */
async function privateTmp(fake: Fake): Promise<string> {
  const tmp = path.join(fake.dir, 'tmp');
  await mkdir(tmp, { recursive: true });
  process.env.TMPDIR = tmp;
  return tmp;
}

const workDirsIn = async (tmp: string) => (await readdir(tmp)).filter((name) => name.startsWith('b-studio-')).map((name) => path.join(tmp, name));

describe('destroy·cleanup', () => {
  it('destroy는 down → 이미지 → 작업 폴더를 옛 인자 그대로 지운다', async () => {
    const fake = await fakeDocker({ imagels: { out: 'placeholder' } });
    const tmp = await privateTmp(fake);
    const sandbox = await new LocalDockerProvider({ dockerBin: fake.bin, evaluationAssetRoot: path.join(fake.dir, 'assets') }).create(project);
    // 이미지 이름은 샌드박스 id를 알아야 하므로 만든 뒤 가짜의 답을 바꾼다
    const [workDir] = await workDirsIn(tmp);
    const override = path.join(workDir!, 'compose.override.yaml');
    expect(existsSync(override)).toBe(true);
    await writeFile(fake.bin, (await readFile(fake.bin, 'utf8')).replace("printf '%s' 'placeholder'", `printf '%s\\n' '${sandbox.id}-api:latest' 'other:1'`));
    await sandbox.destroy();
    const calls = (await fake.calls()).filter((args) => args.includes('down') || args[0] === 'image');
    expect(calls).toEqual([
      compose(sandbox.id, override, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'),
      ['image', 'ls', '--filter', `reference=${sandbox.id}-*`, '--format', '{{.Repository}}:{{.Tag}}'],
      ['image', 'rm', `${sandbox.id}-api:latest`],
    ]);
    expect(existsSync(workDir!)).toBe(false);
  });

  it('down이 실패해도 작업 폴더를 지우고 down 오류를 던진다', async () => {
    const fake = await fakeDocker({ down: { err: `boom ${SECRET}`, code: 1 } });
    const tmp = await privateTmp(fake);
    const sandbox = await new LocalDockerProvider({ dockerBin: fake.bin }).create(project, { secrets: { KEY: SECRET } });
    expect(await workDirsIn(tmp)).toHaveLength(1);
    const error = await sandbox.destroy().then(() => undefined, (caught: unknown) => caught as SandboxError);
    expect(error?.message).toContain(`docker compose down 실패 (${sandbox.id})`);
    expect(error?.message).not.toContain(SECRET);
    expect(await workDirsIn(tmp)).toEqual([]);
    expect((await fake.calls()).some((args) => args[0] === 'image')).toBe(false);
  });

  it('cleanup은 compose 파일 없이 프로젝트 이름으로 지운다', async () => {
    const fake = await fakeDocker();
    const provider = new LocalDockerProvider({ dockerBin: fake.bin, evaluationAssetRoot: path.join(fake.dir, 'assets') });
    await provider.cleanup('studio-shop-a1b2c3');
    expect((await fake.calls())[0]).toEqual(['compose', '--project-name', 'studio-shop-a1b2c3', 'down', '--volumes', '--remove-orphans', '--rmi', 'local']);
    await expect(provider.cleanup('studio-x')).rejects.toThrow('b-studio가 만든 샌드박스 id가 아닙니다: studio-x');
  });
});

describe('create 실패 정리(트러블슈팅 194)', () => {
  it('만들기가 실패하면 이 create가 만든 작업 폴더와 평가 자산 폴더를 지운다', async () => {
    const fake = await fakeDocker({}, { configFails: true });
    const tmp = await privateTmp(fake);
    const assets = path.join(fake.dir, 'assets');
    await mkdir(path.join(assets, 'studio-keep-aaaaaa'), { recursive: true });
    const provider = new LocalDockerProvider({ dockerBin: fake.bin, evaluationAssetRoot: assets });
    await expect(provider.create(project)).rejects.toThrow();
    expect((await readdir(tmp)).filter((name) => name.startsWith('b-studio-'))).toEqual([]);
    expect(await readdir(assets)).toEqual(['studio-keep-aaaaaa']);
  });

  it('평가 자산 복사본을 준비하다 실패해도(try 앞쪽의 실패) 작업 폴더와 만들던 복사본을 지운다', async () => {
    const fake = await fakeDocker();
    const tmp = await privateTmp(fake);
    const assets = path.join(fake.dir, 'assets');
    await mkdir(path.join(assets, 'studio-keep-aaaaaa'), { recursive: true });
    const declared = { ...project, spec: { ...project.spec, workflow: { evaluationAssets: ['spec/a.md'] } } } as unknown as LoadedProject;
    const provider = new LocalDockerProvider({ dockerBin: fake.bin, evaluationAssetRoot: assets });
    // 선언하지 않은 경로의 판을 넘기면 복사본 자리를 만든 뒤 채우는 단계에서 거절한다
    await expect(provider.create(declared, { evaluationAssets: [{ path: 'not-declared', kind: 'directory', files: [] }] })).rejects.toThrow('선언하지 않은 평가 자산');
    expect(await workDirsIn(tmp)).toEqual([]);
    expect(await readdir(assets)).toEqual(['studio-keep-aaaaaa']);
  });

  it('성공하면 작업 폴더를 남긴다(destroy가 지운다)', async () => {
    const fake = await fakeDocker();
    const tmp = await privateTmp(fake);
    const sandbox = await new LocalDockerProvider({ dockerBin: fake.bin, evaluationAssetRoot: path.join(fake.dir, 'assets') }).create(project);
    expect((await readdir(tmp)).filter((name) => name.startsWith('b-studio-'))).toHaveLength(1);
    await sandbox.destroy();
    expect(await readdir(tmp)).toEqual([]);
  });

  it('런타임이 등록돼 있지 않으면 작업 폴더를 만들기 전에 거절한다', async () => {
    const fake = await fakeDocker({ info: { out: '{"runc":{}}\n' } });
    const tmp = await privateTmp(fake);
    const provider = new LocalDockerProvider({ dockerBin: fake.bin, runtime: 'runsc' });
    await expect(provider.create(project)).rejects.toThrow("컨테이너 런타임 'runsc'이 Docker 데몬에 등록되지 않았습니다 (등록된 런타임: runc)");
    expect(await readdir(tmp)).toEqual([]);
  });
});
