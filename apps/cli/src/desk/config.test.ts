import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { colorDepth, deskConfigDir, loadDeskConfig, loadDeskLayout, parsePrefix, saveDeskLayout } from './config';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desk-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('desk 설정 폴더(#874)', () => {
  it('XDG_CONFIG_HOME이 있으면 그 아래, 없으면 홈의 .config 아래 b-studio다', () => {
    expect(deskConfigDir({ XDG_CONFIG_HOME: '/x/conf', HOME: '/home/me' })).toBe('/x/conf/b-studio');
    expect(deskConfigDir({ HOME: '/home/me' })).toBe('/home/me/.config/b-studio');
    // 상대 경로 XDG_CONFIG_HOME은 명세대로 무시한다
    expect(deskConfigDir({ XDG_CONFIG_HOME: 'rel', HOME: '/home/me' })).toBe('/home/me/.config/b-studio');
  });
});

describe('앞글쇠 이름', () => {
  it('C-a, Ctrl-a, ctrl+A를 Ctrl-a 글자로 읽는다', () => {
    expect(parsePrefix('C-a')).toEqual({ key: '\x01', label: 'Ctrl-a' });
    expect(parsePrefix('Ctrl-a')).toEqual({ key: '\x01', label: 'Ctrl-a' });
    expect(parsePrefix('ctrl+A')).toEqual({ key: '\x01', label: 'Ctrl-a' });
    expect(parsePrefix('C-b')).toEqual({ key: '\x02', label: 'Ctrl-b' });
  });

  it('터미널이 다른 키로 보내는 글쇠(Ctrl-c·h·i·j·m)와 모르는 꼴은 받지 않는다', () => {
    for (const bad of ['C-c', 'C-h', 'C-i', 'C-j', 'C-m', 'a', 'C-1', 'Alt-a', '']) expect(parsePrefix(bad)).toBeUndefined();
  });
});

describe('desk.json 설정', () => {
  it('파일이 없으면 기본값이고 알림도 없다', () => {
    expect(loadDeskConfig(dir)).toEqual({ config: {}, warnings: [] });
  });

  it('앞글쇠·알림·마우스·색을 읽는다', () => {
    writeFileSync(join(dir, 'desk.json'), JSON.stringify({ prefix: 'C-a', notify: false, mouse: false, color: '256' }));
    expect(loadDeskConfig(dir)).toEqual({ config: { prefix: { key: '\x01', label: 'Ctrl-a' }, notify: false, mouse: false, color: '256' }, warnings: [] });
  });

  it('잘못된 값은 기본값으로 두고 무엇이 틀렸는지 알린다', () => {
    writeFileSync(join(dir, 'desk.json'), JSON.stringify({ prefix: 'C-c', notify: 'no', mouse: 1, color: 'rgb', extra: true }));
    const { config, warnings } = loadDeskConfig(dir);
    expect(config).toEqual({});
    expect(warnings.join('\n')).toMatch(/prefix/);
    expect(warnings.join('\n')).toMatch(/notify/);
    expect(warnings.join('\n')).toMatch(/mouse/);
    expect(warnings.join('\n')).toMatch(/color/);
  });

  it('JSON이 아니면 기본값으로 두고 알린다', () => {
    writeFileSync(join(dir, 'desk.json'), '{ prefix: ');
    const { config, warnings } = loadDeskConfig(dir);
    expect(config).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/desk\.json/);
  });
});

describe('배치 기억', () => {
  it('저장한 배치를 그대로 읽고, 폴더가 없으면 만든다', () => {
    const nested = join(dir, 'a', 'b-studio');
    saveDeskLayout(nested, { layout: 2, slots: ['s1', undefined, undefined, undefined], focus: 1, zoom: true, sidebarHidden: true });
    expect(JSON.parse(readFileSync(join(nested, 'desk-state.json'), 'utf8'))).toMatchObject({ layout: 2, slots: ['s1', null, null, null] });
    expect(loadDeskLayout(nested)).toEqual({ layout: 2, slots: ['s1', undefined, undefined, undefined], focus: 1, zoom: true, sidebarHidden: true });
  });

  it('없거나 깨진 파일, 이상한 값은 버린다', () => {
    expect(loadDeskLayout(dir)).toBeUndefined();
    writeFileSync(join(dir, 'desk-state.json'), 'nope');
    expect(loadDeskLayout(dir)).toBeUndefined();
    writeFileSync(join(dir, 'desk-state.json'), JSON.stringify({ layout: 3, slots: 'x', focus: 9 }));
    expect(loadDeskLayout(dir)).toEqual({ layout: 1, slots: [undefined, undefined, undefined, undefined], focus: 0, zoom: false, sidebarHidden: false });
  });

  it('저장하지 못하면 오류를 던진다(부르는 쪽이 알린다)', () => {
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    expect(() => saveDeskLayout(join(file, 'b-studio'), { layout: 1, slots: [undefined, undefined, undefined, undefined], focus: 0, zoom: false, sidebarHidden: false })).toThrow();
  });
});

describe('색 깊이', () => {
  it('COLORTERM이 truecolor·24bit면 24비트, 아니면 256색이다', () => {
    expect(colorDepth({ COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(colorDepth({ COLORTERM: '24bit' })).toBe('truecolor');
    expect(colorDepth({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('256');
    expect(colorDepth({})).toBe('256');
  });

  it('설정이 앞선다', () => {
    expect(colorDepth({ COLORTERM: 'truecolor' }, '256')).toBe('256');
    expect(colorDepth({ TERM_PROGRAM: 'Apple_Terminal' }, 'truecolor')).toBe('truecolor');
    expect(colorDepth({ COLORTERM: 'truecolor' }, 'auto')).toBe('truecolor');
  });
});

describe('색 팔레트(#887)', () => {
  it('theme은 dark·light를 받고, 그 밖은 알리고 기본값으로 둔다', () => {
    writeFileSync(join(dir, 'desk.json'), JSON.stringify({ theme: 'light' }));
    expect(loadDeskConfig(dir)).toEqual({ config: { theme: 'light' }, warnings: [] });
    writeFileSync(join(dir, 'desk.json'), JSON.stringify({ theme: 'neon' }));
    const bad = loadDeskConfig(dir);
    expect(bad.config).toEqual({});
    expect(bad.warnings).toEqual([expect.stringContaining('theme')]);
  });
});

describe('카드 그림 설정(#902)', () => {
  it('sprites·animate·graphics를 읽고, 틀린 값은 기본값으로 두고 알린다', () => {
    writeFileSync(join(dir, 'desk.json'), JSON.stringify({ sprites: 'named', animate: false, graphics: 'blocks' }));
    expect(loadDeskConfig(dir)).toEqual({ config: { sprites: 'named', animate: false, graphics: 'blocks' }, warnings: [] });
    writeFileSync(join(dir, 'desk.json'), JSON.stringify({ sprites: 'all', animate: 'yes', graphics: 'sixel' }));
    const { config, warnings } = loadDeskConfig(dir);
    expect(config).toEqual({});
    expect(warnings).toEqual([expect.stringContaining('animate'), expect.stringContaining('sprites'), expect.stringContaining('graphics')]);
  });
});
