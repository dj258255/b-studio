import { styleText } from 'node:util';
import type { Sandbox, ServiceEndpoint, ServiceStatusEvent } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';

const COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue'] as const;

export type Label = (name: string) => string;

export function createLabeler(project: LoadedProject): Label {
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

/** 여러 줄이면 줄마다 라벨을 붙인다 */
export function print(label: string, text: string): void {
  for (const line of text.split('\n')) console.log(`${label} │ ${line}`);
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 여러 번 호출돼도 한 번만 실행하고 같은 Promise를 돌려준다 */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => (result ??= fn());
}

export function reportStatus(label: Label, onContainersUp: () => void) {
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
        lastProbe.delete(event.service);
        print(label(event.service), styleText('green', `준비 완료 → ${event.endpoint.url}`));
        break;
      case 'failed':
        print(label(event.service), styleText('red', event.reason));
        break;
    }
  };
}

export async function pipeLogs(sandbox: Sandbox, signal: AbortSignal, label: Label): Promise<void> {
  try {
    for await (const line of sandbox.logs({ signal, tail: 50 })) print(label(line.service), line.text);
  } catch (error) {
    if (!signal.aborted) print(label('studio'), `로그 구독이 끊겼습니다: ${describe(error)}`);
  }
}

export function printEndpoints(project: LoadedProject, endpoints: ServiceEndpoint[]): void {
  console.log();
  for (const endpoint of endpoints) {
    const service = project.managed.find(([name]) => name === endpoint.service)?.[1];
    const contract = service?.contract ? `  계약: ${new URL(service.contract.extract, endpoint.url)}` : '';
    console.log(`  ${endpoint.service.padEnd(12)} ${(service?.preview ?? '').padEnd(8)} ${endpoint.url}${contract}`);
  }
  for (const [name, service] of project.external ?? []) {
    console.log(`  ${name.padEnd(12)} ${'사내 API'.padEnd(8)} 샌드박스 안에서 http://${name}/ → ${service.baseUrl} (정책 적용)`);
  }
  console.log();
}
