import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCodeConfigPathBlocked, openCodeConfigRefusal } from './opencode-config';

/**
 * OpenCode는 Bun으로 컴파일된 실행 파일이다(바이너리에 `Bun v1.3.14`). 그 판의 `bun build --compile`은 `.env`와 `bunfig.toml`을 실행 파일에서 기본으로 읽는다
 * (바이너리의 도움말 `--compile-autoload-dotenv ... (default: true)`, `--compile-autoload-bunfig ... (default: true)`). opencode가 이 기능을 껐는지는 실행 없이 알 수 없어 읽는 것으로 본다(#1475).
 * 임시 폴더만 쓴다.
 */
let root = '';
let home = '';
let work = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-ocenv-'));
  home = path.join(root, 'home');
  work = path.join(root, 'work', 'project');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const refusal = () => openCodeConfigRefusal({ cwd: work, home, managedDirs: [path.join(root, 'managed')] });
const FILES = ['.env', '.env.local', '.env.development', '.env.production', '.env.test', '.env.development.local', '.env.production.local', '.env.test.local'];

describe('작업 폴더의 .env 파일(Bun이 시작할 때 환경에 넣는다)', () => {
  it('평범한 값만 있으면 연다', async () => {
    for (const name of FILES) await writeFile(path.join(work, name), 'DATABASE_URL=postgres://x\nNODE_ENV=production\nPORT=3000\n');
    expect(await refusal()).toBeUndefined();
  });

  it.each(FILES)('%s에 OPENCODE_ 열쇠나 코드 적재 변수가 있으면 거절한다', async (name) => {
    for (const line of ['OPENCODE_CONFIG_CONTENT={"plugin":["x"]}', 'OPENCODE_PERMISSION={}', 'opencode_pure=1', 'NODE_OPTIONS=--require /x.js', 'PATH=/evil', 'BASH_ENV=/x', 'LD_PRELOAD=/x', 'DYLD_INSERT_LIBRARIES=/x', 'export NODE_PATH: /x']) {
      await writeFile(path.join(work, name), `A=1\n${line}\n`);
      const message = await refusal();
      expect(message, `${name} ${line}`).toContain(name);
      expect(message).not.toMatch(/ADR/u);
    }
  });

  it('대소문자를 접어 읽고(.ENV.Local), 링크·폴더·너무 큰 파일은 읽지 않고 거절한다', async () => {
    await writeFile(path.join(work, '.ENV.Local'), 'OPENCODE_PERMISSION={}\n');
    expect(await refusal()).toContain('.ENV.Local');
    await rm(path.join(work, '.ENV.Local'));
    await mkdir(path.join(work, '.env.test'));
    expect(await refusal()).toContain('.env.test');
    await rm(path.join(work, '.env.test'), { recursive: true });
    await writeFile(path.join(root, 'elsewhere'), 'A=1\n');
    await symlink(path.join(root, 'elsewhere'), path.join(work, '.env'));
    expect(await refusal()).toContain('.env');
    await rm(path.join(work, '.env'));
    await writeFile(path.join(work, '.env.local'), `A=${'x'.repeat(1024 * 1024 + 1)}\n`);
    expect(await refusal()).toContain('.env.local');
  });

  it('bunfig.toml과 .bunfig.toml이 있으면 거절하고 까닭(preload로 코드 실행)을 적는다', async () => {
    for (const name of ['bunfig.toml', '.bunfig.toml', 'BunFig.TOML']) {
      await writeFile(path.join(work, name), 'preload = ["./x.ts"]\n');
      const message = await refusal();
      expect(message, name).toContain(name);
      expect(message).toContain('preload');
      expect(message).not.toMatch(/ADR/u);
      await rm(path.join(work, name));
    }
  });

  it('작업 폴더만 본다(Bun은 위 폴더의 .env를 읽지 않는다)', async () => {
    await writeFile(path.join(root, 'work', '.env'), 'OPENCODE_PERMISSION={}\n');
    expect(await refusal()).toBeUndefined();
  });
});

describe('세션 중에 에이전트가 쓰는 것(다음에 CLI를 다시 띄우면 읽힌다)', () => {
  const blocked = (file: string) => openCodeConfigPathBlocked({ cwd: work, home, file });
  it('작업 폴더 바로 아래의 .env 계열과 bunfig 파일 쓰기는 막는다. 하위 폴더·다른 파일은 막지 않는다', async () => {
    for (const name of [...FILES, '.ENV', 'bunfig.toml', '.bunfig.toml', './.env.local', path.join(work, '.env')]) expect(await blocked(name), name).toBe(true);
    for (const name of ['sub/.env', 'README.md', '.env.example', 'src/bunfig.toml']) expect(await blocked(name), name).toBe(false);
  });
});
