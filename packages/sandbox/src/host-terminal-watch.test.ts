import { describe, expect, it } from 'vitest';
import { findUnhookedCli, findUnhookedCliOrUnknown, ptyPid } from './host-terminal';

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
