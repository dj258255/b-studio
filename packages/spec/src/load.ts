import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { StudioSpecSchema, type ManagedServiceSpec, type StudioSpec } from './schema';

export const SPEC_FILE = 'studio.yaml';

export class SpecError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n${issues.map((issue) => `  - ${issue}`).join('\n')}` : message);
    this.name = 'SpecError';
    this.issues = issues;
  }
}

export interface LoadedProject {
  root: string;
  spec: StudioSpec;
  composePath: string;
  managed: Array<[name: string, service: ManagedServiceSpec]>;
  /** compose의 external 볼륨. 샌드박스끼리 공유하는 의존성 캐시(Gradle, pnpm, uv) 용도 */
  sharedVolumes: string[];
}

export function parseSpec(source: string): StudioSpec {
  const result = StudioSpecSchema.safeParse(parse(source));
  if (!result.success) {
    throw new SpecError(
      `${SPEC_FILE} 형식이 올바르지 않습니다`,
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

const ComposeSchema = z.object({
  services: z.record(z.string(), z.unknown()),
  volumes: z
    .record(z.string(), z.object({ external: z.boolean().optional(), name: z.string().optional() }).nullable())
    .optional(),
});

export async function loadProject(dir: string): Promise<LoadedProject> {
  const root = path.resolve(dir);
  const spec = parseSpec(await readText(path.join(root, SPEC_FILE)));
  const composePath = path.resolve(root, spec.compose);
  const compose = ComposeSchema.safeParse(parse(await readText(composePath), { merge: true }));
  if (!compose.success) {
    throw new SpecError(`${spec.compose}에 services 항목이 없습니다`);
  }

  const composeServices = new Set(Object.keys(compose.data.services));
  const managed: LoadedProject['managed'] = [];
  const issues: string[] = [];

  const composeVolumes = compose.data.volumes ?? {};

  for (const [name, service] of Object.entries(spec.services)) {
    const inCompose = composeServices.has(name);
    if (service.source === 'managed') {
      if (!inCompose) issues.push(`services.${name}: managed 서비스는 ${spec.compose}에 같은 이름으로 정의돼야 합니다`);
      managed.push([name, service]);

      service.snapshots?.forEach((snapshot, index) => {
        const field = `services.${name}.snapshots.${index}.volume`;
        if (!(snapshot.volume in composeVolumes)) {
          issues.push(`${field}: ${spec.compose}의 volumes에 '${snapshot.volume}'이 없습니다`);
        } else if (composeVolumes[snapshot.volume]?.external) {
          issues.push(`${field}: 샌드박스끼리 공유하는 external 볼륨은 스냅샷으로 만들 수 없습니다`);
        } else if (inCompose && !mountsVolume(compose.data.services[name], snapshot.volume)) {
          issues.push(`${field}: ${spec.compose}의 ${name} 서비스가 '${snapshot.volume}' 볼륨을 마운트하지 않습니다`);
        }
      });
    } else if (inCompose) {
      issues.push(`services.${name}: external 서비스는 샌드박스에서 실행하지 않으므로 ${spec.compose}에 넣지 않습니다`);
    }
  }

  if (issues.length > 0) throw new SpecError(`${SPEC_FILE}과 ${spec.compose}가 맞지 않습니다`, issues);

  const sharedVolumes = Object.entries(compose.data.volumes ?? {})
    .filter(([, volume]) => volume?.external === true)
    .map(([key, volume]) => volume?.name ?? key);

  return { root, spec, composePath, managed, sharedVolumes };
}

/** compose 서비스의 volumes 항목(짧은 문법 "이름:경로", 긴 문법 { source })에 볼륨이 있는지 */
function mountsVolume(service: unknown, volume: string): boolean {
  const mounts = (service as { volumes?: unknown } | null)?.volumes;
  if (!Array.isArray(mounts)) return false;
  return mounts.some((mount) =>
    typeof mount === 'string' ? mount.split(':')[0] === volume : (mount as { source?: unknown } | null)?.source === volume,
  );
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SpecError(`파일이 없습니다: ${file}`);
    throw error;
  }
}
