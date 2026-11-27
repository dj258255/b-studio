import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudioClient } from '../desk/client';
import { connectStudio } from './connect';
import { ctlMain } from './main';
import { EXIT } from './phase';
import { FAKE_TOKEN, FakeStudio } from './fake-studio';

let studio: FakeStudio;

beforeEach(async () => {
  studio = new FakeStudio();
  await studio.start();
});
afterEach(async () => {
  await studio.close();
});

const TIMING = { enterGapMs: 10, confirmPollMs: 40, confirmMs: 500, settleMs: 120, keyGapMs: 5, readSettleMs: 60, watch: { pollMs: 50, retryMs: 20 } };

/** 명령 하나를 돌려 종료 코드와 stdout·stderr 줄을 받는다 */
async function run(args: string[], extra: { env?: Record<string, string>; connectOnly?: boolean; signal?: AbortSignal } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await ctlMain(args, {
    env: extra.env ?? {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    timing: TIMING,
    ...(extra.signal ? { signal: extra.signal } : {}),
    connect: async () => new StudioClient({ origin: `http://127.0.0.1:${studio.port}`, token: FAKE_TOKEN }),
  });
  return { code, out, err };
}

describe('세션 하나를 처음부터 끝까지', () => {
  it('new → wait → read → status → ls → stop', async () => {
    const created = await run(['new', 'p1', '로그인 만들어 줘']);
    expect(created.code).toBe(EXIT.ok);
    // stdout에는 id 한 줄만(스크립트가 $(...)로 받는다)
    expect(created.out).toHaveLength(1);
    const id = created.out[0]!;
    expect(studio.startBodies[0]).toMatchObject({ projectId: 'p1', route: 'rules', request: '로그인 만들어 줘', terminal: true });

    const waited = await run(['wait', id, '--for', 'idle', '--timeout', '10', '--json']);
    expect(waited.code).toBe(EXIT.ok);
    expect(JSON.parse(waited.out[0]!)).toMatchObject({ ok: true, code: 0, session: id, phase: 'idle', gate: 'passed' });

    const text = await run(['read', id]);
    expect(text.code).toBe(EXIT.ok);
    expect(text.out.join('\n')).toContain('로그인 만들어 줘');
    expect(text.out.join('\n')).toContain('작업을 마쳤습니다');
    expect(text.out.join('\n')).not.toContain('\x1b');

    const tail = await run(['read', id, '--lines', '1', '--json']);
    expect(JSON.parse(tail.out[0]!)).toMatchObject({ session: id, cols: 80, rows: 10, lines: ['작업을 마쳤습니다'] });

    const st = await run(['status', id, '--json']);
    const parsed = JSON.parse(st.out[0]!);
    expect(parsed).toMatchObject({ id, phase: 'idle', gate: 'passed', gateDetail: { state: 'passed', checkpoints: 1 } });
    expect(parsed.checkpoints[0]).toMatchObject({ shortSha: 'abc1234', message: '로그인 추가', files: ['src/a.ts'] });
    expect(parsed.changedFiles).toEqual([{ file: 'src/b.ts', change: 'modified', added: 3, removed: 1 }]);
    expect(parsed.needsAttention).toEqual([]);
    expect((await run(['status', id])).out.join('\n')).toContain('바뀐 파일 1개');

    const listed = await run(['ls', '--json']);
    expect(JSON.parse(listed.out[0]!)).toEqual([expect.objectContaining({ id, project: 'demo', phase: 'idle', gate: 'passed' })]);
    expect((await run(['ls', '--project', 'p1'])).out[0]).toContain(id);
    expect((await run(['ls', '--project', 'other'])).out).toEqual([]);

    const stopped = await run(['stop', '--session', id.slice(0, 3)]);
    expect(stopped.code).toBe(EXIT.ok);
    expect(studio.calls).toContain('DELETE /api/sessions/' + id);
    expect((await run(['wait', id, '--for', 'done', '--timeout', '5'])).code).toBe(EXIT.ok);
  });

  it('new: --backend·--account·--model은 직접 고름으로 보내고, 규칙일 때는 보내지 않는다', async () => {
    const direct = await run(['new', 'demo', '일', '--backend', 'codex', '--account', 'work', '--model', 'gpt-x']);
    expect(direct.code).toBe(EXIT.ok);
    expect(studio.startBodies[0]).toMatchObject({ route: 'direct', backend: 'codex', accountId: 'work', model: 'gpt-x' });
    const bad = await run(['new', 'p1', '일', '--model', 'x']);
    expect(bad.code).toBe(EXIT.usage);
    expect(studio.startBodies).toHaveLength(1);
  });

  it('new: 없는 프로젝트는 8', async () => {
    const result = await run(['new', 'nope', '일']);
    expect(result.code).toBe(EXIT.notFound);
    expect(result.err.join('\n')).toContain('찾을 수 없습니다');
    expect(studio.startBodies).toHaveLength(0);
  });
});

describe('send: Enter 확인', () => {
  it('글을 붙여넣기 표지로 보내고 Enter를 따로 보낸다. 받으면 0', async () => {
    const session = studio.addSession();
    const result = await run(['send', session.item.id, '테스트도 추가해 줘', '--json']);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.out[0]!)).toEqual({ ok: true, session: session.item.id, confirmed: true, retried: false });
    expect(session.inputs).toEqual(['\x1b[200~테스트도 추가해 줘\x1b[201~', '\r']);
    expect(session.requests).toEqual(['테스트도 추가해 줘']);
  });

  it('Enter가 먹지 않으면 한 번 더 보내고, 그래서 받으면 0', async () => {
    studio.options.dropEnters = 1;
    const session = studio.addSession();
    const result = await run(['send', session.item.id, '다시 해 줘', '--json']);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.out[0]!)).toMatchObject({ confirmed: true, retried: true });
    expect(session.inputs.filter((entry) => entry === '\r')).toHaveLength(2);
    expect(session.requests).toEqual(['다시 해 줘']);
  });

  it('두 번 다 먹지 않으면 9와 화면 끝 줄', async () => {
    studio.options.dropEnters = 2;
    const session = studio.addSession();
    const result = await run(['send', session.item.id, '안 들어가는 글']);
    expect(result.code).toBe(EXIT.unconfirmed);
    expect(result.err.join('\n')).toContain('확인');
    expect(result.err.join('\n')).toContain('[입력줄] 안 들어가는 글');
    expect(session.requests).toEqual([]);
    // Enter는 최초 한 번과 재시도 한 번뿐이다
    expect(session.inputs.filter((entry) => entry === '\r')).toHaveLength(2);
  });

  it('글 안의 붙여넣기 표지와 ESC는 지워서 보낸다(붙여넣기를 일찍 끝내거나 키가 되지 못하게)', async () => {
    const session = studio.addSession();
    await run(['send', session.item.id, 'a\x1b[201~b\x1b[Dc']);
    expect(session.inputs[0]).toBe('\x1b[200~ab[Dc\x1b[201~');
  });

  it('권한·질문·입력 창, CLI 없음, 끝난 세션에는 보내지 않는다(아무것도 입력하지 않는다)', async () => {
    const permission = studio.addSession({ state: 'working', terminal: { cli: 'up', waiting: 'permission' } });
    const question = studio.addSession({ state: 'working', terminal: { cli: 'up', waiting: 'question' } });
    const noCli = studio.addSession({ terminal: { cli: 'down' } });
    const done = studio.addSession({ state: 'stopped' });
    expect((await run(['send', permission.item.id, '네'])).code).toBe(EXIT.permission);
    expect((await run(['send', question.item.id, '네'])).code).toBe(EXIT.input);
    expect((await run(['send', noCli.item.id, '네'])).code).toBe(EXIT.failed);
    expect((await run(['send', done.item.id, '네'])).code).toBe(EXIT.ended);
    for (const session of [permission, question, noCli, done]) expect(session.inputs).toEqual([]);
  });

  it('빈 글은 2, 없는 세션은 8', async () => {
    const session = studio.addSession();
    expect((await run(['send', session.item.id, '  '])).code).toBe(EXIT.usage);
    expect((await run(['send', 'zzz', '글'])).code).toBe(EXIT.notFound);
  });
});

describe('read', () => {
  it('--raw는 서식 제어 문자를 남긴 지금 화면, 기본은 서식 없는 글', async () => {
    const session = studio.addSession({}, '\x1b[31m빨간 글\x1b[0m\r\n둘째 줄\r\n');
    const raw = await run(['read', session.item.id, '--raw']);
    expect(raw.out[0]).toContain('\x1b[');
    expect(raw.out.join('\n')).toContain('빨간 글');
    const plain = await run(['read', session.item.id]);
    expect(plain.out).toEqual(['빨간 글', '둘째 줄']);
  });

  it('지난 줄까지 합쳐 마지막 N줄을 준다(화면 10줄을 넘는 출력)', async () => {
    const many = Array.from({ length: 25 }, (_, index) => `줄 ${index + 1}`).join('\r\n') + '\r\n';
    const session = studio.addSession({}, many);
    expect((await run(['read', session.item.id, '--lines', '3'])).out).toEqual(['줄 23', '줄 24', '줄 25']);
    // 기본은 지금 화면만(10줄 안)
    expect((await run(['read', session.item.id])).out.length).toBeLessThanOrEqual(10);
  });

  it('터미널이 닫혔으면 서버가 알린 까닭과 함께 1', async () => {
    const session = studio.addSession();
    session.closed = '이 세션은 만든 사람만 쓸 수 있습니다';
    const result = await run(['read', session.item.id]);
    expect(result.code).toBe(EXIT.failed);
    expect(result.err.join('\n')).toContain('만든 사람만');
  });
});

describe('keys', () => {
  it('권한 창에 키로 답한다: 숫자·Enter·Esc', async () => {
    const session = studio.addSession({ state: 'working', terminal: { cli: 'up', waiting: 'permission' } });
    const result = await run(['keys', session.item.id, '1', 'Enter']);
    expect(result.code).toBe(EXIT.ok);
    expect(session.inputs).toEqual(['1', '\r']);
    // 답했으니 권한 대기가 풀렸다
    expect((await run(['wait', session.item.id, '--for', 'idle', '--timeout', '5'])).code).toBe(EXIT.ok);
  });

  it('모르는 키 이름은 아무것도 보내지 않고 2', async () => {
    const session = studio.addSession();
    const result = await run(['keys', session.item.id, 'Down', 'Entr']);
    expect(result.code).toBe(EXIT.usage);
    expect(session.inputs).toEqual([]);
  });

  it('CLI가 없으면 셸에 들어가지 않게 보내지 않는다', async () => {
    const session = studio.addSession({ terminal: { cli: 'down' } });
    expect((await run(['keys', session.item.id, 'Enter'])).code).toBe(EXIT.failed);
    expect(session.inputs).toEqual([]);
  });
});

describe('wait', () => {
  it('시간 안에 조건이 안 되면 3', async () => {
    const session = studio.addSession({ state: 'working', workingSince: new Date().toISOString() });
    const result = await run(['wait', session.item.id, '--for', 'idle', '--timeout', '1', '--json']);
    expect(result.code).toBe(EXIT.timeout);
    expect(JSON.parse(result.out[0]!)).toMatchObject({ ok: false, code: 3, phase: 'working' });
  });

  it('권한 대기가 되면 바로 4', async () => {
    const session = studio.addSession({ state: 'working' });
    setTimeout(() => studio.touch(session.item.id, { terminal: { cli: 'up', waiting: 'permission', message: 'Bash 실행' } }), 80);
    const result = await run(['wait', session.item.id, '--timeout', '5']);
    expect(result.code).toBe(EXIT.permission);
  });

  it('작업이 끝나도 게이트가 실패면 1, gate를 기다렸다면 같다', async () => {
    studio.options.gateResult = 'failed';
    const created = await run(['new', 'p1', '일']);
    const id = created.out[0]!;
    const result = await run(['wait', id, '--for', 'gate', '--timeout', '10', '--json']);
    expect(result.code).toBe(EXIT.failed);
    expect(JSON.parse(result.out[0]!).reason).toContain('테스트 2개 실패');
  });

  it('검증 중인 사이에는 쉬는 것으로 치지 않는다: idle은 게이트가 끝난 뒤에 나온다', async () => {
    studio.options.gateMs = 400;
    const created = await run(['new', 'p1', '일']);
    const started = Date.now();
    const result = await run(['wait', created.out[0]!, '--for', 'idle', '--timeout', '10', '--json']);
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.out[0]!).gate).toBe('passed');
    // 작업(150ms) + 게이트(400ms)를 지나서야 끝난다
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it('쉬는 상태가 잠깐 스치기만 하면 확정하지 않는다(다음 작업이 막 시작하는 사이)', async () => {
    const session = studio.addSession({ gate: { state: 'passed', checkpoints: 1 } });
    const started = Date.now();
    setTimeout(() => studio.touch(session.item.id, { state: 'working', workingSince: new Date().toISOString() }), 50);
    setTimeout(() => studio.touch(session.item.id, { state: 'idle' }), 450);
    const result = await run(['wait', session.item.id, '--for', 'idle', '--timeout', '10']);
    expect(result.code).toBe(EXIT.ok);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });

  it('게이트 판정이 없는 요청에서 gate를 기다리면 10(통과로 치지 않는다)', async () => {
    studio.options.gateResult = 'none';
    const created = await run(['new', 'p1', '질문만 할게']);
    const result = await run(['wait', created.out[0]!, '--for', 'gate', '--timeout', '10']);
    expect(result.code).toBe(EXIT.noVerdict);
  });

  it('잘못된 --for·--timeout은 스튜디오에 붙기 전에 2', async () => {
    expect((await run(['wait', 's', '--for', 'soon'])).code).toBe(EXIT.usage);
    expect((await run(['wait', 's', '--timeout', '-1'])).code).toBe(EXIT.usage);
    expect(studio.calls).toEqual([]);
  });
});

describe('events', () => {
  it('처음에 지금 세션을 알리고, 그 뒤 상태 변화를 한 줄 JSON으로 낸다', async () => {
    const session = studio.addSession();
    const controller = new AbortController();
    const lines: string[] = [];
    const running = ctlMain(['events', '--json'], { env: {}, out: (line) => lines.push(line), err: () => {}, timing: TIMING, signal: controller.signal, connect: async () => new StudioClient({ origin: `http://127.0.0.1:${studio.port}`, token: FAKE_TOKEN }) });
    await new Promise((resolve) => setTimeout(resolve, 150));
    studio.touch(session.item.id, { state: 'working' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    studio.touch(session.item.id, { gate: { state: 'passed', checkpoints: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    expect(await running).toBe(EXIT.ok);
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed[0]).toMatchObject({ type: 'snapshot', session: session.item.id, phase: 'idle' });
    expect(parsed).toContainEqual(expect.objectContaining({ type: 'phase', prevPhase: 'idle', phase: 'working' }));
    expect(parsed).toContainEqual(expect.objectContaining({ type: 'gate', prevGate: 'none', gate: 'passed' }));
  });
});

describe('붙기와 인증', () => {
  it('스튜디오가 안 떠 있으면 7', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await ctlMain(['ls'], {
      env: {},
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      connect: async () => new StudioClient({ origin: 'http://127.0.0.1:1', token: 'x' }),
    });
    expect(code).toBe(EXIT.unreachable);
    expect(err.join('\n')).toContain('스튜디오에 붙지 못했습니다');
  });

  it('로컬 토큰이 맞지 않으면 서버의 거절 이유를 보이고 1', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await ctlMain(['ls'], { env: {}, out: (line) => out.push(line), err: (line) => err.push(line), connect: async () => new StudioClient({ origin: `http://127.0.0.1:${studio.port}`, token: 'wrong' }) });
    expect(code).toBe(EXIT.failed);
    expect(err.join('\n')).toContain('launch');
  });

  it('--json이면 오류도 한 줄 JSON', async () => {
    const out: string[] = [];
    const code = await ctlMain(['status', 'nope', '--json'], { env: {}, out: (line) => out.push(line), err: () => {}, connect: async () => new StudioClient({ origin: `http://127.0.0.1:${studio.port}`, token: FAKE_TOKEN }) });
    expect(code).toBe(EXIT.notFound);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, code: 8 });
  });

  it('인증을 켠 서버: 이름과 토큰으로 로그인해 받은 쿠키로 요청한다', async () => {
    studio.options.requireCookie = 'b_studio_session=signed.value';
    studio.addSession();
    const client = await connectStudio({ B_STUDIO_URL: `http://127.0.0.1:${studio.port}`, B_STUDIO_USER: 'beomsu', B_STUDIO_TOKEN: 'secret-token' }, {});
    expect((await client.agents()).items).toHaveLength(1);
    expect(studio.calls[0]).toBe('POST /api/auth/login');
  });

  it('인증을 켠 서버: 토큰이 틀리면 7, 이름·토큰이 없으면 2', async () => {
    const url = `http://127.0.0.1:${studio.port}`;
    await expect(connectStudio({ B_STUDIO_URL: url, B_STUDIO_USER: 'beomsu', B_STUDIO_TOKEN: 'wrong' }, {})).rejects.toMatchObject({ code: EXIT.unreachable });
    await expect(connectStudio({ B_STUDIO_URL: url }, {})).rejects.toMatchObject({ code: EXIT.usage });
    await expect(connectStudio({}, { url: 'ftp://x' })).rejects.toMatchObject({ code: EXIT.usage });
    await expect(connectStudio({}, { url: 'http://x/api?a=1' })).rejects.toMatchObject({ code: EXIT.usage });
  });
});

describe('사용법', () => {
  it('stop은 --session 없이는 이 진입점이 아니다(스튜디오 끄기와 겹치지 않는다)', async () => {
    expect((await run(['stop'])).code).toBe(EXIT.usage);
    expect((await run(['stop', '--session', ''])).code).toBe(EXIT.usage);
    expect(studio.calls).toEqual([]);
  });

  it('인자 개수가 틀리면 2', async () => {
    expect((await run(['send', 's'])).code).toBe(EXIT.usage);
    expect((await run(['keys', 's'])).code).toBe(EXIT.usage);
    expect((await run(['new', 'p1'])).code).toBe(EXIT.usage);
    expect((await run(['ls', 'extra'])).code).toBe(EXIT.usage);
    expect((await run(['wait'])).code).toBe(EXIT.usage);
  });
});
