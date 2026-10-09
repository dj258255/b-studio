import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LoadedProject } from '@b-studio/spec';
import { SandboxError } from '../errors';

const execFileAsync = promisify(execFile);

/** 서비스 → (의존 서비스 → 조건). compose가 정규화한 설정의 `depends_on`이다 */
export type DependsOn = Record<string, Record<string, { condition?: string; required?: boolean }>>;

/**
 * compose가 정규화한 설정에서 서비스 사이의 의존 관계를 읽는다.
 * 확인한 컨테이너를 id로 시작할 때(트러블슈팅 121) `up`이 지키던 순서와 준비 대기를 그대로 지키려고 쓴다.
 * 이 값은 순서만 정한다 — 어느 컨테이너를 시작할지는 마운트를 확인한 목록이 정한다
 */
export async function loadDependsOn(
  project: Pick<LoadedProject, 'root' | 'composePath'>,
  { dockerBin = 'docker', env = process.env, projectName, redact = (text: string) => text }: { dockerBin?: string; env?: NodeJS.ProcessEnv; projectName?: string; redact?: (text: string) => string } = {},
): Promise<DependsOn> {
  const args = ['compose', ...(projectName ? ['--project-name', projectName] : []), '--profile', '*', '--project-directory', project.root, '--file', project.composePath, 'config', '--format', 'json'];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(dockerBin, args, { env, maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new SandboxError('compose 설정을 읽지 못해 서비스를 시작할 순서를 정할 수 없습니다', redact(typeof stderr === 'string' && stderr.trim() ? stderr : 'docker 실행 실패'), { platform: true });
  }
  try {
    return parseDependsOn(JSON.parse(stdout));
  } catch {
    throw new SandboxError('compose 설정(config --format json)을 해석하지 못해 서비스를 시작할 순서를 정할 수 없습니다', undefined, { platform: true });
  }
}

/** 정규화한 설정(JSON)에서 depends_on만 뽑는다. 긴 형식(객체)과 짧은 형식(배열)을 모두 받는다 */
export function parseDependsOn(config: unknown): DependsOn {
  const services = (config as { services?: Record<string, { depends_on?: unknown }> } | null)?.services ?? {};
  const result: DependsOn = {};
  for (const [name, service] of Object.entries(services)) {
    const raw = service?.depends_on;
    if (Array.isArray(raw)) {
      result[name] = Object.fromEntries(raw.filter((dep): dep is string => typeof dep === 'string').map((dep) => [dep, { condition: 'service_started' }]));
    } else if (raw && typeof raw === 'object') {
      result[name] = Object.fromEntries(
        Object.entries(raw as Record<string, { condition?: unknown; required?: unknown } | null>).map(([dep, value]) => [
          dep,
          { ...(typeof value?.condition === 'string' ? { condition: value.condition } : {}), ...(typeof value?.required === 'boolean' ? { required: value.required } : {}) },
        ]),
      );
    }
  }
  return result;
}

/**
 * 시작할 서비스를 의존 순서대로 묶는다. **목록 안의 의존만 본다** — 목록에 없는 의존 서비스는 무시한다
 * (`up --no-deps a b`와 같다: 사용자가 꺼 둔 의존 서비스를 따라 켜지 않는다).
 * 한 묶음의 서비스는 서로 의존하지 않으므로 함께 시작해도 된다. 의존이 돌고 돌면(순환) 남은 것을 한 묶음으로 둔다
 */
export function startWaves(services: readonly string[], dependsOn: DependsOn): string[][] {
  const pending = new Set(services);
  const waves: string[][] = [];
  while (pending.size > 0) {
    const ready = [...pending].filter((service) => Object.keys(dependsOn[service] ?? {}).every((dep) => dep === service || !pending.has(dep)));
    const wave = ready.length > 0 ? ready : [...pending];
    waves.push(wave);
    for (const service of wave) pending.delete(service);
  }
  return waves;
}

/** 다음에 시작할 서비스들이 이 서비스에 거는 조건 중 기다려야 하는 것. 여럿이면 더 엄격한 쪽(healthy)을 고른다 */
export function awaitedCondition(service: string, later: readonly string[], dependsOn: DependsOn): 'service_healthy' | 'service_completed_successfully' | undefined {
  const conditions = later.flatMap((dependent) => {
    const condition = dependsOn[dependent]?.[service]?.condition;
    return condition ? [condition] : [];
  });
  if (conditions.includes('service_healthy')) return 'service_healthy';
  if (conditions.includes('service_completed_successfully')) return 'service_completed_successfully';
  return undefined;
}
