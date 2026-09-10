/**
 * 샌드박스 기동 단계별 시간을 잰다. 추측으로 최적화하지 않고 어디서 시간이 드는지 먼저 본다.
 *
 *   pnpm bench:boot [프로젝트 경로=examples/orders] [반복 횟수=1]
 *
 * - 준비 판정 시각은 호스트 시계 기준이다.
 * - 로그 속 단계 시각은 컨테이너 로그 타임스탬프 기준이라 VM 시계 차이만큼 어긋날 수 있다.
 */
import { loadProject } from '@b-studio/spec';
import { describeSnapshotEvent, LocalDockerProvider } from '../src/index';
import type { LogLine, ServiceStatusEvent, SnapshotEvent } from '../src/types';

/** 기동 단계를 알려 주는 로그. 템플릿마다 도구 출력이 달라 넓게 잡는다 */
const MILESTONES = [
  /Lockfile is up to date|Already up to date|Packages: [+-]|Progress: resolved|Done in [\d.]+m?s/,
  /Ready in [\d.]+m?s|GET \/ \d{3} in/,
  /Starting a Gradle Daemon|Reusing configuration cache|Configuration cache entry stored|> Task :compileJava|> Task :bootRun|BUILD (SUCCESSFUL|FAILED)|Started \w+ in [\d.]+ seconds/,
  /Resolved \d+ packages|Installed \d+ packages|Uvicorn running|Application startup complete/,
];

interface Timeline {
  starting?: number;
  firstProbe?: number;
  ready?: number;
  failed?: string;
}

async function run(dir: string, index: number): Promise<number> {
  const project = await loadProject(dir);
  const sandbox = await new LocalDockerProvider().create(project);
  const timelines = new Map<string, Timeline>(project.managed.map(([name]) => [name, {}]));
  const startedAt = Date.now();
  const elapsed = (at: number) => `${((at - startedAt) / 1_000).toFixed(1)}s`;

  const record = (event: ServiceStatusEvent) => {
    const timeline = timelines.get(event.service)!;
    const now = Date.now();
    if (event.phase === 'starting') timeline.starting ??= now;
    if (event.phase === 'probing') timeline.firstProbe ??= now;
    if (event.phase === 'ready') timeline.ready = now;
    if (event.phase === 'failed') timeline.failed = event.reason;
  };

  const snapshots: string[] = [];
  const recordSnapshot = (event: SnapshotEvent) =>
    snapshots.push(`  ${event.service.padEnd(6)} ${elapsed(Date.now()).padStart(6)}  ${describeSnapshotEvent(event)}`);

  try {
    await sandbox.start({ onStatus: record, onSnapshot: recordSnapshot });
    const total = Date.now() - startedAt;

    const lines: LogLine[] = [];
    for await (const line of sandbox.logs({ follow: false, tail: 3_000 })) lines.push(line);

    console.log(`\n[${index}] ${project.spec.name} 준비 완료: ${elapsed(startedAt + total)} (샌드박스 ${sandbox.id})`);
    for (const line of snapshots) console.log(line);
    for (const [name, timeline] of timelines) {
      const firstLog = lines.find((line) => line.service === name);
      console.log(
        `  ${name.padEnd(6)} compose up 완료(첫 준비 확인) ${timeline.firstProbe ? elapsed(timeline.firstProbe) : '-'}` +
          `, 첫 로그 ${firstLog ? elapsed(firstLog.at.getTime()) : '-'}, 준비 ${timeline.ready ? elapsed(timeline.ready) : timeline.failed}`,
      );
      for (const line of lines.filter((candidate) => candidate.service === name && MILESTONES.some((pattern) => pattern.test(candidate.text)))) {
        console.log(`         ${elapsed(line.at.getTime()).padStart(6)}  ${line.text.trim().slice(0, 110)}`);
      }
    }
    return total;
  } finally {
    // 정리 실패가 기동 실패 원인을 덮어쓰지 않게 따로 알린다
    await sandbox.destroy().catch((error: unknown) => console.error(`샌드박스 정리 실패 (${sandbox.id}):`, error));
  }
}

const [dir = 'examples/orders', repeat = '1'] = process.argv.slice(2);
const totals: number[] = [];
for (let index = 1; index <= Number(repeat); index++) totals.push(await run(dir, index));
console.log(`\n준비까지 걸린 시간: ${totals.map((ms) => `${(ms / 1_000).toFixed(1)}s`).join(', ')}`);
