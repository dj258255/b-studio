import { describe, expect, it } from 'vitest';
import { applyRuntimeEvent, logColor, openRuntime, renderRuntime, runtimeHint, runtimeKey, runtimePaste, type RuntimeEffect, type RuntimeState } from './runtime';
import { stringWidth, stripAnsi } from './screen';
import { DEFAULT_THEME } from './theme';
import type { DeskDeployStatus, DeskRepoList, DeskSessionView } from './types';

const ESC = '\x1b';
const DOWN = '\x1b[B';
const UP = '\x1b[A';
const theme = DEFAULT_THEME;

const view = (patch: Partial<DeskSessionView> = {}): DeskSessionView => ({
  id: 's1',
  projectId: 'p1',
  status: 'ready',
  services: [
    { name: 'web', template: 'nextjs', preview: 'browser', state: 'ready', url: 'http://127.0.0.1:41001' },
    { name: 'api', template: 'spring-boot', preview: 'openapi', state: 'failed', detail: '8080 포트가 열리지 않았습니다' },
  ],
  usage: { at: '2026-10-23T05:00:00Z', services: [{ service: 'web', state: 'running', cpuPercent: 42, memoryBytes: 300 * 1024 * 1024, memoryLimitBytes: 1024 * 1024 * 1024 }] },
  checkpoints: [{ sha: 'abc1234def', shortSha: 'abc1234', message: '주문 모듈 나누기', createdAt: '2026-10-23T04:00:00Z' }],
  hasDeploy: true,
  experimental: true,
  ...patch,
});

/** 열고 스냅샷을 받은 상태 */
function ready(patch: Partial<DeskSessionView> = {}): RuntimeState {
  return applyRuntimeEvent(openRuntime('s1', '주문 모듈'), { type: 'snapshot', snapshot: view(patch) });
}

/** 키를 차례로 누른다. 닫히면 undefined */
function press(start: RuntimeState, ...keys: string[]): { state: RuntimeState | undefined; effects: RuntimeEffect[] } {
  let state: RuntimeState | undefined = start;
  const effects: RuntimeEffect[] = [];
  for (const key of keys) {
    if (!state) break;
    const result = runtimeKey(state, key);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

function text(state: RuntimeState, cols = 100, rows = 24): string {
  return renderRuntime(state, { w: cols, h: rows }, theme, Date.parse('2026-10-23T05:00:10Z'))
    .lines.map((line) => stripAnsi(line))
    .join('\n');
}

describe('세션 이벤트 접기', () => {
  it('열자마자는 연결하는 중이고, 스냅샷을 받으면 서비스와 자원이 보인다', () => {
    const opened = openRuntime('s1', '주문 모듈');
    expect(opened.tab).toBe('services');
    expect(text(opened)).toContain('연결하는 중');
    const shown = text(ready());
    expect(shown).toContain('주문 모듈');
    expect(shown).toContain('web');
    expect(shown).toContain('준비됨');
    expect(shown).toContain('api');
    expect(shown).toContain('실패');
    expect(shown).toContain('8080 포트가 열리지 않았습니다');
    expect(shown).toContain('CPU');
    expect(shown).toContain('300MB / 1.0GB');
  });

  it('서비스가 멈추면 주소를 지우고, 다시 뜨면 새 주소를 쓴다', () => {
    let state = applyRuntimeEvent(ready(), { type: 'service', service: 'web', state: 'stopped' });
    expect(state.snapshot?.services[0]?.url).toBeUndefined();
    state = applyRuntimeEvent(state, { type: 'service', service: 'web', state: 'ready', url: 'http://127.0.0.1:41002' });
    expect(state.snapshot?.services[0]).toMatchObject({ state: 'ready', url: 'http://127.0.0.1:41002' });
  });

  it('로그를 쌓되 1000줄까지만 두고, 스냅샷을 다시 받으면(다시 연결) 처음부터 받는다', () => {
    let state = ready();
    for (let at = 0; at < 1005; at++) state = applyRuntimeEvent(state, { type: 'log', service: 'web', text: `줄 ${at}`, at: '2026-10-23T05:00:00Z' });
    expect(state.logs).toHaveLength(1000);
    expect(state.logs[0]?.text).toBe('줄 5');
    state = applyRuntimeEvent(state, { type: 'snapshot', snapshot: view() });
    expect(state.logs).toHaveLength(0);
  });

  it('배포 진행 줄과 끝을 접는다. 끝나면 결과 한 줄을 남긴다', () => {
    let state = applyRuntimeEvent(ready(), { type: 'deploy_started', action: 'deploy', target: 'abc1234', at: '2026-10-23T05:00:00Z' });
    state = applyRuntimeEvent(state, { type: 'deploy_log', line: '이미지 빌드 중' });
    expect(state.snapshot?.deploying?.lines).toEqual(['이미지 빌드 중']);
    state = applyRuntimeEvent(state, { type: 'deploy_finished', action: 'deploy', release: 'r2', label: '주문 모듈 나누기', urls: { web: 'http://127.0.0.1:9000' } });
    expect(state.snapshot?.deploying).toBeUndefined();
    expect(state.deploy.result).toContain('배포했습니다');
    state = applyRuntimeEvent(state, { type: 'deploy_failed', action: 'rollback', target: 'r1', error: '이미지가 없습니다' });
    expect(state.deploy.result).toContain('이미지가 없습니다');
  });

  it('모르는 이벤트는 그대로 둔다', () => {
    const state = ready();
    expect(applyRuntimeEvent(state, { type: 'agent' })).toBe(state);
  });
});

describe('탭과 닫기', () => {
  it('Tab과 숫자로 탭을 옮기고, Esc로 닫는다', () => {
    expect(press(ready(), '\t').state?.tab).toBe('logs');
    expect(press(ready(), '\x1b[Z').state?.tab).toBe('qa');
    expect(press(ready(), '4').state?.tab).toBe('preview');
    const closed = press(ready(), ESC);
    expect(closed.state).toBeUndefined();
    expect(closed.effects).toEqual([{ type: 'close' }]);
  });

  it('배포·저장소·미리보기 탭은 처음 들어갈 때 한 번 불러온다', () => {
    const deploy = press(ready(), '3');
    expect(deploy.effects).toEqual([{ type: 'load-deploys' }]);
    const loaded = { ...deploy.state!, deploy: { ...deploy.state!.deploy, status: { state: { releases: [] }, urls: {}, containers: [] } } };
    expect(press(press(loaded, '1').state!, '3').effects).toEqual([]);
    expect(press(ready(), '5').effects).toEqual([{ type: 'load-repo', view: 'presubmit', state: 'open' }]);
    // 미리보기는 준비된 브라우저 서비스의 주소를 받는다
    expect(press(ready(), '4').effects).toEqual([{ type: 'preview', service: 'web', open: false }]);
  });
});

describe('실행 탭', () => {
  it('켜진 서비스를 끄려면 묻고, 꺼 둔 서비스는 바로 켠다', () => {
    const asked = press(ready(), '\r');
    expect(asked.effects).toEqual([]);
    expect(asked.state?.confirm).toMatchObject({ kind: 'service', service: 'web', on: false });
    expect(runtimeHint(asked.state!)).toContain('web');
    expect(press(asked.state!, 'y').effects).toEqual([{ type: 'service', service: 'web', on: false }]);
    expect(press(asked.state!, 'n').effects).toEqual([]);
    const off = ready({ services: [{ name: 'web', template: 'nextjs', preview: 'browser', state: 'off' }] });
    expect(press(off, '\r').effects).toEqual([{ type: 'service', service: 'web', on: true }]);
  });

  it('잠든 세션은 b로 켜고, l은 고른 서비스의 로그로 간다', () => {
    expect(press(ready({ status: 'dormant' }), 'b').effects).toEqual([{ type: 'boot' }]);
    expect(press(ready(), 'b').state?.note).toContain('이미');
    const logs = press(ready(), DOWN, 'l').state!;
    expect(logs.tab).toBe('logs');
    expect(logs.logService).toBe('api');
  });

  it('샌드박스에 닿지 않으면 경고한다', () => {
    expect(text(ready({ sandboxLink: { state: 'unreachable', since: '2026-10-23T05:00:00Z', reason: 'docker 데몬이 답하지 않습니다' } }))).toContain('docker 데몬이 답하지 않습니다');
  });
});

describe('로그 탭', () => {
  const withLogs = (): RuntimeState => {
    let state = ready();
    const lines = [
      ['web', 'ready on 3000'],
      ['api', 'ERROR Connection refused'],
      ['web', 'WARN slow request'],
      ['api', 'Started Application'],
    ] as const;
    for (const [service, line] of lines) state = applyRuntimeEvent(state, { type: 'log', service, text: line, at: '2026-10-23T05:00:01Z' });
    return press(state, '2').state!;
  };

  it('최근 줄을 서비스 이름과 함께 보인다', () => {
    const shown = text(withLogs());
    expect(shown).toContain('web');
    expect(shown).toContain('ERROR Connection refused');
    expect(shown).toContain('Started Application');
  });

  it('/로 찾으면 맞는 줄만, s로 서비스를 고르면 그 서비스만 보인다', () => {
    const found = press(withLogs(), '/', 'e', 'r', 'r', '\r').state!;
    expect(found.search).toEqual({ text: 'err', editing: false });
    let shown = text(found);
    expect(shown).toContain('ERROR Connection refused');
    expect(shown).not.toContain('Started Application');
    shown = text(press(withLogs(), 's').state!);
    expect(shown).toContain('ready on 3000');
    expect(shown).not.toContain('ERROR Connection refused');
    expect(press(withLogs(), 's', 's').state?.logService).toBe('api');
    expect(press(withLogs(), 's', 's', 's').state?.logService).toBeUndefined();
  });

  it('찾는 글은 붙여 넣을 수도 있고, Esc는 찾기만 지운다', () => {
    const typing = press(withLogs(), '/').state!;
    expect(runtimePaste(typing, 'refused').search?.text).toBe('refused');
    const cleared = press(withLogs(), '/', 'x', ESC);
    expect(cleared.state?.search).toBeUndefined();
    expect(cleared.effects).toEqual([]);
  });

  it('위로 올리면 따라가기를 멈추고 G로 다시 따라간다', () => {
    const up = press(withLogs(), UP).state!;
    expect(up.scroll).toBe(1);
    expect(press(up, 'G').state?.scroll).toBe(0);
  });

  it('줄 색: 오류는 빨강, 경고는 노랑', () => {
    expect(logColor('ERROR boom')).toBe('red');
    expect(logColor('Exception in thread')).toBe('red');
    expect(logColor('WARN slow')).toBe('yellow');
    expect(logColor('ready')).toBeUndefined();
  });
});

describe('배포 탭', () => {
  const status: DeskDeployStatus = {
    state: {
      active: 'r2',
      releases: [
        { id: 'r2', createdAt: '2026-10-23T04:00:00Z', source: { label: '주문 모듈 나누기' }, status: 'active' },
        { id: 'r1', createdAt: '2026-10-22T04:00:00Z', source: { label: '첫 배포' }, status: 'previous' },
      ],
    },
    urls: { web: 'http://127.0.0.1:9000' },
    containers: [{ name: 'web', state: 'running' }],
  };
  const deployTab = (patch: Partial<DeskSessionView> = {}): RuntimeState => {
    const opened = press(ready(patch), '3').state!;
    return { ...opened, deploy: { ...opened.deploy, status } };
  };

  it('운영 주소를 누를 수 있는 링크로, 릴리스를 상태와 함께 보인다', () => {
    const lines = renderRuntime(deployTab(), { w: 100, h: 24 }, theme).lines.join('\n');
    expect(lines).toContain('\x1b]8;;http://127.0.0.1:9000\x07');
    const shown = text(deployTab());
    expect(shown).toContain('지금 운영');
    expect(shown).toContain('첫 배포');
  });

  it('d는 최신 체크포인트를 묻고 배포한다. b는 고른 이전 릴리스로 되돌린다', () => {
    const asked = press(deployTab(), 'd');
    expect(asked.state?.confirm).toMatchObject({ kind: 'deploy', sha: 'abc1234def' });
    expect(runtimeHint(asked.state!)).toContain('abc1234');
    expect(press(asked.state!, 'y').effects).toEqual([{ type: 'deploy', sha: 'abc1234def' }]);
    expect(press(deployTab(), 'b').state?.note).toContain('이전');
    const back = press(deployTab(), DOWN, 'b');
    expect(back.state?.confirm).toMatchObject({ kind: 'rollback', releaseId: 'r1' });
    expect(press(back.state!, 'y').effects).toEqual([{ type: 'rollback', releaseId: 'r1' }]);
  });

  it('배포 절이 없거나 실험 기능이 꺼졌으면 배포하지 않고 까닭을 보인다', () => {
    const none = press(deployTab({ hasDeploy: false }), 'd');
    expect(none.effects).toEqual([]);
    expect(text(none.state!)).toContain('deploy 절이 없습니다');
    expect(press(deployTab({ experimental: false }), 'd').state?.note).toContain('B_STUDIO_EXPERIMENTAL');
  });

  it('배포가 도는 중이면 진행 줄을 보이고 새 배포를 막는다', () => {
    const running = applyRuntimeEvent(applyRuntimeEvent(deployTab(), { type: 'deploy_started', action: 'deploy', target: 'abc1234', at: '2026-10-23T05:00:00Z' }), { type: 'deploy_log', line: '이미지 빌드 중' });
    expect(text(running)).toContain('이미지 빌드 중');
    expect(press(running, 'd').state?.note).toContain('도는 중');
  });
});

describe('미리보기 탭', () => {
  it('받은 앱 주소를 링크로 보이고, Enter나 o로 브라우저에서 연다', () => {
    const opened = press(ready(), '4').state!;
    const withUrl = { ...opened, previews: { web: { url: 'http://127.0.0.1:52000/' } } };
    expect(renderRuntime(withUrl, { w: 100, h: 24 }, theme).lines.join('\n')).toContain('\x1b]8;;http://127.0.0.1:52000/\x07');
    expect(press(withUrl, '\r').effects).toEqual([{ type: 'open-url', url: 'http://127.0.0.1:52000/' }]);
    expect(press(opened, 'o').effects).toEqual([{ type: 'preview', service: 'web', open: true }]);
    // 브라우저가 있어야 하는 화면은 안내만 한다
    expect(text(withUrl)).toContain('원격 브라우저');
  });

  it('준비된 브라우저 서비스가 없으면 그렇다고 알린다', () => {
    const none = press(ready({ services: [{ name: 'api', template: 'spring-boot', preview: 'openapi', state: 'ready', url: 'http://127.0.0.1:41003' }] }), '4');
    expect(none.effects).toEqual([]);
    expect(text(none.state!)).toContain('미리 볼 화면이 없습니다');
  });
});

describe('저장소 탭', () => {
  const issues: DeskRepoList = {
    ok: true,
    remote: { kind: 'github', display: 'me/shop' },
    issues: [{ number: 12, title: '주문 취소가 안 됩니다', author: 'me', labels: ['bug'], updatedAt: '2026-10-22T00:00:00Z', url: 'https://github.com/me/shop/issues/12', state: 'open' }],
  };

  it('점검·이슈·PR을 i p c로 오가고, 처음 볼 때 불러온다', () => {
    const repo = press(ready(), '5').state!;
    expect(press(repo, 'i').effects).toEqual([{ type: 'load-repo', view: 'issues', state: 'open' }]);
    expect(press(repo, 'p').effects).toEqual([{ type: 'load-repo', view: 'pulls', state: 'open' }]);
    const loaded = { ...press(repo, 'i').state!, repo: { ...repo.repo, view: 'issues' as const, issues } };
    expect(press(loaded, 'x').effects).toEqual([{ type: 'load-repo', view: 'issues', state: 'closed' }]);
    expect(text(loaded)).toContain('#12 주문 취소가 안 됩니다');
    expect(press(loaded, '\r').effects).toEqual([{ type: 'open-url', url: 'https://github.com/me/shop/issues/12' }]);
  });

  it('점검 결과를 표시와 함께, 토큰이 없으면 까닭을 보인다', () => {
    const repo = press(ready(), '5').state!;
    const checked = {
      ...repo,
      repo: {
        ...repo.repo,
        submission: {
          items: [
            { id: 'tests', title: '테스트', status: 'pass' as const, reason: '통과한 기록이 있습니다' },
            { id: 'readme', title: 'README', status: 'warn' as const, reason: '실행 방법이 없습니다' },
          ],
          score: { passed: 1, total: 2 },
        },
      },
    };
    const shown = text(checked);
    expect(shown).toContain('1/2');
    expect(shown).toContain('✓ 테스트');
    expect(shown).toContain('실행 방법이 없습니다');
    const noToken = { ...repo, repo: { ...repo.repo, view: 'pulls' as const, pulls: { ok: false, reason: 'no_token' as const } } };
    expect(text(noToken)).toContain('gh auth login');
  });
});

describe('그리기', () => {
  it('모든 줄이 받은 폭과 높이에 맞는다', () => {
    for (const keys of [[], ['2'], ['3'], ['4'], ['5']]) {
      const state = press(ready(), ...keys).state!;
      const { lines } = renderRuntime(state, { w: 72, h: 20 }, theme);
      expect(lines).toHaveLength(20);
      for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(72);
    }
  });
});

describe('탐색형 QA 탭(#916)', () => {
  const running = {
    id: 'q1',
    service: 'web',
    goal: { goal: '상품 목록에서 상세로 간다', startPath: '/products' },
    status: 'running' as const,
    actions: [
      { index: 1, tool: 'qa_navigate', ok: true, newDiagnosticsCount: 0, url: 'http://x/products', at: 1 },
      { index: 2, tool: 'qa_click', ok: false, detail: '버튼을 찾지 못함', newDiagnosticsCount: 1, artifact: 'q1/2.jpg', url: 'http://x/products', at: 2 },
    ],
    findings: [{ severity: 'major' as const, summary: '상세 버튼이 눌리지 않는다', where: '상품 카드' }],
    texts: ['목록을 열었습니다'],
    startedAt: Date.parse('2026-10-23T05:00:00Z'),
  };
  const done = {
    ...running,
    status: 'done' as const,
    finishedAt: Date.parse('2026-10-23T05:01:00Z'),
    result: {
      status: 'fail' as const,
      reason: 'major 문제 1건',
      stoppedBy: 'finish',
      diagnostics: { consoleErrors: ['TypeError'], pageErrors: [], failedRequests: ['GET /api/x 500'], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] },
    },
  };

  /** QA 탭(여섯째)으로 간 상태 */
  function qaTab(patch: Partial<NonNullable<RuntimeState['qa']>> = {}): RuntimeState {
    const entered = press(ready(), '6');
    expect(entered.effects).toEqual([{ type: 'qa-load' }]);
    return { ...entered.state!, qa: { ...entered.state!.qa, loading: false, ...patch } };
  }

  it('처음 들어가면 마지막 실행을 받고, 돌린 적이 없으면 시작하는 법을 보인다', () => {
    const state = qaTab({ run: null });
    expect(state.tab).toBe('qa');
    expect(text(state)).toContain('n으로 시작');
  });

  it('n으로 목표·시작 경로·확인 문구를 쓰고 ←→로 서비스를 고른 뒤 Enter로 시작한다. 목표가 비면 시작하지 않는다', () => {
    let state = press(qaTab({ run: null }), 'n').state!;
    expect(state.qa?.form).toMatchObject({ field: 'goal', startPath: '/', service: 0 });
    const empty = press(state, '\r', '\r', '\r');
    expect(empty.effects).toEqual([]);
    state = qaTab({ run: null });
    const typed = press(state, 'n', ...Array.from('상세로 간다'), '\r', '\x7f', ...Array.from('/products'), '\r', ...Array.from('주문 완료'), '\r');
    expect(typed.effects).toEqual([{ type: 'qa-start', input: { service: 'web', goal: '상세로 간다', startPath: '/products', confirmText: '주문 완료' } }]);
    expect(typed.state!.qa?.form).toBeUndefined();
    expect(typed.state!.qa?.starting).toBe(true);
  });

  it('폼에서 Esc는 폼만 닫고, 친 글자(q·v 포함)는 화면을 닫지 않고 칸에 들어간다', () => {
    const state = press(qaTab({ run: null }), 'n', 'q', 'v').state!;
    expect(state.qa?.form?.goal).toBe('qv');
    const closed = press(state, ESC);
    expect(closed.state).toBeDefined();
    expect(closed.state!.qa?.form).toBeUndefined();
  });

  it('화면이 있는 서비스가 없으면 시작할 수 없다고 알린다', () => {
    const base = applyRuntimeEvent(openRuntime('s1', '주문'), { type: 'snapshot', snapshot: view({ services: [{ name: 'api', template: 'spring-boot', preview: 'openapi', state: 'ready' }] }) });
    const state = { ...press(base, '6').state!, qa: { run: null } };
    expect(press(state, 'n').state!.note).toContain('화면이 있는 서비스');
  });

  it('도는 실행은 동작·발견을 보이고 x로 멈춘다. 도는 동안 n은 받지 않는다', () => {
    const state = qaTab({ run: running });
    const screen = text(state, 120, 30);
    expect(screen).toContain('도는 중');
    expect(screen).toContain('qa_click');
    expect(screen).toContain('버튼을 찾지 못함');
    expect(screen).toContain('상세 버튼이 눌리지 않는다');
    expect(press(state, 'x').effects).toEqual([{ type: 'qa-stop' }]);
    expect(press(state, 'n').state!.note).toContain('도는 중');
  });

  it('끝난 실행은 판정·까닭·진단 신호를 보이고, s로 묻고 y면 화면 확인으로 저장한다', () => {
    const state = qaTab({ run: done });
    const screen = text(state, 120, 30);
    expect(screen).toContain('문제 발견');
    expect(screen).toContain('major 문제 1건');
    expect(screen).toContain('콘솔 오류 1');
    expect(screen).toContain('실패한 요청 1');
    const asked = press(state, 's');
    expect(asked.effects).toEqual([]);
    expect(asked.state!.confirm).toEqual({ kind: 'qa-save', service: 'web' });
    expect(press(asked.state!, 'y').effects).toEqual([{ type: 'qa-save', service: 'web' }]);
  });

  it('↑↓로 동작을 고르고 Enter면 그 동작의 화면 사진을 연다. 사진이 없으면 알린다', () => {
    const state = qaTab({ run: done });
    const second = press(state, DOWN);
    expect(press(second.state!, '\r').effects).toEqual([{ type: 'qa-artifact', artifact: 'q1/2.jpg' }]);
    expect(press(state, '\r').state!.note).toContain('사진이 없습니다');
    expect(press(second.state!, UP).state!.row).toBe(0);
  });

  it('아래 줄 안내에 QA 키가 있다', () => {
    expect(runtimeHint(qaTab({ run: done }))).toContain('n 새 QA');
  });
});
