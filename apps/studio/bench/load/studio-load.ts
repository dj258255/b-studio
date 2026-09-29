/**
 * 스튜디오 부하 스모크. 실제 샌드박스(Docker)를 띄우지 않고 모델도 부르지 않는다.
 *
 * 가짜 샌드박스 제공자(sandbox-shim.ts → fake-provider.ts)로 세션 N개를 만들고, 세션마다 실제 SSE 라우트
 * (`app/api/sessions/[id]/events/route`)로 이벤트 연결을 열어 둔다. 각 세션의 가짜 로그 스트림이 초당 rate개의
 * 이벤트를 흘려보내면, 그 이벤트가 세션 이벤트 버스를 거쳐 SSE 구독자에게 도착하는 지연을 잰다.
 *
 * 잰다: 세션 생성 지연, SSE 첫 이벤트까지 지연, 이벤트 전달 지연(p50·p95), 프로세스 RSS(시작·최고), 떨어진 이벤트 수
 * 출력: 표 한 장, 그리고 --out을 주면 JSON 한 파일
 *
 *   pnpm bench:studio-load [--sessions 5] [--rate 50] [--duration 5] [--out ./studio-load.json]
 *
 * 기준선(이 PC·이 커밋에서의 값)은 메인 세션이 실행해 문서에 남긴다. 이 스크립트는 값을 만들 뿐 판정하지 않는다.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StudioEvent } from '../../lib/studio-events';
import { fakeSandboxStats, resetFakeSandboxStats } from './fake-provider';
import { countDropped, formatMs, renderTable, summarize, type LatencySummary } from './metrics';

const EVENT_MARKER = 'bench-log ';

interface Args {
  sessions: number;
  rate: number;
  durationSeconds: number;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sessions: 5, rate: 50, durationSeconds: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${arg} 뒤에 값이 필요합니다`);
      index += 1;
      return next;
    };
    if (arg === '--sessions') args.sessions = positiveInt(value(), '--sessions');
    else if (arg === '--rate') args.rate = positiveInt(value(), '--rate');
    else if (arg === '--duration') args.durationSeconds = positiveInt(value(), '--duration');
    else if (arg === '--out') args.out = value();
    else if (arg.startsWith('--sessions=')) args.sessions = positiveInt(arg.slice('--sessions='.length), '--sessions');
    else if (arg.startsWith('--rate=')) args.rate = positiveInt(arg.slice('--rate='.length), '--rate');
    else if (arg.startsWith('--duration=')) args.durationSeconds = positiveInt(arg.slice('--duration='.length), '--duration');
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else throw new Error(`알 수 없는 인자입니다: ${arg}`);
  }
  return args;
}

function positiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag}는 1 이상의 정수여야 합니다 (지금 값: ${value})`);
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'studio-load-'));
  const projects = path.join(root, 'projects');
  const opened: Array<() => void> = [];
  let sessionIds: string[] = [];

  try {
    // Docker·모델을 쓰지 않도록 환경을 세운다. 프로젝트는 임시 폴더로 복사해 세션 작업 복사본이 저장소 밖에 생기게 한다
    await cp(path.resolve(import.meta.dirname, '../../../../examples/orders'), path.join(projects, 'orders'), {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(source),
    });
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    Object.assign(process.env, {
      B_STUDIO_MODE: 'api',
      B_STUDIO_AUTH: 'none',
      B_STUDIO_PROJECTS_DIR: projects,
      B_STUDIO_SESSIONS_DIR: path.join(root, 'sessions'),
      B_STUDIO_BENCH_RATE: String(args.rate),
    });
    resetFakeSandboxStats();

    const sessions = await import('../../lib/server/sessions');
    const { LOCAL_USER } = await import('../../lib/server/auth');
    const eventsRoute = await import('../../app/api/sessions/[id]/events/route');

    const creationMs: number[] = [];
    const firstEventMs: number[] = [];
    const deliveryMs: number[] = [];
    let received = 0;

    const rssStart = rssMb();
    let rssPeak = rssStart;
    const sampler = setInterval(() => {
      rssPeak = Math.max(rssPeak, rssMb());
    }, 100);
    sampler.unref();

    // 세션은 하나씩 만들어 생성 지연을 깨끗하게 재고, 만든 직후 SSE를 열어 둔 채로 둔다
    for (let index = 0; index < args.sessions; index += 1) {
      const startedAt = performance.now();
      const snapshot = await sessions.createSession('orders', LOCAL_USER, 'copy', {});
      creationMs.push(performance.now() - startedAt);
      sessionIds.push(snapshot.id);

      const openedAt = Date.now();
      let first = true;
      opened.push(
        await openSse(eventsRoute, snapshot.id, (event, receivedAt) => {
          if (first) {
            first = false;
            firstEventMs.push(receivedAt - openedAt);
          }
          if (event.type === 'log' && event.text.startsWith(EVENT_MARKER)) {
            received += 1;
            deliveryMs.push(receivedAt - Date.parse(event.at));
          }
        }),
      );
    }

    await Promise.all(sessionIds.map((id) => waitForReady(() => sessions.getSnapshot(id)?.status, id)));

    await delay(args.durationSeconds * 1_000);
    clearInterval(sampler);
    rssPeak = Math.max(rssPeak, rssMb());

    const produced = fakeSandboxStats.producedEvents;
    const report = {
      sessions: args.sessions,
      ratePerSession: args.rate,
      durationSeconds: args.durationSeconds,
      creation: summarize(creationMs),
      firstEvent: summarize(firstEventMs),
      delivery: summarize(deliveryMs),
      rssStartMb: rssStart,
      rssPeakMb: rssPeak,
      produced,
      received,
      dropped: countDropped(produced, received),
    };

    printReport(report);
    if (args.out) {
      const file = path.resolve(args.out);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\nJSON: ${file}`);
    }
  } finally {
    for (const close of opened) close();
    const { stopSession } = await import('../../lib/server/sessions').catch(() => ({ stopSession: async () => {} }));
    for (const id of sessionIds) await stopSession(id).catch(() => {});
    sessionIds = [];
    await rm(root, { recursive: true, force: true });
  }
}

type EventsRoute = typeof import('../../app/api/sessions/[id]/events/route');

/** 실제 SSE 라우트로 연결을 열고, data: 줄을 이벤트로 풀어 onEvent로 넘긴다. 돌려준 함수로 연결을 닫는다 */
async function openSse(route: EventsRoute, id: string, onEvent: (event: StudioEvent, receivedAt: number) => void): Promise<() => void> {
  const controller = new AbortController();
  const request = new Request(`http://bench.local/api/sessions/${encodeURIComponent(id)}/events`, { signal: controller.signal });
  const response = await route.GET(request, { params: Promise.resolve({ id }) } as never);
  if (!response.ok || !response.body) throw new Error(`SSE 연결에 실패했습니다: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) {
            const receivedAt = Date.now();
            try {
              onEvent(JSON.parse(data.slice('data: '.length)) as StudioEvent, receivedAt);
            } catch {
              // 이해할 수 없는 프레임은 세지 않는다
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // 연결을 닫으면 여기로 온다
    }
  })();
  return () => controller.abort();
}

async function waitForReady(status: () => string | undefined, id: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const current = status();
    if (current === 'ready') return;
    if (current === 'failed' || current === 'stopped') throw new Error(`세션 ${id}이 준비되지 못했습니다 (${current})`);
    if (Date.now() - started > 60_000) throw new Error(`세션 ${id}이 60초 안에 준비되지 않았습니다`);
    await delay(20);
  }
}

interface Report {
  sessions: number;
  ratePerSession: number;
  durationSeconds: number;
  creation: LatencySummary;
  firstEvent: LatencySummary;
  delivery: LatencySummary;
  rssStartMb: number;
  rssPeakMb: number;
  produced: number;
  received: number;
  dropped: number;
}

function printReport(report: Report): void {
  console.log(
    renderTable(
      ['항목', 'p50', 'p95', '최대', '평균', '표본'],
      [
        ['세션 생성', formatMs(report.creation.p50Ms), formatMs(report.creation.p95Ms), formatMs(report.creation.maxMs), formatMs(report.creation.meanMs), String(report.creation.count)],
        ['SSE 첫 이벤트', formatMs(report.firstEvent.p50Ms), formatMs(report.firstEvent.p95Ms), formatMs(report.firstEvent.maxMs), formatMs(report.firstEvent.meanMs), String(report.firstEvent.count)],
        ['이벤트 전달', formatMs(report.delivery.p50Ms), formatMs(report.delivery.p95Ms), formatMs(report.delivery.maxMs), formatMs(report.delivery.meanMs), String(report.delivery.count)],
      ],
    ),
  );
  console.log(`\n세션 ${report.sessions}개 · 세션당 초당 ${report.ratePerSession}개 · ${report.durationSeconds}초`);
  console.log(`RSS 시작 ${report.rssStartMb.toFixed(1)}MiB · 최고 ${report.rssPeakMb.toFixed(1)}MiB`);
  console.log(`이벤트 보냄 ${report.produced} · 받음 ${report.received} · 떨어짐 ${report.dropped}`);
}

function rssMb(): number {
  return process.memoryUsage().rss / (1_024 * 1_024);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
