import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childEnv, resolveCliCommand, spawnClaudeCli } from './claude-cli-process';
import { preflightClaudeCode } from './claude-code-runner';

/**
 * CLI 실행 파일을 PATH에서 찾을 때 프로젝트 폴더(에이전트가 파일을 쓰는 곳) 안의 실행 파일이 잡히지 않게 한다.
 * 자식 프로세스는 cwd를 프로젝트 루트로 띄우므로, PATH의 빈 항목·`.`·상대 항목이나 프로젝트 안을 가리키는 항목이 있으면
 * 에이전트가 심어 둔 `claude`가 b-studio의 권한으로 실행된다(커밋 보안 검토 지적).
 */
const posixOnly = process.platform === 'win32' ? it.skip : it;

let base: string;
let project: string;
let outside: string;
let marker: string;

function plant(dir: string, name = 'claude'): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho planted > ${JSON.stringify(marker)}\n`);
  chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'b-studio-cli-resolve-'));
  project = path.join(base, 'project');
  outside = path.join(base, 'tools', 'bin');
  marker = path.join(base, 'planted.txt');
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveCliCommand', () => {
  posixOnly('PATH의 빈 항목·상대 항목은 건너뛴다', () => {
    plant(project);
    plant(path.join(project, 'bin'));
    for (const PATH of ['', '.', ':', 'bin', `.${path.delimiter}bin`]) {
      expect(() => resolveCliCommand('claude', { PATH }, project), JSON.stringify(PATH)).toThrow(/ENOENT/);
    }
  });

  posixOnly('프로젝트 안을 가리키는 절대 항목은 건너뛰고 바깥 것을 고른다', () => {
    plant(path.join(project, 'node_modules', '.bin'));
    const good = plant(outside);
    const PATH = [path.join(project, 'node_modules', '.bin'), outside].join(path.delimiter);
    expect(resolveCliCommand('claude', { PATH }, project)).toBe(good);
    expect(() => resolveCliCommand('claude', { PATH: path.join(project, 'node_modules', '.bin') }, project)).toThrow(/ENOENT/);
  });

  posixOnly('바깥의 링크가 프로젝트 안을 가리키면 건너뛴다', () => {
    const inner = plant(path.join(project, 'x'));
    mkdirSync(outside, { recursive: true });
    symlinkSync(inner, path.join(outside, 'claude'));
    expect(() => resolveCliCommand('claude', { PATH: outside }, project)).toThrow(/ENOENT/);
  });

  posixOnly('실행 권한이 없거나 폴더면 건너뛴다', () => {
    mkdirSync(path.join(outside, 'claude'), { recursive: true });
    const other = path.join(base, 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'claude'), 'x');
    expect(() => resolveCliCommand('claude', { PATH: [outside, other].join(path.delimiter) }, project)).toThrow(/ENOENT/);
  });

  it('경로가 든 명령은 절대 경로만 받고, 프로젝트 안이면 거절한다', () => {
    expect(() => resolveCliCommand('./claude', { PATH: '' }, project)).toThrow(/ENOENT/);
    expect(() => resolveCliCommand('bin/claude', { PATH: '' }, project)).toThrow(/ENOENT/);
    expect(resolveCliCommand(process.execPath, { PATH: '' }, project)).toBe(process.execPath);
    if (process.platform !== 'win32') {
      const inner = plant(project);
      expect(() => resolveCliCommand(inner, { PATH: '' }, project)).toThrow(/ENOENT/);
    }
  });

  it('막을 폴더를 주지 않으면 상대 항목만 건너뛴다', () => {
    expect(resolveCliCommand(process.execPath, { PATH: '' })).toBe(process.execPath);
    expect(() => resolveCliCommand('./claude', { PATH: '' })).toThrow(/ENOENT/);
  });

  posixOnly('상대 항목은 바깥 폴더를 가리켜도 건너뛴다(어느 cwd 기준으로 풀릴지 모른다)', () => {
    plant(outside);
    const relative = path.relative(process.cwd(), outside);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(() => resolveCliCommand('claude', { PATH: relative }, project)).toThrow(/ENOENT/);
    expect(() => resolveCliCommand('claude', { PATH: relative })).toThrow(/ENOENT/);
  });

  posixOnly('막을 폴더의 실제 경로를 못 읽으면 안으로 본다', () => {
    plant(outside);
    expect(() => resolveCliCommand('claude', { PATH: outside }, path.join(base, 'missing-root'))).toThrow(/ENOENT/);
  });
});

describe('spawnClaudeCli', () => {
  posixOnly('프로젝트에 심은 claude를 PATH의 `.`으로 띄우지 않는다', async () => {
    plant(project);
    const proc = spawnClaudeCli({ command: 'claude', args: [], cwd: project, env: { PATH: '.' } });
    const exit = await proc.exited;
    expect(exit.error?.message ?? '').toMatch(/ENOENT/);
    expect(existsSync(marker)).toBe(false);
    for await (const _ of proc.messages()) throw new Error('메시지가 오면 안 된다');
  });

  posixOnly('찾은 절대 경로로 띄운다(이름으로 다시 찾지 않는다)', async () => {
    plant(project);
    mkdirSync(outside, { recursive: true });
    const goodMarker = path.join(base, 'good.txt');
    writeFileSync(path.join(outside, 'claude'), `#!/bin/sh\necho good > ${JSON.stringify(goodMarker)}\n`);
    chmodSync(path.join(outside, 'claude'), 0o755);
    const proc = spawnClaudeCli({ command: 'claude', args: [], cwd: project, env: { PATH: `.${path.delimiter}${outside}` } });
    await proc.exited;
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(goodMarker)).toBe(true);
  });

  posixOnly('자식이 PATH로 다시 찾는 인터프리터(`#!/usr/bin/env node`)도 프로젝트에 심은 것을 쓰지 않는다', async () => {
    // npm으로 깐 claude는 `#!/usr/bin/env node` 스크립트다. env는 자식의 PATH에서 node를 찾는다
    plant(project, 'node');
    const goodMarker = path.join(base, 'good.txt');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'claude'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(goodMarker)}, 'x')\n`);
    chmodSync(path.join(outside, 'claude'), 0o755);
    const nodeDir = path.dirname(process.execPath);
    for (const PATH of [`.${path.delimiter}${nodeDir}`, `${project}${path.delimiter}${nodeDir}`, `${path.delimiter}${nodeDir}`]) {
      rmSync(marker, { force: true });
      rmSync(goodMarker, { force: true });
      const proc = spawnClaudeCli({ command: path.join(outside, 'claude'), args: [], cwd: project, env: { PATH } });
      await proc.exited;
      expect(existsSync(marker), JSON.stringify(PATH)).toBe(false);
      expect(existsSync(goodMarker), JSON.stringify(PATH)).toBe(true);
    }
  });
});

describe('childEnv', () => {
  posixOnly('PATH에서 상대 항목·빈 항목·프로젝트 안(링크 포함)을 빼고 나머지 환경은 그대로 둔다', () => {
    const inner = path.join(project, 'bin');
    mkdirSync(inner, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = path.join(base, 'link-into-project');
    symlinkSync(inner, link);
    const PATH = ['', '.', 'bin', inner, link, outside, path.join(base, 'missing')].join(path.delimiter);
    const env = childEnv({ PATH, HOME: '/home/x', CLAUDE_CONFIG_DIR: '/c' }, project);
    expect(env.PATH).toBe(outside);
    expect(env.HOME).toBe('/home/x');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/c');
  });

  it('PATH가 없으면 만들지 않는다', () => {
    expect(childEnv({ HOME: '/h' }, project)).toEqual({ HOME: '/h' });
  });
});

describe('preflightClaudeCode', () => {
  posixOnly('사전 확인도 프로젝트 폴더(cwd) 안의 claude를 띄우지 않는다', async () => {
    plant(project);
    const result = await preflightClaudeCode({ command: 'claude', cwd: project, env: { PATH: project } });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('ENOENT') });
    expect(existsSync(marker)).toBe(false);
  });

  posixOnly('사전 확인의 자식 PATH도 정리한다(심은 node를 쓰지 않는다)', async () => {
    plant(project, 'node');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'claude'), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))\n`);
    chmodSync(path.join(outside, 'claude'), 0o755);
    for (const first of ['.', project]) {
      const result = await preflightClaudeCode({ command: 'claude', cwd: project, env: { PATH: [first, outside, path.dirname(process.execPath)].join(path.delimiter) } });
      expect(existsSync(marker), first).toBe(false);
      expect(result, first).toMatchObject({ ok: true });
    }
  });
});
