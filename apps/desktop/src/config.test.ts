import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPath, parseConfig, readConfig, saveWindowBounds, writeConfig } from './config';

const directory = mkdtempSync(path.join(tmpdir(), 'b-studio-desktop-config-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const config = { root: '/repo/b-studio', node: '/nvm/v22/bin/node', pnpm: '/nvm/v22/bin/pnpm', mode: 'local' };

function file(name: string): string {
  return path.join(directory, name);
}

describe('configPath', () => {
  it('기본은 ~/.config/b-studio/desktop.json이고 B_STUDIO_DESKTOP_CONFIG로 바꿀 수 있다', () => {
    expect(configPath({})).toMatch(/[\\/]\.config[\\/]b-studio[\\/]desktop\.json$/);
    expect(configPath({ B_STUDIO_DESKTOP_CONFIG: '/tmp/custom.json' })).toBe('/tmp/custom.json');
    // 빈 값은 기본 경로로 본다
    expect(configPath({ B_STUDIO_DESKTOP_CONFIG: '  ' })).toMatch(/[\\/]\.config[\\/]/);
  });
});

describe('readConfig', () => {
  it('파일이 없으면 undefined다(앱은 설치 안내 화면을 띄운다)', () => {
    expect(readConfig(file('missing.json'))).toBeUndefined();
  });

  it('쓴 설정을 그대로 다시 읽는다', () => {
    const target = file('desktop.json');
    writeConfig(config, target);

    expect(readConfig(target)).toEqual(config);
    // 사람이 읽고 고칠 수 있게 들여쓴 JSON으로 쓴다
    expect(readFileSync(target, 'utf8')).toContain('\n  "root"');
  });

  it('mode 기본값은 local이고 port·window는 선택이다', () => {
    expect(parseConfig(JSON.stringify({ root: '/repo', node: '/node', pnpm: '/pnpm' }))).toEqual({ root: '/repo', node: '/node', pnpm: '/pnpm', mode: 'local' });
    expect(parseConfig(JSON.stringify({ ...config, port: 3100, window: { width: 1200, height: 800, x: 10, y: 20 } }))).toMatchObject({
      port: 3100,
      window: { width: 1200, height: 800, x: 10, y: 20 },
    });
  });

  it('형식이 틀리면 이유를 담아 던진다', () => {
    const broken = file('broken.json');
    writeFileSync(broken, '{ not json');
    expect(() => readConfig(broken)).toThrow(/읽지 못했습니다/);

    const empty = file('empty.json');
    writeFileSync(empty, JSON.stringify({ root: '', node: '/node', pnpm: '/pnpm' }));
    expect(() => readConfig(empty)).toThrow(/root 값이 비어 있습니다/);

    const list = file('list.json');
    writeFileSync(list, '[]');
    expect(() => readConfig(list)).toThrow(/형식이 올바르지 않습니다/);

    const badPort = file('port.json');
    writeFileSync(badPort, JSON.stringify({ ...config, port: 70_000 }));
    expect(() => readConfig(badPort)).toThrow(/port 값이 올바르지 않습니다/);
  });
});

describe('saveWindowBounds', () => {
  it('설정이 있으면 창 크기·위치만 갱신한다', () => {
    const target = file('bounds.json');
    writeConfig({ ...config, port: 3000 }, target);

    saveWindowBounds({ width: 1440, height: 900, x: 4, y: 8 }, target);

    expect(readConfig(target)).toEqual({ ...config, port: 3000, window: { width: 1440, height: 900, x: 4, y: 8 } });
  });

  it('설정 파일이 없으면 아무것도 만들지 않는다', () => {
    const target = file('bounds-missing.json');
    saveWindowBounds({ width: 100, height: 100 }, target);
    expect(readConfig(target)).toBeUndefined();
  });
});
