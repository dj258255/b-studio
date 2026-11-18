import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUnhookedCli, findUnhookedCliByArgv, findUnhookedCliOrUnknown, processArgv, ptyPid } from './host-terminal';

/** 감시가 쓰는 host-terminal의 두 자리(ADR-219, N20) */
describe('ptyPid', () => {
  it('플랫폼이 pid를 주지 못하면 0이 아니라 undefined다', () => {
    expect(ptyPid(null)).toBeUndefined();
    expect(ptyPid(undefined)).toBeUndefined();
    expect(ptyPid(1234)).toBe(1234);
  });
});

describe('findUnhookedCli의 루트 pid', () => {
  const settingsPath = '/g/studio-a/settings.json';
  const cliPath = '/usr/local/bin/claude';
  const processes = [
    { pid: 1, ppid: 0, args: '/sbin/launchd' },
    { pid: 900, ppid: 1, args: `${cliPath} --resume` },
  ];

  it('0이나 1은 루트로 쓰지 않는다: 모든 프로세스를 훑는 대신 "할 수 없음"이다', () => {
    expect(findUnhookedCliOrUnknown(0, processes, { settingsPath, cliPath })).toBeUndefined();
    expect(findUnhookedCliOrUnknown(1, processes, { settingsPath, cliPath })).toBeUndefined();
    expect(() => findUnhookedCli(0, processes, { settingsPath, cliPath })).toThrow();
    // 루트 아래에 아무것도 없으면 빈 목록이다(할 수 없음과 다르다)
    expect(findUnhookedCliOrUnknown(2, processes, { settingsPath, cliPath })).toEqual([]);
  });

  it('정수가 아닌 pid가 든 목록은 읽지 못한 것이라 던진다(건너뛰어 통과시키지 않는다)', () => {
    expect(() => findUnhookedCliOrUnknown(100, [{ pid: 1e30, ppid: 100, args: cliPath }], { settingsPath, cliPath })).toThrow();
    expect(() => findUnhookedCliOrUnknown(100, [{ pid: Number.NaN, ppid: 100, args: cliPath }], { settingsPath, cliPath })).toThrow();
  });

  it('claude의 표식은 낱말 경계로 맞추고 --settings가 하나뿐이어야 붙은 것이다', () => {
    const base = { pid: 101, ppid: 100 };
    const at = (args: string) => findUnhookedCli(100, [{ pid: 100, ppid: 1, args: '/bin/zsh' }, { ...base, args }], { settingsPath, cliPath }).map((entry) => entry.pid);
    expect(at(`${cliPath} --settings ${settingsPath} -p hi`)).toEqual([]);
    expect(at(`${cliPath} --settings ${settingsPath}x`)).toEqual([101]);
    expect(at(`${cliPath} --settings ${settingsPath} --settings /evil.json`)).toEqual([101]);
  });
});

describe('진짜 argv(ADR-219 후속)', () => {
  const settings = '/g/studio-a/settings.json';

  /** 자기가 띄운 자식 하나의 진짜 argv를 읽는다. node가 CLI 스크립트를 띄운 꼴(자리 2)이다. 끝나면 그 자식 PID만 끈다 */
  it('요청 글 인자에 --settings가 든 붙은 CLI는 위반이 아니고, 다른 설정 파일을 받은 것은 위반이다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-argv-'));
    const script = path.join(dir, 'node_modules/@anthropic-ai/claude-code/cli.js');
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, 'setTimeout(() => {}, 5000);\n');
    const mcp = path.join(path.dirname(settings), 'mcp.json');
    const child = spawn(process.execPath, [script, '--mcp-config', mcp, '--settings', settings, 'explain --settings x'], { stdio: 'ignore' });
    try {
      const pid = child.pid!;
      let argv: string[] | null = null;
      for (let i = 0; i < 100; i += 1) {
        argv = processArgv(pid);
        if (argv?.includes('--settings')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(argv).toEqual([process.execPath, script, '--mcp-config', mcp, '--settings', settings, 'explain --settings x']);
      // ps 한 줄은 따옴표를 잃는다: 인자들이 공백으로 이어진 한 줄
      const processes = [
        { pid: process.pid, ppid: 1, args: 'terminal-root' },
        { pid, ppid: process.pid, args: argv!.join(' ') },
      ];
      expect(findUnhookedCliByArgv(process.pid, processes, { settingsPath: settings, cliPath: process.execPath })).toEqual([]);
      expect(findUnhookedCliByArgv(process.pid, processes, { settingsPath: '/g/other/settings.json', cliPath: process.execPath })?.map((entry) => entry.pid)).toEqual([pid]);
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('끝나 거둔 자식은 null이다', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise((resolve) => child.once('exit', resolve));
    expect(processArgv(pid)).toBeNull();
  });

  it('끝난 프로세스는 null이고 건너뛴다. 읽지 못하면 던진다(통과가 아니다)', () => {
    const processes = [
      { pid: 100, ppid: 1, args: '/bin/zsh' },
      { pid: 101, ppid: 100, args: '/usr/local/bin/claude --resume' },
    ];
    const expected = { settingsPath: settings, cliPath: '/usr/local/bin/claude' };
    expect(findUnhookedCliByArgv(100, processes, expected, () => null)).toEqual([]);
    expect(() =>
      findUnhookedCliByArgv(100, processes, expected, () => {
        throw new Error('권한이 없습니다');
      }),
    ).toThrow('권한이 없습니다');
    expect(findUnhookedCliByArgv(0, processes, expected, () => null)).toBeUndefined();
    expect(findUnhookedCliByArgv(100, processes, expected, () => ['/usr/local/bin/claude', '--resume'])?.map((entry) => entry.pid)).toEqual([101]);
  });

  it('codex는 옛 규칙(ps 한 줄)이다', () => {
    const processes = [
      { pid: 100, ppid: 1, args: '/bin/zsh' },
      { pid: 101, ppid: 100, args: '/opt/bin/codex' },
    ];
    expect(findUnhookedCliByArgv(100, processes, { settingsPath: '/g/root/studio-a', cliPath: '/opt/bin/codex', kind: 'codex' }, () => { throw new Error('읽지 않는다'); })?.map((entry) => entry.pid)).toEqual([101]);
  });
});
