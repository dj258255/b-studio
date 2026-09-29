import { styleText } from 'node:util';
import { describeSnapshotEvent, providerFromEnv, resolveSecrets, type BootNetwork, type Sandbox, type ServiceEndpoint } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { createLabeler, describe, once, pipeLogs, print, printEndpoints, reportStatus, type Label } from './ui';

export interface SessionContext {
  sandbox: Sandbox;
  endpoints: ServiceEndpoint[];
  /** Ctrl+C 등으로 중단되면 abort된다 */
  signal: AbortSignal;
  label: Label;
  /** `sandbox.start`가 서비스를 준비시키기까지 걸린 시간(ms) */
  bootMs: number;
  /** 서비스가 준비된 직후 읽은 기동 네트워크(edge 제외). 못 읽었으면 빈 배열 */
  bootNetwork: BootNetwork;
}

export interface SessionOptions {
  /** 끝나거나 실패해도 컨테이너를 남긴다 (디버깅용) */
  keep: boolean;
  /** 서비스 로그를 계속 출력할지 */
  followLogs: boolean;
  /**
   * true면 진행 안내를 stdout에 쓰지 않는다(boot-probe의 `--json`). 실패 이유와 정리 실패는 stderr로만 낸다.
   * 기본은 false라 지금 동작과 같다
   */
  quiet?: boolean;
}

/**
 * 샌드박스를 띄우고 본문을 실행한 뒤 정리한다. `up`·`agent`·`boot-probe`가 같은 수명 주기를 공유한다.
 * 반환값은 프로세스 종료 코드다.
 */
export async function runSandboxSession(
  project: LoadedProject,
  { keep, followLogs, quiet = false }: SessionOptions,
  body: (context: SessionContext) => Promise<number>,
): Promise<number> {
  const sandbox = await providerFromEnv().create(project, { secrets: await resolveSecrets(project) });
  const label = createLabeler(project);
  const stop = new AbortController();
  /** quiet면 stdout을 건드리지 않는다 */
  const note = (target: string, text: string) => {
    if (!quiet) print(label(target), text);
  };

  const cleanup = once(async () => {
    stop.abort();
    note('studio', `샌드박스를 정리합니다 (${sandbox.id})`);
    await sandbox.destroy().catch((error: unknown) => {
      // 정리 실패는 quiet여도 알린다. 다만 stdout을 더럽히지 않도록 stderr로 낸다
      if (quiet) console.error(`정리 실패: ${describe(error)}`);
      else print(label('studio'), `정리 실패: ${describe(error)}`);
    });
  });
  const leave = () => {
    stop.abort();
    note('studio', `컨테이너를 남겨 둡니다. 정리: docker compose -p ${sandbox.id} down -v`);
  };

  // 터미널의 Ctrl+C는 pnpm, tsx, node에 동시에 전달돼 신호가 여러 번 올 수 있다.
  // once로 등록하면 두 번째 신호에서 기본 동작(즉시 종료)이 실행돼 정리가 중간에 끊긴다
  const onSignal = () => void cleanup();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // 컨테이너가 생긴 뒤에야 logs --follow가 붙을 수 있다
  const startLogs = once(async () => {
    if (followLogs) await pipeLogs(sandbox, stop.signal, label);
  });

  note('studio', `${project.spec.name} 샌드박스를 시작합니다 (${sandbox.id})`);
  if (project.secrets.length > 0) {
    const injected = project.secrets.map(([name, secret]) => `${name} → ${secret.services.join(', ')}`).join(', ');
    note('studio', `시크릿을 넣고 출력에서 가립니다: ${injected}`);
  }
  let code: number;
  let bootNetwork: BootNetwork = [];
  try {
    const bootStarted = performance.now();
    const endpoints = await sandbox.start({
      signal: stop.signal,
      onStatus: quiet ? undefined : reportStatus(label, () => void startLogs()),
      onSnapshot: quiet ? undefined : (event) => print(label(event.service), styleText('dim', describeSnapshotEvent(event))),
      onBootNetwork: (network) => {
        bootNetwork = network;
      },
    });
    const bootMs = Math.round(performance.now() - bootStarted);
    if (!quiet) printEndpoints(project, endpoints);
    code = await body({ sandbox, endpoints, signal: stop.signal, label, bootMs, bootNetwork });
  } catch (error) {
    if (stop.signal.aborted) {
      await cleanup();
      return 130;
    }
    const reason = `실패: ${describe(error)}`;
    if (quiet) console.error(reason);
    else print(label('studio'), styleText('red', reason));
    code = 1;
  }

  if (keep && !stop.signal.aborted) leave();
  else await cleanup();
  return code;
}
