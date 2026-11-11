import type { ManagedServiceSpec } from '@b-studio/spec';
import { crashLogExcerpt, ReadinessError, shouldRetryTransientCrash, waitForReady, type ReadinessPolicy } from '../readiness';
import type { ContainerState, ExecResult, InfraCheckResult, LogLine, LogOptions, ServiceEndpoint, StartOptions, StrayProcessReport } from '../types';
import { describeDockerFailure } from './compose-provider';
import { egressAuditExcerpt, parseContainerStates } from './format';
import { foreignProcesses, scanProcesses, type ScannedProcess } from './stray-processes';

/**
 * A4c-3a 이전의 `LocalDockerSandbox.#awaitReady`·`#recordProcessBaseline`·`strayProcesses`·`ensureInfra`·`#missingServices`(차등 시험의 기준값).
 * 지금 구현은 Rust(crates/bstudio-io/src/readiness_io.rs)다. 클래스의 비공개 메서드는 컨텍스트 객체로 풀어 받는다. 이 파일은 견주는 시험만 쓴다.
 * 견주는 TS를 지우는 PR(4g)에서 함께 지운다.
 */

const EDGE_SERVICE = 'edge';

export interface LegacyReadyContext {
  managed: (name: string) => ManagedServiceSpec;
  /** 옛 `endpoint()` */
  endpoint: (name: string) => Promise<ServiceEndpoint>;
  /** 옛 `state()` */
  state: (name: string) => Promise<ContainerState>;
  /** 옛 `logs()` */
  logs: (options: LogOptions) => AsyncIterable<LogLine>;
  /** 옛 `#composeOrThrow` */
  composeOrThrow: (args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  policyFor: (service: ManagedServiceSpec) => ReadinessPolicy;
}

export async function awaitReadyLegacy(ctx: LegacyReadyContext, name: string, { signal, onStatus, onTransientRetry }: StartOptions, attempt = 1): Promise<ServiceEndpoint> {
  const service = ctx.managed(name);
  const endpoint = await ctx.endpoint(name);

  if (service.ready) {
    try {
      await waitForReady({
        url: new URL(service.ready.path, endpoint.url).toString(),
        expectStatus: service.ready.expectStatus,
        policy: ctx.policyFor(service),
        getContainerState: () => ctx.state(name),
        signal,
        onProbe: (probe) => onStatus?.({ service: name, phase: 'probing', probe }),
      });
    } catch (error) {
      let reason = error instanceof Error ? error.message : String(error);
      const crashed = error instanceof ReadinessError && ['exited', 'dead'].includes(error.history.at(-1)?.containerState ?? '');
      if (crashed) {
        const lines: string[] = [];
        try {
          for await (const line of ctx.logs({ services: [name], tail: 60, follow: false })) lines.push(line.text);
        } catch {
          // 로그를 못 읽어도 실패 이유는 남긴다
        }
        const excerpt = crashLogExcerpt(lines);

        if (shouldRetryTransientCrash(attempt, excerpt)) {
          onTransientRetry?.({ service: name, reason: excerpt.join(' / ') || reason });
          onStatus?.({ service: name, phase: 'starting' });
          await ctx.composeOrThrow(['up', '--detach', '--build', '--no-deps', '--force-recreate', name], signal);
          return awaitReadyLegacy(ctx, name, { signal, onStatus, onTransientRetry }, attempt + 1);
        }

        if (excerpt.length > 0) reason = `${reason}\n앱 로그 마지막 줄:\n${excerpt.join('\n')}`;

        const egressLines: string[] = [];
        try {
          for await (const line of ctx.logs({ services: [EDGE_SERVICE], tail: 200, follow: false })) egressLines.push(line.text);
        } catch {
          // 로그를 못 읽어도 실패 이유는 남긴다
        }
        const egressExcerpt = egressAuditExcerpt(egressLines);
        if (egressExcerpt.length > 0) reason = `${reason}\negress 최근 기록:\n${egressExcerpt.join('\n')}`;

        if (error instanceof Error) error.message = reason;
      }
      onStatus?.({ service: name, phase: 'failed', reason });
      throw error;
    }
  }

  onStatus?.({ service: name, phase: 'ready', endpoint });
  return endpoint;
}

export interface LegacyStrayContext {
  /** 옛 `exec()`(출력의 시크릿을 가린다) */
  exec: (name: string, command: string[], options?: { signal?: AbortSignal }) => Promise<ExecResult>;
  state: (name: string) => Promise<ContainerState>;
  /** 준비된 서비스의 프로세스 기준선 */
  baseline: Map<string, ScannedProcess[]>;
  /** 옛 `project.offServices`와 managed 이름 */
  managedNames: string[];
  offServices?: ReadonlySet<string>;
}

export async function recordProcessBaselineLegacy(ctx: LegacyStrayContext, name: string): Promise<void> {
  const scanned = await scanProcesses((command) => ctx.exec(name, command)).catch(() => undefined);
  if (scanned?.processes) ctx.baseline.set(name, scanned.processes);
  else ctx.baseline.delete(name);
}

export async function strayProcessesLegacy(ctx: LegacyStrayContext, { signal }: { signal?: AbortSignal } = {}): Promise<StrayProcessReport[]> {
  const names = ctx.managedNames.filter((name) => !ctx.offServices?.has(name));
  const reports = await Promise.all(
    names.map(async (service): Promise<StrayProcessReport | undefined> => {
      if ((await ctx.state(service)) !== 'running') return undefined;
      const scanned = await scanProcesses((command) => ctx.exec(service, command, { signal }));
      if (scanned.error !== undefined) return { service, error: scanned.error };
      const foreign = foreignProcesses(scanned.processes, ctx.baseline.get(service));
      return foreign.length > 0 ? { service, processes: foreign.map(({ pid, command }) => ({ pid, command })) } : undefined;
    }),
  );
  return reports.filter((report): report is StrayProcessReport => report !== undefined);
}

export interface LegacyInfraContext {
  /** 옛 `#compose` */
  compose: (args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  redact: (text: string) => string;
}

async function missingServicesLegacy(ctx: LegacyInfraContext, names: readonly string[], signal?: AbortSignal): Promise<string[]> {
  if (names.length === 0) return [];
  const { stdout } = await ctx.compose(['ps', '--all', '--format', 'json', ...names], signal);
  const states = parseContainerStates(stdout);
  return names.filter((name) => states.get(name) !== 'running');
}

export async function ensureInfraLegacy(ctx: LegacyInfraContext, services: readonly string[], { signal }: { signal?: AbortSignal } = {}): Promise<InfraCheckResult> {
  const expected = [...new Set([EDGE_SERVICE, ...services])].sort();
  const missing = await missingServicesLegacy(ctx, expected, signal);
  if (missing.length === 0) return { ok: true, recovered: [] };

  const result = await ctx.compose(['up', '--detach', '--no-deps', ...missing], signal);
  if (result.exitCode !== 0) {
    return { ok: false, recovered: [], missing, reason: describeDockerFailure(ctx.redact(result.stderr)) };
  }

  const stillMissing = await missingServicesLegacy(ctx, missing, signal);
  if (stillMissing.length > 0) {
    return {
      ok: false,
      recovered: missing.filter((name) => !stillMissing.includes(name)),
      missing: stillMissing,
      reason: `다시 올렸지만 ${stillMissing.join(', ')} 컨테이너가 여전히 running 상태가 아닙니다`,
    };
  }
  return { ok: true, recovered: missing };
}
