import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 어느 폴더에서든 `b-studio` 한 단어로 스튜디오를 띄운다(#1448). 실행 파일(bin/b-studio.mjs)은 링크를 따라가 저장소를 찾고,
 * 사용자의 작업 폴더는 그대로 둔 채 tsx로 apps/cli/src/main.ts를 돌린다. 시험은 임시 폴더의 링크와 `--help`만 쓴다(스튜디오를 띄우지 않는다)
 */
const root = realpathSync(path.resolve(import.meta.dirname, '..'));
const launcher = path.join(root, 'bin', 'b-studio.mjs');
const installer = path.join(root, 'scripts', 'install-cli.mjs');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const temps: string[] = [];
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (file: string, args: string[], cwd: string) =>
  spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 60_000 });

describe('b-studio 실행 파일', () => {
  it('다른 폴더에 둔 링크로 불러도 저장소를 찾아 사용법을 찍고 0으로 끝난다', () => {
    const bin = temp('b-studio-bin-');
    const cwd = temp('b-studio-cwd-');
    symlinkSync(launcher, path.join(bin, 'b-studio'));
    const result = run(path.join(bin, 'b-studio'), ['--help'], cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('사용법:');
  }, 60_000);

  it('종료 코드를 그대로 돌려준다(모르는 명령)', () => {
    const cwd = temp('b-studio-cwd-');
    const direct = spawnSync(process.execPath, [tsxCli, '--tsconfig', path.join(root, 'apps/cli/tsconfig.json'), path.join(root, 'apps/cli/src/main.ts'), '없는-명령'], { cwd, encoding: 'utf8', timeout: 60_000 });
    const viaLauncher = run(launcher, ['없는-명령'], cwd);
    expect(direct.status).not.toBe(0);
    expect(viaLauncher.status).toBe(direct.status);
  }, 60_000);
});

describe('launch가 부르는 명령의 작업 폴더', () => {
  it('pnpm install·cargo·docker는 사용자가 b-studio를 친 폴더가 아니라 저장소 루트에서 돈다', () => {
    const cwd = temp('b-studio-cwd-');
    const probe = path.join(cwd, 'probe.mts');
    writeFileSync(
      probe,
      `import { createLaunchDeps } from ${JSON.stringify(path.join(root, 'apps/cli/src/commands/launch.ts'))};\n` +
        `const result = await createLaunchDeps().exec(process.execPath, ['-e', 'process.stdout.write(process.cwd())']);\n` +
        `process.stdout.write(result.stdout);\n`,
    );
    const out = execFileSync(process.execPath, [tsxCli, '--tsconfig', path.join(root, 'apps/cli/tsconfig.json'), probe], { cwd, encoding: 'utf8', timeout: 60_000 });
    expect(realpathSync(out.trim())).toBe(root);
  }, 60_000);
});

describe('설치 스크립트(scripts/install-cli.mjs)', () => {
  const install = (dir: string, ...extra: string[]) => spawnSync(process.execPath, [installer, '--dir', dir, ...extra], { encoding: 'utf8', timeout: 30_000 });

  it('지정한 폴더에 실행 파일로 가는 링크를 만들고, 다시 해도 같다', () => {
    const dir = temp('b-studio-bin-');
    expect(install(dir).status).toBe(0);
    const link = path.join(dir, 'b-studio');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(launcher);
    expect(install(dir).status).toBe(0);
    expect(realpathSync(link)).toBe(launcher);
  });

  it('폴더가 없으면 만든다', () => {
    const dir = path.join(temp('b-studio-home-'), '.local', 'bin');
    expect(install(dir).status).toBe(0);
    expect(realpathSync(path.join(dir, 'b-studio'))).toBe(launcher);
  });

  it('같은 이름의 남의 파일은 덮어쓰지 않고 멈춘다', () => {
    const dir = temp('b-studio-bin-');
    writeFileSync(path.join(dir, 'b-studio'), '#!/bin/sh\necho mine\n');
    const result = install(dir);
    expect(result.status).not.toBe(0);
    // 무엇이 막았는지 알려 준다(링크 만들기 실패로 우연히 멈춘 것이 아니다)
    expect(result.stderr).toContain('덮어쓰지 않았습니다');
    expect(readFileSync(path.join(dir, 'b-studio'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('남의 파일로 가는 링크도 덮어쓰지 않는다', () => {
    const dir = temp('b-studio-bin-');
    const other = path.join(temp('b-studio-other-'), 'tool.mjs');
    writeFileSync(other, 'console.log(1)\n');
    symlinkSync(other, path.join(dir, 'b-studio'));
    expect(install(dir).status).not.toBe(0);
    expect(readlinkSync(path.join(dir, 'b-studio'))).toBe(other);
  });

  it('다른 체크아웃의 b-studio 실행 파일로 가는 링크는 이 체크아웃으로 바꾼다', () => {
    const dir = temp('b-studio-bin-');
    const otherCheckout = temp('b-studio-checkout-');
    mkdirSync(path.join(otherCheckout, 'bin'));
    writeFileSync(path.join(otherCheckout, 'bin', 'b-studio.mjs'), readFileSync(launcher, 'utf8'));
    symlinkSync(path.join(otherCheckout, 'bin', 'b-studio.mjs'), path.join(dir, 'b-studio'));
    expect(install(dir).status).toBe(0);
    expect(realpathSync(path.join(dir, 'b-studio'))).toBe(launcher);
  });

  it('제거는 우리 링크만 지우고 남의 파일은 남긴다', () => {
    const dir = temp('b-studio-bin-');
    expect(install(dir).status).toBe(0);
    expect(install(dir, '--uninstall').status).toBe(0);
    expect(() => lstatSync(path.join(dir, 'b-studio'))).toThrow();
    writeFileSync(path.join(dir, 'b-studio'), 'mine\n');
    expect(install(dir, '--uninstall').status).not.toBe(0);
    expect(readFileSync(path.join(dir, 'b-studio'), 'utf8')).toBe('mine\n');
  });
});
