import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPENCODE_CONFIG_SCHEMA, openCodeConfigContent, openCodeConfigPathBlocked, openCodeConfigRefusal, openCodeGlobalConfigDir, parseJsonc } from './opencode-config';
import { OPENCODE_PLUGIN_NAME } from './opencode-plugin';

/** 임시 폴더만 쓴다. 홈·작업 폴더·관리형 설정 폴더 모두 임시 폴더 아래의 가짜다(사용자의 실제 설정을 읽지도 쓰지도 않는다) */
let root = '';
let home = '';
let work = '';
let managed = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-occfg-'));
  home = path.join(root, 'home');
  work = path.join(root, 'work', 'project');
  managed = path.join(root, 'managed');
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const refusal = (extra: { xdgConfigHome?: string } = {}) => openCodeConfigRefusal({ cwd: work, home, managedDirs: [managed], ...extra });
const put = async (file: string, text: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

describe('우리 설정 파일의 글', () => {
  it('$schema와 우리 플러그인 하나(file URL)뿐이다. $schema가 없으면 OpenCode가 파일을 다시 쓴다', () => {
    const dir = path.join(root, 'gateway dir');
    const parsed = JSON.parse(openCodeConfigContent(dir)) as Record<string, unknown>;
    expect(parsed).toEqual({ $schema: OPENCODE_CONFIG_SCHEMA, plugin: [pathToFileURL(path.join(dir, OPENCODE_PLUGIN_NAME)).href] });
    expect(parsed.plugin).toEqual([`file://${encodeURI(path.join(dir, OPENCODE_PLUGIN_NAME))}`]);
  });
});

describe('JSONC 읽기', () => {
  it('주석과 끝의 쉼표를 받고, 글자열 안의 // 는 그대로 둔다', () => {
    expect(parseJsonc('{ // a\n "x": "http://y", /* b */ "z": [1,2,], }')).toEqual({ x: 'http://y', z: [1, 2] });
    expect(parseJsonc('﻿{"a":1}')).toEqual({ a: 1 });
  });
  it('읽지 못하면 던진다', () => {
    expect(() => parseJsonc('{ "a": ')).toThrow();
    expect(() => parseJsonc('{ /* 닫히지 않음 "a": 1 }')).toThrow();
  });
});

describe('띄우기 전 검사(openCodeConfigRefusal): 열린 쪽은 "모두 읽었고 플러그인이 없다"뿐이다', () => {
  it('설정이 하나도 없으면 연다', async () => {
    expect(await refusal()).toBeUndefined();
  });

  it('플러그인이 없는 설정은 연다(주석·끝의 쉼표·빈 plugin 목록 포함)', async () => {
    await put(path.join(home, '.config/opencode/opencode.jsonc'), '{ // 내 설정\n "theme": "x", "plugin": [], }');
    await put(path.join(work, 'opencode.json'), '{"$schema":"https://opencode.ai/config.json","model":"a/b"}');
    await put(path.join(root, 'work', '.opencode/opencode.json'), '{"agent":{}}');
    expect(await refusal()).toBeUndefined();
  });

  it.each([
    ['전역 설정', () => path.join(home, '.config/opencode/opencode.json')],
    ['전역 config.json', () => path.join(home, '.config/opencode/config.json')],
    ['전역 jsonc', () => path.join(home, '.config/opencode/opencode.jsonc')],
    ['작업 폴더의 설정', () => path.join(work, 'opencode.json')],
    ['작업 폴더 위 폴더의 설정', () => path.join(root, 'work', 'opencode.jsonc')],
    ['작업 폴더의 .opencode 설정', () => path.join(work, '.opencode/opencode.json')],
    ['홈의 .opencode 설정', () => path.join(home, '.opencode/opencode.json')],
    ['작업 폴더의 TUI 설정', () => path.join(work, 'tui.json')],
    ['관리형 설정', () => path.join(managed, 'opencode.json')],
  ])('%s에 plugin이 있으면 거절한다', async (_name, file) => {
    await put(file(), '{"plugin":["opencode-other@1.0.0"]}');
    expect(await refusal()).toMatch(/plugin이 다른 플러그인을 불러옵니다/);
  });

  it('plugin이 목록이 아니면 거절한다(읽을 수 없는 모양)', async () => {
    await put(path.join(work, 'opencode.json'), '{"plugin":"x"}');
    expect(await refusal()).toMatch(/목록이 아니라/);
  });

  it.each([['.opencode/plugin'], ['.opencode/plugins'], ['../../home/.config/opencode/plugins'], ['../../home/.opencode/plugin']])('%s 폴더에 항목이 있으면 거절한다(자동으로 불러온다)', async (folder) => {
    await put(path.join(work, folder, 'evil.js'), 'export default async () => ({})');
    expect(await refusal()).toMatch(/플러그인 폴더/);
  });

  it('점으로 시작하는 항목뿐인 플러그인 폴더는 연다', async () => {
    await put(path.join(work, '.opencode/plugins/.gitkeep'), '');
    expect(await refusal()).toBeUndefined();
  });

  it('읽지 못하는 설정(JSON 아님·잘린 글)은 거절한다 — 모르는 것은 막는다', async () => {
    for (const text of ['{ "plugin": ', 'not json', '{"a": {"b"}}']) {
      await put(path.join(work, 'opencode.json'), text);
      expect(await refusal(), text).toMatch(/JSON으로 읽지 못해/);
    }
  });

  it('{file:…}로 다른 파일을 끼워 넣는 설정은 거절한다(끼운 내용이 plugin을 만들 수 있다)', async () => {
    await put(path.join(work, 'opencode.json'), '{"instructions":["{file:./x.md}"]}');
    expect(await refusal()).toMatch(/\{file:/);
  });

  it('설정 파일이 상한(1MB)보다 크면 읽지 않고 거절한다(읽기 전에 크기를 본다)', async () => {
    await put(path.join(work, 'opencode.json'), `{"x":"${'a'.repeat(1024 * 1024 + 10)}"}`);
    expect(await refusal()).toMatch(/너무 커서/);
    // 대조: 상한 안이면 읽는다
    await put(path.join(work, 'opencode.json'), `{"x":"${'a'.repeat(1000)}"}`);
    expect(await refusal()).toBeUndefined();
  });

  it('읽지 못하는 설정 자리(파일 자리가 폴더)는 거절한다', async () => {
    await mkdir(path.join(work, 'opencode.json'), { recursive: true });
    expect(await refusal()).toMatch(/읽지 못해/);
  });

  it('XDG_CONFIG_HOME이 있으면 그 아래 opencode 폴더를 본다', async () => {
    const xdg = path.join(root, 'xdg');
    expect(openCodeGlobalConfigDir(home, xdg)).toBe(path.join(xdg, 'opencode'));
    expect(openCodeGlobalConfigDir(home, 'relative')).toBe(path.join(home, '.config', 'opencode'));
    await put(path.join(xdg, 'opencode/opencode.json'), '{"plugin":["x"]}');
    expect(await refusal({ xdgConfigHome: xdg })).toMatch(/plugin이/);
    expect(await refusal()).toBeUndefined();
  });

  it('옛 전역 설정(확장자 없는 config)이 있으면 거절한다', async () => {
    await put(path.join(home, '.config/opencode/config'), 'model = "x"');
    expect(await refusal()).toMatch(/옛 전역 설정/);
  });

  it('홈을 모르면(undefined) 빈 홈으로 읽고 던지지 않는다', async () => {
    await expect(openCodeConfigRefusal({ cwd: work, home: undefined, managedDirs: [managed] })).resolves.toBeUndefined();
  });
});

describe('설정 쓰기 막기(openCodeConfigPathBlocked): 거부 목록이라 넓게 맞춘다', () => {
  const blocked = (file: string) => openCodeConfigPathBlocked({ cwd: work, home, file });

  it.each([
    ['.opencode/plugins/x.js'],
    ['.opencode/opencode.json'],
    ['sub/.opencode/plugin/a.ts'],
    ['./.opencode/../.opencode/x'],
    ['opencode.json'],
    ['opencode.jsonc'],
    ['sub/dir/opencode.json'],
    ['tui.json'],
    ['TUI.JSON'],
    ['.OpenCode/x'],
    ['.opencode./x'],
    ['.openc​ode/x'],
    ['．opencode/x'],
    ['x/../.opencode/y'],
    ['.opencode'],
  ])('%s 는 막는다', async (file) => {
    expect(await blocked(file)).toBe(true);
  });

  it('절대 경로와 ~/ 로 쓴 전역 설정 자리도 막는다(전역 설정 폴더 안의 모든 것)', async () => {
    expect(await blocked(path.join(home, '.config/opencode/opencode.jsonc'))).toBe(true);
    expect(await blocked(path.join(home, '.config/opencode/plugins/x.js'))).toBe(true);
    expect(await blocked(path.join(home, '.config/opencode/config.json'))).toBe(true);
    expect(await blocked('~/.config/opencode/plugin/x.ts')).toBe(true);
    expect(await blocked(path.join(home, '.opencode/opencode.json'))).toBe(true);
    expect(await openCodeConfigPathBlocked({ cwd: work, home, xdgConfigHome: path.join(root, 'xdg'), file: path.join(root, 'xdg/opencode/plugins/x.js') })).toBe(true);
  });

  it('프로젝트의 평범한 파일은 막지 않는다(config.json·package.json·opencode가 든 다른 이름 포함)', async () => {
    for (const file of ['src/a.ts', 'config.json', 'package.json', 'docs/opencode-notes.md', 'opencode/readme.md', 'not-opencode.json', 'tui.json.bak', path.join(work, 'src/b.ts')]) {
      expect(await blocked(file), file).toBe(false);
    }
  });

  it('링크를 지나는 쓰기를 막는다: 이름이 다른 링크가 설정 폴더를 가리키는 경우', async () => {
    await mkdir(path.join(work, '.opencode'), { recursive: true });
    await symlink(path.join(work, '.opencode'), path.join(work, 'innocent'));
    expect(await blocked('innocent/plugins/x.js')).toBe(true);
    await mkdir(path.join(home, '.config/opencode'), { recursive: true });
    await symlink(path.join(home, '.config/opencode'), path.join(work, 'cfg'));
    expect(await blocked('cfg/opencode.jsonc')).toBe(true);
    expect(await blocked('cfg/plugins/new.js')).toBe(true);
    // 설정 폴더가 아직 없어도 이름으로 막는다
    expect(await blocked('later/.opencode/x')).toBe(true);
  });

  it('작업 폴더 위의 .opencode 폴더도 막는다(OpenCode가 위로 올라가며 찾는다)', async () => {
    await mkdir(path.join(root, 'work', '.opencode'), { recursive: true });
    expect(await blocked('../.opencode/plugin/x.js')).toBe(true);
    await symlink(path.join(root, 'work', '.opencode'), path.join(work, 'up'));
    expect(await blocked('up/x.js')).toBe(true);
  });
});
