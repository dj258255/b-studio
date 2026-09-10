import type { LoadedProject } from '@b-studio/spec';
import type { ContainerState, LogLine } from '../types';

/**
 * 사용자의 compose 파일은 건드리지 않고 덧씌울 설정.
 * 포트는 호스트 루프백의 빈 포트에만 공개해서 같은 네트워크의 다른 PC에서 접근하지 못하게 한다.
 */
export function buildOverride(project: LoadedProject, sandboxId: string) {
  return {
    services: Object.fromEntries(
      project.managed.map(([name, service]) => [
        name,
        {
          ports: [`127.0.0.1::${service.port}`],
          labels: { 'b-studio.sandbox': sandboxId, 'b-studio.service': name },
        },
      ]),
    ),
  };
}

/** `docker compose port <service> <port>` 출력에서 호스트 포트를 읽는다 */
export function parseHostPort(stdout: string): number {
  const match = stdout.trim().split('\n').at(-1)?.match(/:(\d+)$/);
  const port = match ? Number(match[1]) : 0;
  if (!port) throw new Error(`공개된 호스트 포트를 찾을 수 없습니다: ${JSON.stringify(stdout)}`);
  return port;
}

const CONTAINER_STATES: ReadonlySet<string> = new Set<ContainerState>([
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
]);

/** `docker compose ps --format json` 출력은 버전에 따라 줄 단위 JSON 또는 배열이다 */
export function parseContainerState(stdout: string): ContainerState {
  const text = stdout.trim();
  if (!text) return 'unknown';

  const rows: unknown[] = text.startsWith('[') ? JSON.parse(text) : text.split('\n').map((line) => JSON.parse(line));
  const state = (rows[0] as { State?: unknown } | undefined)?.State;
  return typeof state === 'string' && CONTAINER_STATES.has(state) ? (state as ContainerState) : 'unknown';
}

/**
 * 동기화 확인 스크립트 출력: 파일마다 `<sha256|MISSING|UNREADABLE> <경로>` 한 줄.
 * 경로에 공백이 있을 수 있으므로 첫 공백에서만 나눈다
 */
export function parseSyncOutput(stdout: string): Map<string, string> {
  const seen = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) seen.set(line.slice(space + 1), line.slice(0, space));
  }
  return seen;
}

const LOG_LINE =/^(?<container>\S+)-\d+\s+\|\s(?<timestamp>\d{4}-\d{2}-\d{2}T\S+)\s?(?<text>.*)$/;

/** `docker compose logs --timestamps` 한 줄: `api-1  | 2026-09-10T11:48:35.123456789Z 메시지` */
export function parseLogLine(raw: string): LogLine {
  const groups = LOG_LINE.exec(raw)?.groups;
  if (!groups?.container || !groups.timestamp) return { service: 'unknown', text: raw, at: new Date() };

  return {
    service: groups.container,
    text: groups.text ?? '',
    // 나노초 정밀도는 Date가 다루지 못하므로 밀리초까지만 남긴다
    at: new Date(groups.timestamp.replace(/(\.\d{3})\d+/, '$1')),
  };
}
