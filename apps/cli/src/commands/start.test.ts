import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchOptions, ProbeResult } from './launch';
import { runStudio, STUDIO_SERVER_ENV, waitingLine, type StudioDeps } from './start';

afterEach(() => {
  vi.restoreAllMocks();
});

interface Harness {
  deps: StudioDeps;
  launches: LaunchOptions[];
  desks: Array<{ port: number; notify?: boolean; mouse?: boolean }>;
  writes: string[];
}

function harness(options: { launchCode?: number; health?: ProbeResult; deskCode?: number; tty?: boolean; waits?: number[] } = {}): Harness {
  const launches: LaunchOptions[] = [];
  const desks: Harness['desks'] = [];
  const writes: string[] = [];
  const deps: StudioDeps = {
    launch: async (launchOptions) => {
      launches.push(launchOptions);
      for (const ms of options.waits ?? []) launchOptions.onWaiting?.(ms);
      return options.launchCode ?? 0;
    },
    probe: async () => options.health ?? { reachable: true, status: 200, body: '{"status":"ok","app":"b-studio","terminal":true}' },
    desk: async (deskOptions) => {
      desks.push(deskOptions);
      return options.deskCode ?? 0;
    },
    progress: { isTTY: options.tty ?? false, write: (text) => writes.push(text) },
  };
  return { deps, launches, desks, writes };
}

describe('pnpm studio(인자 없이): 서버는 화면 없이 뒤에서, 바로 desk', () => {
  it('브라우저를 열지 않고 띄운 뒤(이미 떠 있으면 launch가 재사용) 같은 포트로 desk를 연다', async () => {
    const h = harness();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runStudio({ mode: 'local', port: 3100, notify: false }, h.deps)).toBe(0);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).toMatchObject({ mode: 'local', port: 3100, open: false });
    expect(h.launches[0]!.json).toBeUndefined();
    expect(h.desks).toEqual([{ port: 3100, notify: false }]);
    // desk를 나간 뒤 서버가 뒤에 남는다는 것과 끄는 법을 알린다
    const text = log.mock.calls.flat().join('\n');
    expect(text).toContain('뒤에서');
    expect(text).toContain('pnpm studio stop');
  });

  it('세션 터미널을 켜고(실험 기능) Codex도 고를 수 있게 서버 환경을 채운다', async () => {
    const h = harness();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStudio({ mode: 'local', port: 3000 }, h.deps);
    expect(h.launches[0]!.serverEnv).toEqual(STUDIO_SERVER_ENV);
    expect(STUDIO_SERVER_ENV).toEqual({ B_STUDIO_EXPERIMENTAL: '1', B_STUDIO_BACKENDS: 'codex' });
  });

  it('띄우기에 실패하면 desk를 열지 않고 그 종료 코드를 돌려준다', async () => {
    const h = harness({ launchCode: 1 });

    expect(await runStudio({ mode: 'local', port: 3000 }, h.deps)).toBe(1);
    expect(h.desks).toEqual([]);
  });

  it('떠 있던 서버가 세션 터미널을 끈 채로 떠 있으면 desk를 열지 않고 다시 띄우는 법을 알린다', async () => {
    const h = harness({ health: { reachable: true, status: 200, body: '{"status":"ok","app":"b-studio","terminal":false}' } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runStudio({ mode: 'local', port: 3000 }, h.deps)).toBe(1);
    expect(h.desks).toEqual([]);
    const text = error.mock.calls.flat().join('\n');
    expect(text).toContain('세션 터미널');
    expect(text).toContain('pnpm studio stop');
  });

  it('옛 서버(헬스에 terminal이 없음)면 막지 않고 desk를 연다', async () => {
    const h = harness({ health: { reachable: true, status: 200, body: '{"status":"ok"}' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runStudio({ mode: 'local', port: 3000 }, h.deps)).toBe(0);
    expect(h.desks).toHaveLength(1);
  });

  it('desk의 종료 코드를 그대로 돌려준다', async () => {
    const h = harness({ deskCode: 3 });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runStudio({ mode: 'local', port: 3000 }, h.deps)).toBe(3);
  });

  it('터미널이면 기다리는 동안 한 줄 진행 표시를 같은 줄에 고쳐 쓰고, 끝나면 지운다', async () => {
    const h = harness({ tty: true, waits: [0, 1_000, 12_400] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStudio({ mode: 'local', port: 3000 }, h.deps);
    expect(h.writes).toHaveLength(4);
    expect(h.writes[2]).toBe(`\r\x1b[2K${waitingLine(12_400)}`);
    expect(h.writes[3]).toBe('\r\x1b[2K');
  });

  it('터미널이 아니면(파이프·로그) 진행 표시를 쓰지 않는다', async () => {
    const h = harness({ tty: false, waits: [0, 1_000] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStudio({ mode: 'local', port: 3000 }, h.deps);
    expect(h.writes).toEqual([]);
  });

  it('진행 표시는 도는 글자와 지난 초를 보인다', () => {
    expect(waitingLine(0)).toBe('⠋ 스튜디오를 띄우는 중… 0초');
    expect(waitingLine(12_400)).toBe('⠹ 스튜디오를 띄우는 중… 12초');
    expect(waitingLine(1_000)).not.toBe(waitingLine(2_000));
  });
});
