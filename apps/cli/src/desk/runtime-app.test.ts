/**
 * desk에 붙은 실행 화면(#895): Ctrl-b v로 고른 세션의 이벤트를 받고, 배포·서비스·미리보기·저장소를 스튜디오에 묻는 것을 가짜로 본다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioRequestError } from './client';
import type { StudioClient } from './client';
import { DeskApp, type DeskClient, type DeskIo } from './desk';
import { openFleets } from './fleets';
import { handleInput, initialState } from './keys';
import { stripAnsi } from './screen';
import type { DeskDeployStatus, DeskItem, DeskRepoList, DeskSessionEvent, DeskSessionView, DeskSubmission } from './types';

const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T00:00:00Z', ...patch });

class FakeIo implements DeskIo {
  out: string[] = [];
  #input: (chunk: string) => void = () => {};
  write(data: string) {
    this.out.push(data);
  }
  size() {
    return { cols: 120, rows: 30 };
  }
  onInput(listener: (chunk: string) => void) {
    this.#input = listener;
  }
  onResize() {}
  setRaw() {}
  type(chunk: string) {
    this.#input(chunk);
  }
}

function screenText(io: FakeIo): string {
  const rows: string[] = [];
  for (const chunk of io.out) {
    for (const match of chunk.matchAll(/\x1b\[(\d+);1H([^\x1b]*(?:\x1b(?!\[\d+;1H)[^\x1b]*)*)/g)) rows[Number(match[1]) - 1] = stripAnsi(match[2]!);
  }
  return rows.join('\n');
}

const snapshot: DeskSessionView = {
  id: 'a',
  projectId: 'p1',
  status: 'ready',
  services: [{ name: 'web', template: 'nextjs', preview: 'browser', state: 'ready', url: 'http://127.0.0.1:41001' }],
  checkpoints: [{ sha: 'abc1234def', shortSha: 'abc1234', message: '주문 모듈 나누기', createdAt: '2026-10-23T04:00:00Z' }],
  hasDeploy: true,
  experimental: true,
};

class FakeClient implements DeskClient {
  calls: string[] = [];
  constructor(readonly items: DeskItem[]) {}
  async agents() {
    return { items: this.items };
  }
  async projects() {
    return [{ id: 'p1', name: 'shop' }];
  }
  async accounts() {
    return [];
  }
  async rules() {
    return { rules: { rules: [] }, allowed: ['claude-code'], defaultBackend: 'claude-code' };
  }
  async preview() {
    return { backend: 'claude-code', rule: 'default' as const, matched: '' };
  }
  async start(): Promise<never> {
    throw new Error('쓰지 않는다');
  }
  async open() {}
  async resize() {}
  async input() {}
  async stop() {}
  async resume() {}
  async rename() {}
  stream(_ids: readonly string[], _on: unknown, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
  }
}

/** 실행 화면이 부르는 스튜디오 API의 가짜. 세션 이벤트는 테스트가 emit으로 흘린다 */
class FakeRuntime {
  calls: string[] = [];
  opened: string[] = [];
  emit: (event: DeskSessionEvent) => void = () => {};
  signal: AbortSignal | undefined;
  eventsError: Error | undefined;
  deployStatus: DeskDeployStatus = { state: { active: 'r1', releases: [{ id: 'r1', createdAt: '2026-10-22T00:00:00Z', source: { label: '첫 배포' }, status: 'active' }] }, urls: { web: 'http://127.0.0.1:9000' }, containers: [] };
  /** DeskClient에 더할 실행 화면 메서드(#895) */
  client(): Pick<StudioClient, 'sessionEvents' | 'deploys' | 'deploy' | 'rollback' | 'setService' | 'boot' | 'previewUrl' | 'submission' | 'repository'> {
    return {
        sessionEvents: (id, onEvent, signal) => {
          this.calls.push(`events ${id}`);
          this.signal = signal;
          if (this.eventsError) return Promise.reject(this.eventsError);
          this.emit = onEvent;
          return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
        },
        deploys: async (id) => {
          this.calls.push(`deploys ${id}`);
          return this.deployStatus;
        },
        deploy: async (id, sha) => {
          this.calls.push(`deploy ${id} ${sha}`);
        },
        rollback: async (id, releaseId) => {
          this.calls.push(`rollback ${id} ${releaseId}`);
        },
        setService: async (id, service, on) => {
          this.calls.push(`service ${id} ${service} ${on}`);
        },
        boot: async (id) => {
          this.calls.push(`boot ${id}`);
        },
        previewUrl: async (id, service) => {
          this.calls.push(`preview ${id} ${service.name}`);
          return 'http://127.0.0.1:52000/';
        },
        submission: async (id): Promise<DeskSubmission> => {
          this.calls.push(`submission ${id}`);
          return { items: [{ id: 'tests', title: '테스트', status: 'pass', reason: '통과' }], score: { passed: 1, total: 1 } };
        },
        repository: async (projectId, kind, state): Promise<DeskRepoList> => {
          this.calls.push(`repository ${projectId} ${kind} ${state}`);
          return { ok: true, issues: [{ number: 3, title: '버그', author: 'me', labels: [], updatedAt: '2026-10-22T00:00:00Z', url: 'https://github.com/me/shop/issues/3', state: 'open' }] };
        },
    };
  }
}

function setup(options: { runtime?: boolean } = {}) {
  const client = new FakeClient([item('a'), item('b')]);
  const io = new FakeIo();
  const runtime = new FakeRuntime();
  // 옛 스튜디오(실행 화면 API가 없는 손님)는 그 메서드가 없다
  if (options.runtime !== false) Object.assign(client, runtime.client());
  const app = new DeskApp(client, client.items, io, { openUrl: (url) => runtime.opened.push(url) });
  const done = app.run();
  return { client, io, app, done, runtime };
}

async function tick(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('실행 화면 열고 닫기(#895)', () => {
  it('Ctrl-b v로 고른 세션의 이벤트를 받아 서비스를 보이고, Esc로 닫으면 통로를 끊는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02v');
    await tick();
    expect(ctx.runtime.calls).toEqual(['events a']);
    expect(screenText(ctx.io)).toContain('세션에 연결하는 중');
    ctx.runtime.emit({ type: 'snapshot', snapshot });
    ctx.runtime.emit({ type: 'log', service: 'web', text: 'ERROR boom', at: '2026-10-23T05:00:00Z' });
    await tick();
    let text = screenText(ctx.io);
    expect(text).toContain('실행 · 요청 a');
    expect(text).toContain('준비됨');
    ctx.io.type('2');
    await tick();
    text = screenText(ctx.io);
    expect(text).toContain('ERROR boom');
    // 화면에서 친 글자는 칸으로 가지 않는다
    ctx.io.type('\x1b');
    await tick();
    expect(ctx.app.state.runtime).toBeUndefined();
    expect(ctx.runtime.signal?.aborted).toBe(true);
  });

  it('스페이스 화면에서는 앞글쇠 없이 v로 연다', async () => {
    const ctx = setup();
    // 열린 칸이 없으면 처음부터 스페이스 화면이다
    expect(ctx.app.state.view).toBe('space');
    ctx.io.type('v');
    await tick();
    expect(ctx.app.state.runtime?.id).toBe('a');
  });

  it('열 수 없는 desk면 알리고, 이벤트를 받지 못하면 까닭을 보인다', async () => {
    const none = setup({ runtime: false });
    none.io.type('\x02v');
    await tick();
    expect(none.app.state.runtime).toBeUndefined();
    expect(none.app.state.message).toContain('지원하지 않습니다');

    const ctx = setup();
    ctx.runtime.eventsError = new StudioRequestError('세션을 찾을 수 없습니다', 404);
    ctx.io.type('\x02v');
    await tick();
    expect(screenText(ctx.io)).toContain('세션을 찾을 수 없습니다');
  });
});

describe('실행 화면에서 하는 일(#895)', () => {
  async function opened() {
    const ctx = setup();
    ctx.io.type('\x02v');
    await tick();
    ctx.runtime.emit({ type: 'snapshot', snapshot });
    await tick();
    return ctx;
  }

  it('서비스를 끄려면 묻고 y로 끈다', async () => {
    const ctx = await opened();
    ctx.io.type('\r');
    await tick();
    expect(screenText(ctx.io)).toContain('web를 끌까요');
    ctx.io.type('y');
    await tick();
    expect(ctx.runtime.calls).toContain('service a web false');
  });

  it('미리보기 탭은 주소를 받아 보이고, Enter로 브라우저를 연다', async () => {
    const ctx = await opened();
    ctx.io.type('4');
    await tick();
    expect(ctx.runtime.calls).toContain('preview a web');
    expect(screenText(ctx.io)).toContain('http://127.0.0.1:52000/');
    ctx.io.type('\r');
    await tick();
    expect(ctx.runtime.opened).toEqual(['http://127.0.0.1:52000/']);
  });

  it('배포 탭: 상태를 받고, d·y로 배포하고, 끝나면 상태를 다시 받는다', async () => {
    const ctx = await opened();
    ctx.io.type('3');
    await tick();
    expect(ctx.runtime.calls).toContain('deploys a');
    expect(screenText(ctx.io)).toContain('첫 배포');
    ctx.io.type('d');
    await tick();
    ctx.io.type('y');
    await tick();
    expect(ctx.runtime.calls).toContain('deploy a abc1234def');
    ctx.runtime.emit({ type: 'deploy_started', action: 'deploy', target: 'abc1234', at: '2026-10-23T05:00:00Z' });
    ctx.runtime.emit({ type: 'deploy_finished', action: 'deploy', release: 'r2', label: '주문 모듈 나누기', urls: {} });
    await tick();
    expect(ctx.runtime.calls.filter((call) => call === 'deploys a')).toHaveLength(2);
    expect(screenText(ctx.io)).toContain('배포했습니다');
  });

  it('저장소 탭: 점검을 받고, i로 이슈를 받아 Enter로 연다', async () => {
    const ctx = await opened();
    ctx.io.type('5');
    await tick();
    expect(ctx.runtime.calls).toContain('submission a');
    expect(screenText(ctx.io)).toContain('점검 1/1 통과');
    ctx.io.type('i');
    await tick();
    expect(ctx.runtime.calls).toContain('repository p1 issues open');
    expect(screenText(ctx.io)).toContain('#3 버그');
    ctx.io.type('\r');
    await tick();
    expect(ctx.runtime.opened).toEqual(['https://github.com/me/shop/issues/3']);
  });

  it('http·https가 아닌 주소는 열지 않는다', async () => {
    const ctx = await opened();
    ctx.runtime.deployStatus = { ...ctx.runtime.deployStatus, urls: { web: 'javascript:alert(1)' } };
    ctx.io.type('3');
    await tick();
    ctx.io.type('o');
    await tick();
    expect(ctx.runtime.opened).toEqual([]);
    expect(ctx.app.state.runtime?.note).toContain('열 수 없는 주소');
  });
});

describe('어느 세션의 실행 화면인가(#895)', () => {
  it('칸 화면에서는 고른 칸의 세션, 셸 칸이면 사이드바에서 고른 세션을 연다', () => {
    const base = { ...initialState(), items: [item('a'), item('b')], slots: ['b', 'shell:1', undefined, undefined], layout: 2 as const, selected: 0 };
    const pane = handleInput(base, '\x02v');
    expect(pane.state.runtime?.id).toBe('b');
    expect(pane.effects).toContainEqual({ type: 'runtime-open', id: 'b' });
    expect(handleInput({ ...base, focus: 1 }, '\x02v').state.runtime?.id).toBe('a');
    expect(handleInput({ ...initialState(), items: [] }, '\x02v').state.message).toContain('세션이 없습니다');
  });
});

describe('덮는 화면은 하나만(#895)', () => {
  const base = () => ({ ...initialState(), items: [item('a'), item('b')] });

  it('앞글쇠 다음 v는 열린 비교·작업 나누기를 닫고 열고, 다시 v는 닫는다', () => {
    const fleets = handleInput({ ...base(), fleets: openFleets() }, '\x02v');
    expect(fleets.state.fleets).toBeUndefined();
    expect(fleets.state.runtime?.id).toBe('a');
    expect(fleets.effects).toContainEqual({ type: 'fleets', effect: { type: 'close' } });
    const closed = handleInput(fleets.state, '\x02v');
    expect(closed.state.runtime).toBeUndefined();
    expect(closed.effects).toContainEqual({ type: 'runtime', effect: { type: 'close' } });
  });

  it('화면 안의 글자는 실행 화면이 받고, 앞글쇠 다음 다른 화면 키는 실행 화면을 닫고 그리로 간다', () => {
    const opened = handleInput(base(), '\x02v').state;
    // s는 사이드바 숨기기가 아니라 실행 화면의 키(로그 탭이 아니면 아무 일 없음), d는 배포 탭의 키
    const inside = handleInput(opened, '2s');
    expect(inside.state.runtime?.tab).toBe('logs');
    expect(inside.state.sidebarHidden).toBeUndefined();
    expect(inside.effects.some((effect) => effect.type === 'input')).toBe(false);
    const away = handleInput(opened, '\x02w');
    expect(away.state.runtime).toBeUndefined();
    expect(away.effects).toContainEqual({ type: 'runtime', effect: { type: 'close' } });
    expect(away.state.view).toBe('space');
    const plans = handleInput(opened, '\x02t');
    expect(plans.state.runtime).toBeUndefined();
    expect(plans.state.plans).toBeDefined();
  });
});

describe('실행 화면의 탐색형 QA(#916)', () => {
  /** QA API의 가짜. 시작하면 도는 중이고, polls번 받은 뒤 끝난다 */
  function qaClient(ctx: ReturnType<typeof setup>) {
    const calls: string[] = [];
    let run: import('./types').DeskQaRun | null = null;
    let polls = 0;
    Object.assign(ctx.client, {
      exploreQa: async (id: string) => {
        calls.push(`qa ${id}`);
        if (run?.status === 'running' && ++polls >= 2) {
          run = { ...run, status: 'done', finishedAt: run.startedAt + 30_000, result: { status: 'pass', reason: '문제 없음', stoppedBy: 'finish', diagnostics: { consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] } } };
        }
        return run;
      },
      startExploreQa: async (id: string, input: { service: string; goal: string; startPath: string }) => {
        calls.push(`qa-start ${id} ${input.service} ${input.goal} ${input.startPath}`);
        run = { id: 'q1', service: input.service, goal: { goal: input.goal, startPath: input.startPath }, status: 'running', actions: [{ index: 1, tool: 'qa_screenshot', ok: true, newDiagnosticsCount: 0, artifact: 'q1/1.jpg', url: 'http://x/' }], findings: [], texts: [], startedAt: Date.now() };
        return run;
      },
      stopExploreQa: async (id: string) => {
        calls.push(`qa-stop ${id}`);
      },
      saveExploreQa: async (id: string, service: string) => {
        calls.push(`qa-save ${id} ${service}`);
        return { path: 'studio.yaml', skipped: [] };
      },
      artifactUrl: (id: string, artifact: string) => `http://127.0.0.1:3000/api/sessions/${id}/artifacts/${artifact}`,
    });
    return calls;
  }

  it('6으로 QA 탭에 들어가 n으로 시작하면 도는 동안 다시 받아 끝난 판정을 보이고, s·y로 화면 확인으로 저장한다', async () => {
    const ctx = setup();
    const calls = qaClient(ctx);
    ctx.io.type('\x02v');
    await tick();
    ctx.runtime.emit({ type: 'snapshot', snapshot });
    await tick();
    ctx.io.type('6');
    await tick();
    expect(calls).toEqual(['qa a']);
    expect(screenText(ctx.io)).toContain('n으로 시작');
    ctx.io.type('n상세로 간다\r\r\r');
    await tick();
    expect(calls).toContain('qa-start a web 상세로 간다 /');
    expect(screenText(ctx.io)).toContain('도는 중');
    await tick(1_300);
    await tick(1_300);
    expect(screenText(ctx.io)).toContain('통과');
    const before = calls.length;
    await tick(5_000);
    // 끝나면 더 받지 않는다
    expect(calls.length).toBe(before);
    ctx.io.type('\r');
    await tick();
    expect(ctx.runtime.opened).toEqual(['http://127.0.0.1:3000/api/sessions/a/artifacts/q1/1.jpg']);
    ctx.io.type('s');
    await tick();
    expect(screenText(ctx.io)).toContain('화면 확인');
    ctx.io.type('y');
    await tick();
    expect(calls).toContain('qa-save a web');
    expect(screenText(ctx.io)).toContain('화면 확인으로 저장했습니다');
  });

  it('닫으면 도는 QA를 더 받지 않는다', async () => {
    const ctx = setup();
    const calls = qaClient(ctx);
    ctx.io.type('\x02v');
    await tick();
    ctx.runtime.emit({ type: 'snapshot', snapshot });
    await tick();
    ctx.io.type('6');
    await tick();
    ctx.io.type('n목표\r\r\r');
    await tick();
    ctx.io.type('\x1b');
    await tick();
    const before = calls.length;
    await tick(5_000);
    expect(calls.length).toBe(before);
  });
});
