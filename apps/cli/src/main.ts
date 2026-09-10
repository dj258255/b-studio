import { parseArgs, styleText } from 'node:util';
import { LocalDockerProvider, type Sandbox, type ServiceEndpoint, type ServiceStatusEvent } from '@b-studio/sandbox';
import { loadProject, SpecError, type LoadedProject } from '@b-studio/spec';

const USAGE = `사용법: studio up <프로젝트 경로> [--keep]

  --keep   기동에 실패해도 컨테이너를 지우지 않는다 (디버깅용)`;

const COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue'] as const;

type Label = (name: string) => string;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { keep: { type: 'boolean', default: false } },
  });
  const [command, dir] = positionals;
  if (command !== 'up' || !dir) {
    console.error(USAGE);
    return 2;
  }
  return up(dir, { keep: values.keep });
}

async function up(dir: string, { keep }: { keep: boolean }): Promise<number> {
  const project = await loadProject(dir);
  const sandbox = await new LocalDockerProvider().create(project);
  const label = createLabeler(project);
  const stop = new AbortController();

  const cleanup = once(async () => {
    stop.abort();
    print(label('studio'), `샌드박스를 정리합니다 (${sandbox.id})`);
    await sandbox.destroy().catch((error: unknown) => print(label('studio'), `정리 실패: ${describe(error)}`));
  });
  // 터미널의 Ctrl+C는 pnpm, tsx, node에 동시에 전달돼 신호가 여러 번 올 수 있다.
  // once로 등록하면 두 번째 신호에서 기본 동작(즉시 종료)이 실행돼 정리가 중간에 끊긴다
  const onSignal = () => void cleanup();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // 컨테이너가 생긴 뒤에야 logs --follow가 붙을 수 있다
  const followLogs = once(async () => pipeLogs(sandbox, stop.signal, label));

  print(label('studio'), `${project.spec.name} 샌드박스를 시작합니다 (${sandbox.id})`);
  try {
    const endpoints = await sandbox.start({ signal: stop.signal, onStatus: reportStatus(label, followLogs) });
    printEndpoints(project, endpoints);
  } catch (error) {
    if (stop.signal.aborted) {
      await cleanup();
      return 130;
    }
    print(label('studio'), styleText('red', `기동 실패: ${describe(error)}`));
    if (keep) {
      stop.abort();
      print(label('studio'), `컨테이너를 남겨 둡니다. 정리: docker compose -p ${sandbox.id} down -v`);
    } else {
      await cleanup();
    }
    return 1;
  }

  print(label('studio'), 'Ctrl+C로 종료합니다');
  await new Promise<void>((resolve) => stop.signal.addEventListener('abort', () => resolve(), { once: true }));
  await cleanup();
  return 130;
}

function reportStatus(label: Label, onContainersUp: () => void) {
  const lastProbe = new Map<string, string>();

  return (event: ServiceStatusEvent) => {
    switch (event.phase) {
      case 'starting':
        print(label(event.service), '이미지를 빌드하고 시작합니다');
        break;
      case 'probing': {
        onContainersUp();
        const summary = event.probe.error ?? `HTTP ${event.probe.status}`;
        const key = `${summary}/${event.probe.containerState}`;
        // 같은 결과가 반복되면 한 번만 출력한다
        if (lastProbe.get(event.service) !== key) {
          lastProbe.set(event.service, key);
          print(label(event.service), styleText('dim', `준비 확인: ${summary} (컨테이너 ${event.probe.containerState})`));
        }
        break;
      }
      case 'ready':
        onContainersUp();
        print(label(event.service), styleText('green', `준비 완료 → ${event.endpoint.url}`));
        break;
      case 'failed':
        print(label(event.service), styleText('red', event.reason));
        break;
    }
  };
}

async function pipeLogs(sandbox: Sandbox, signal: AbortSignal, label: Label): Promise<void> {
  try {
    for await (const line of sandbox.logs({ signal, tail: 50 })) print(label(line.service), line.text);
  } catch (error) {
    if (!signal.aborted) print(label('studio'), `로그 구독이 끊겼습니다: ${describe(error)}`);
  }
}

function printEndpoints(project: LoadedProject, endpoints: ServiceEndpoint[]): void {
  console.log();
  for (const endpoint of endpoints) {
    const service = project.managed.find(([name]) => name === endpoint.service)?.[1];
    const contract = service?.contract ? `  계약: ${new URL(service.contract.extract, endpoint.url)}` : '';
    console.log(`  ${endpoint.service.padEnd(12)} ${(service?.preview ?? '').padEnd(8)} ${endpoint.url}${contract}`);
  }
  console.log();
}

function createLabeler(project: LoadedProject): Label {
  const width = Math.max('studio'.length, ...project.managed.map(([name]) => name.length));
  const colors = new Map<string, (typeof COLORS)[number]>();
  return (name) => {
    let color = colors.get(name);
    if (!color) {
      color = COLORS[colors.size % COLORS.length]!;
      colors.set(name, color);
    }
    return styleText(color, name.padEnd(width));
  };
}

function print(label: string, text: string): void {
  console.log(`${label} │ ${text}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 여러 번 호출돼도 한 번만 실행하고 같은 Promise를 돌려준다 */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => (result ??= fn());
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof SpecError ? error.message : error);
    process.exitCode = 1;
  },
);
