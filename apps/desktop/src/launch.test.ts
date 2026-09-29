import { describe, expect, it } from 'vitest';
import type { DesktopConfig } from './config';
import { launchArgs, launchLogDir, launchStudio, parseLaunchResult, parseStopResult, stopArgs, stopIfStarted, stopStudio, type CommandRunner } from './launch';

const config: DesktopConfig = { root: '/repo/b-studio', node: '/nvm/v22/bin/node', pnpm: '/nvm/v22/bin/pnpm', mode: 'local' };

/** 명령을 실제로 실행하지 않는 가짜 실행기. 무엇을 불렀는지 기록한다 */
function fakeRunner(reply: (command: string, args: readonly string[]) => { code: number; stdout: string; stderr: string }) {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const runner: CommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      const result = reply(command, args);
      if (result.stderr) options.onStderr?.(result.stderr);
      return result;
    },
  };
  return { runner, calls };
}

const launchJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ url: 'http://127.0.0.1:3000', port: 3000, mode: 'local', pid: 4321, started: true, ...over });

describe('launchArgs / stopArgs', () => {
  it('계약대로 studio launch/stop --json을 부른다', () => {
    expect(launchArgs({ mode: 'local' })).toEqual(['studio', 'launch', '--json', '--mode', 'local']);
    expect(launchArgs({ mode: 'demo', port: 3100 })).toEqual(['studio', 'launch', '--json', '--mode', 'demo', '--port', '3100']);
    expect(stopArgs()).toEqual(['studio', 'stop', '--json']);
  });

  it('기동 로그 폴더는 ~/.cache/b-studio/launch다', () => {
    expect(launchLogDir('/Users/kim')).toBe('/Users/kim/.cache/b-studio/launch');
  });
});

describe('parseLaunchResult', () => {
  it('stdout 마지막 줄의 JSON을 읽는다', () => {
    expect(parseLaunchResult(`${launchJson()}\n`)).toEqual({ url: 'http://127.0.0.1:3000', port: 3000, mode: 'local', pid: 4321, started: true });
  });

  it('앞에 다른 출력이 있어도 마지막 JSON 줄을 쓴다', () => {
    const stdout = `컨테이너를 만드는 중\n${JSON.stringify({ url: 'http://127.0.0.1:3100', port: 3100 })}\n`;
    expect(parseLaunchResult(stdout)).toEqual({ url: 'http://127.0.0.1:3100', port: 3100, mode: '', pid: 0, started: false });
  });

  it('started가 없으면 false로 본다(앱이 켜지 않은 서버를 끄지 않게)', () => {
    expect(parseLaunchResult(JSON.stringify({ url: 'http://127.0.0.1:3000', port: 3000, started: 'yes' })).started).toBe(false);
    expect(parseLaunchResult(launchJson({ started: false })).started).toBe(false);
  });

  it('url·port가 없거나 JSON이 없으면 이유를 담아 던진다', () => {
    expect(() => parseLaunchResult('준비 완료')).toThrow(/준비 결과를 읽지 못했습니다/);
    expect(() => parseLaunchResult('')).toThrow(/\(출력 없음\)/);
    expect(() => parseLaunchResult(JSON.stringify({ port: 3000 }))).toThrow(/url·port가 없습니다/);
    expect(() => parseLaunchResult(JSON.stringify({ url: 'not-a-url', port: 3000 }))).toThrow(/url·port가 없습니다/);
  });
});

describe('parseStopResult', () => {
  it('stopped 불 값을 읽는다', () => {
    expect(parseStopResult('{"stopped":true}')).toEqual({ stopped: true });
    expect(parseStopResult('{"stopped":false}')).toEqual({ stopped: false });
  });

  it('형식이 다르면 던진다', () => {
    expect(() => parseStopResult('{"stopped":"yes"}')).toThrow(/중지 결과를 읽지 못했습니다/);
    expect(() => parseStopResult('')).toThrow(/중지 결과를 읽지 못했습니다/);
  });
});

describe('launchStudio', () => {
  it('저장소 루트에서 pnpm studio launch를 부르고 결과를 돌려준다', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: launchJson(), stderr: 'dockerd 확인 중\n' }));

    const result = await launchStudio(config, runner);

    expect(calls).toEqual([{ command: '/nvm/v22/bin/pnpm', args: ['studio', 'launch', '--json', '--mode', 'local'], cwd: '/repo/b-studio' }]);
    expect(result).toMatchObject({ url: 'http://127.0.0.1:3000', started: true });
  });

  it('진행 안내(stderr)를 그대로 흘려보낸다', async () => {
    const seen: string[] = [];
    const { runner } = fakeRunner(() => ({ code: 0, stdout: launchJson(), stderr: '콜리마를 켜는 중' }));

    await launchStudio(config, runner, { onProgress: (text) => seen.push(text) });

    expect(seen).toEqual(['콜리마를 켜는 중']);
  });

  it('실패하면 종료 코드와 마지막 stderr 줄을 알린다', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'Docker를 쓸 수 없습니다\n포트가 이미 쓰이고 있습니다' }));
    await expect(launchStudio(config, runner)).rejects.toThrow(/종료 코드 1\): 포트가 이미 쓰이고 있습니다/);
  });

  it('종료 코드가 0이어도 결과가 없으면 던진다', async () => {
    const { runner } = fakeRunner(() => ({ code: 0, stdout: '준비 완료', stderr: '' }));
    await expect(launchStudio(config, runner)).rejects.toThrow(/준비 결과를 읽지 못했습니다/);
  });
});

describe('stopStudio / stopIfStarted', () => {
  it('앱이 켠 서버(started=true)만 끈다', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: '{"stopped":true}', stderr: '' }));

    const outcome = await stopIfStarted({ url: 'http://127.0.0.1:3000', port: 3000, mode: 'local', pid: 1, started: true }, config, runner);

    expect(outcome).toEqual({ attempted: true, stopped: true });
    expect(calls).toEqual([{ command: '/nvm/v22/bin/pnpm', args: ['studio', 'stop', '--json'], cwd: '/repo/b-studio' }]);
  });

  it('이미 떠 있던 서버(started=false)는 건드리지 않는다', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: '{"stopped":true}', stderr: '' }));

    expect(await stopIfStarted({ url: 'http://127.0.0.1:3000', port: 3000, mode: 'local', pid: 1, started: false }, config, runner)).toEqual({ attempted: false });
    expect(await stopIfStarted(undefined, config, runner)).toEqual({ attempted: false });
    expect(calls).toEqual([]);
  });

  it('끄지 못해도 앱을 막지 않고 이유만 돌려준다', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stdout: '', stderr: '데몬에 연결하지 못했습니다' }));

    const outcome = await stopIfStarted({ url: 'http://127.0.0.1:3000', port: 3000, mode: 'local', pid: 1, started: true }, config, runner);

    expect(outcome.attempted).toBe(true);
    expect(outcome.stopped).toBeUndefined();
    expect(outcome.error).toContain('종료 코드 1');
    expect(outcome.error).toContain('데몬에 연결하지 못했습니다');
  });

  it('stopStudio는 결과 JSON을 읽는다', async () => {
    const { runner } = fakeRunner(() => ({ code: 0, stdout: '{"stopped":false}', stderr: '' }));
    expect(await stopStudio(config, runner)).toEqual({ stopped: false });
  });
});
