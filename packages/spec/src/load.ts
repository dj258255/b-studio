import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { findPublicUrlRefs, type PublicUrlRef } from './public-url';
import {
  STUDIO_CALLER,
  StudioSpecSchema,
  type DatabaseSpec,
  type DeployServiceSpec,
  type EgressRule,
  type ExternalServiceSpec,
  type ManagedServiceSpec,
  type ResourceLimit,
  type SecretSpec,
  type StudioSpec,
} from './schema';

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
  /** compose 서비스 이름과 데이터베이스. dependents는 compose depends_on으로 이 DB에 기대는 managed 서비스 */
  databases: Array<[name: string, database: DatabaseSpec & { dependents: string[] }]>;
  /** compose 서비스 이름 → 컨테이너 한도 */
  resources: Record<string, ResourceLimit>;
  /** compose 파일의 모든 서비스 이름 (부가 서비스 포함) */
  composeServices: string[];
  /** compose 서비스 이름 → 그 서비스가 depends_on으로 기다리는 compose 서비스 이름(부가 서비스끼리의 기댐도 포함). 서비스 선택의 기본값(관리형 + 기댐 닫힘, ADR-083)을 계산할 때 쓴다 */
  dependsOn: Record<string, string[]>;
  /**
   * 이 세션에서 꺼 둔(띄우지 않는) compose 서비스 이름(ADR-083). loadProject()는 채우지 않는다(항상 undefined) —
   * 서비스 선택을 다루는 쪽(studio 서버)이 프로젝트를 불러온 뒤 세션마다 붙인다. 검증 게이트는 여기 있는 서비스를
   * 재시작·확인하지 않고 건너뛴 것으로 기록한다
   */
  offServices?: ReadonlySet<string>;
  /** 기본 패키지 저장소 외에 외부 접속을 허용할 호스트나 평문 HTTP 경로·메서드 규칙 */
  egress: EgressRule[];
  /** 시크릿 이름(컨테이너 환경 변수 이름) → 받을 서비스. 값은 들어 있지 않다 */
  secrets: Array<[name: string, secret: SecretSpec]>;
  /** 등록한 사내 API. 샌드박스에서는 이 이름의 호스트로 부르고 edge가 정책을 적용한다 */
  external: Array<[name: string, service: ExternalServiceSpec]>;
  /** managed 서비스 이름 → 운영 배포 설정. 적지 않은 서비스도 기본값(Dockerfile)으로 채운다 */
  deploy: Record<string, DeployServiceSpec>;
  /**
   * 런타임 공개 URL 주입(fix/frontend-backend-url). compose의 environment 값에 `${b-studio:services.<서비스>.publicUrl}`
   * 자리 표시자가 있으면 여기 담는다. 샌드박스 제공자가 띄우기 직전에 targetService의 호스트 포트를 먼저 정해(pre-allocate)
   * 이 자리를 실제 주소로 채운다(packages/sandbox/src/docker/compose-provider.ts)
   */
  publicUrlRefs: PublicUrlRef[];
}

export function parseSpec(source: string): StudioSpec {
  const result = StudioSpecSchema.safeParse(parseYaml(source, SPEC_FILE));
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
  const spec = parseSpec(await readProjectText(root, SPEC_FILE));
  const composePath = path.resolve(root, spec.compose);
  const compose = ComposeSchema.safeParse(parseYaml(await readProjectText(root, spec.compose), spec.compose, { merge: true }));
  if (!compose.success) {
    throw new SpecError(`${spec.compose}에 services 항목이 없습니다`);
  }

  const composeServices = new Set(Object.keys(compose.data.services));
  const managed: LoadedProject['managed'] = [];
  const external: LoadedProject['external'] = [];
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
    } else {
      if (inCompose) issues.push(`services.${name}: external 서비스는 샌드박스에서 실행하지 않으므로 ${spec.compose}에 넣지 않습니다`);
      external.push([name, service]);

      service.policy.allow?.forEach((rule, index) => {
        for (const caller of rule.callers) {
          if (caller !== STUDIO_CALLER && !composeServices.has(caller)) {
            issues.push(`services.${name}.policy.allow.${index}.callers: '${caller}'은(는) ${spec.compose}의 서비스도 ${STUDIO_CALLER}도 아닙니다`);
          }
        }
      });
      const secret = service.policy.auth?.secret;
      if (secret && !spec.secrets?.[secret]) issues.push(`services.${name}.policy.auth.secret: secrets에 '${secret}'이 없습니다`);
    }
  }

  const databases: LoadedProject['databases'] = [];
  for (const [name, database] of Object.entries(spec.databases ?? {})) {
    if (!composeServices.has(name)) {
      issues.push(`databases.${name}: ${spec.compose}에 같은 이름의 서비스가 없습니다`);
      continue;
    }
    if (spec.services[name]) {
      issues.push(`databases.${name}: services에 등록한 서비스는 데이터베이스로 등록할 수 없습니다`);
      continue;
    }
    const dependents = managed.map(([service]) => service).filter((service) => dependsOn(compose.data.services[service], name));
    databases.push([name, { ...database, dependents }]);
  }

  for (const name of Object.keys(spec.resources ?? {})) {
    if (!composeServices.has(name)) issues.push(`resources.${name}: ${spec.compose}에 같은 이름의 서비스가 없습니다`);
  }

  // 검증 명령과 화면 확인은 스튜디오가 재시작하는 관리형 서비스에서만 의미가 있다
  const managedNames = new Set(managed.map(([name]) => name));
  spec.workflow?.tests?.forEach((test, index) => {
    if (!managedNames.has(test.service)) issues.push(`workflow.tests.${index}.service: '${test.service}'은(는) source: managed 서비스가 아닙니다`);
  });
  spec.workflow?.pageChecks?.forEach((check, index) => {
    if (!managedNames.has(check.service)) issues.push(`workflow.pageChecks.${index}.service: '${check.service}'은(는) source: managed 서비스가 아닙니다`);
    // expectFromApi는 값을 꺼낼 api 서비스다. concurrencyChecks.service와 같은 규칙으로 관리형 서비스만 받는다
    if (check.expectFromApi && !managedNames.has(check.expectFromApi.service)) {
      issues.push(`workflow.pageChecks.${index}.expectFromApi.service: '${check.expectFromApi.service}'은(는) source: managed 서비스가 아닙니다`);
    }
    // fallbackProbe(fix/frontend-backend-url)도 같은 규칙: 헤드리스 브라우저가 없을 때 대신 부를 서비스라 관리형이어야 한다
    if (check.fallbackProbe && !managedNames.has(check.fallbackProbe.service)) {
      issues.push(`workflow.pageChecks.${index}.fallbackProbe.service: '${check.fallbackProbe.service}'은(는) source: managed 서비스가 아닙니다`);
    }
  });
  spec.workflow?.concurrencyChecks?.forEach((check, index) => {
    if (!managedNames.has(check.service)) issues.push(`workflow.concurrencyChecks.${index}.service: '${check.service}'은(는) source: managed 서비스가 아닙니다`);
  });
  spec.workflow?.loadChecks?.forEach((check, index) => {
    if (!managedNames.has(check.service)) issues.push(`workflow.loadChecks.${index}.service: '${check.service}'은(는) source: managed 서비스가 아닙니다`);
  });

  // 런타임 공개 URL 자리 표시자(fix/frontend-backend-url)가 가리키는 서비스도 샌드박스가 포트를 공개하는 관리형 서비스여야 한다
  const publicUrlRefs = findPublicUrlRefs(compose.data.services);
  for (const ref of publicUrlRefs) {
    if (!managedNames.has(ref.targetService)) {
      issues.push(`${ref.service}.environment.${ref.envKey}: \${b-studio:services.${ref.targetService}.publicUrl}이 가리키는 '${ref.targetService}'이(가) source: managed 서비스가 아닙니다`);
    }
  }

  // 자동 페이지 확인은 Next.js 앱 라우터(app/**/page.*)에서 열어 볼 경로를 찾는다. 관리형이면서 템플릿이 nextjs인 서비스에만 쓸 수 있다
  const autoPages = spec.workflow?.autoPageChecks;
  if (autoPages) {
    const service = managed.find(([name]) => name === autoPages.service);
    if (!service) {
      issues.push(`workflow.autoPageChecks.service: '${autoPages.service}'은(는) source: managed 서비스가 아닙니다`);
    } else if (service[1].template !== 'nextjs') {
      issues.push(
        `workflow.autoPageChecks.service: '${autoPages.service}'의 템플릿이 ${service[1].template}입니다. app 라우터를 쓰는 Next.js(nextjs) 서비스에서만 자동 페이지 확인을 켤 수 있습니다`,
      );
    }
  }

  for (const [name, secret] of Object.entries(spec.secrets ?? {})) {
    for (const service of secret.services) {
      if (!composeServices.has(service)) issues.push(`secrets.${name}.services: ${spec.compose}에 '${service}' 서비스가 없습니다`);
    }
    const usedByPolicy = external.some(([, service]) => service.policy.auth?.secret === name);
    if (secret.services.length === 0 && !usedByPolicy) {
      issues.push(`secrets.${name}: 받을 서비스(services)나 외부 API 인증(policy.auth)에 쓰이지 않습니다`);
    }
  }

  const deployPorts = new Map<number, string>();
  for (const [name, service] of Object.entries(spec.deploy?.services ?? {})) {
    if (!managed.some(([managedName]) => managedName === name)) issues.push(`deploy.services.${name}: managed 서비스만 배포 설정을 가질 수 있습니다`);
    if (service.port === undefined) continue;
    const taken = deployPorts.get(service.port);
    if (taken) issues.push(`deploy.services.${name}.port: ${taken} 서비스와 같은 포트(${service.port})입니다`);
    deployPorts.set(service.port, name);
  }

  if (issues.length > 0) throw new SpecError(`${SPEC_FILE}과 ${spec.compose}가 맞지 않습니다`, issues);

  const sharedVolumes = Object.entries(compose.data.volumes ?? {})
    .filter(([, volume]) => volume?.external === true)
    .map(([key, volume]) => volume?.name ?? key);

  const dependsOnGraph: LoadedProject['dependsOn'] = {};
  for (const name of composeServices) dependsOnGraph[name] = dependsOnNames(compose.data.services[name]).filter((dependency) => composeServices.has(dependency));

  return {
    root,
    spec,
    composePath,
    managed,
    sharedVolumes,
    databases,
    resources: spec.resources ?? {},
    composeServices: [...composeServices],
    dependsOn: dependsOnGraph,
    egress: spec.network?.egress ?? [],
    secrets: Object.entries(spec.secrets ?? {}),
    external,
    deploy: Object.fromEntries(managed.map(([name]) => [name, spec.deploy?.services[name] ?? { dockerfile: 'Dockerfile' }])),
    publicUrlRefs,
  };
}

/** compose depends_on은 목록(["db"])이나 맵({ db: { condition } })으로 쓴다 */
function dependsOn(service: unknown, target: string): boolean {
  return dependsOnNames(service).includes(target);
}

/** compose 서비스 하나의 depends_on 대상 이름 목록 */
function dependsOnNames(service: unknown): string[] {
  const dependencies = (service as { depends_on?: unknown } | null)?.depends_on;
  if (Array.isArray(dependencies)) return dependencies.filter((entry): entry is string => typeof entry === 'string');
  if (dependencies && typeof dependencies === 'object') return Object.keys(dependencies);
  return [];
}

/** compose 서비스의 volumes 항목(짧은 문법 "이름:경로", 긴 문법 { source })에 볼륨이 있는지 */
function mountsVolume(service: unknown, volume: string): boolean {
  const mounts = (service as { volumes?: unknown } | null)?.volumes;
  if (!Array.isArray(mounts)) return false;
  return mounts.some((mount) =>
    typeof mount === 'string' ? mount.split(':')[0] === volume : (mount as { source?: unknown } | null)?.source === volume,
  );
}

/**
 * 프로젝트 폴더 안의 설정 파일을 읽는다. 경로가 프로젝트 폴더를 벗어나거나(`compose: ../../x`, 절대 경로), 파일이 프로젝트 밖을
 * 가리키는 심볼릭 링크면 읽지 않는다. studio.yaml과 그 안의 `compose` 값은 에이전트가 고칠 수 있는 내용이고 이 함수는
 * 호스트에서 돈다 — 막지 않으면 호스트의 아무 파일이나 읽혀, 그 내용이 형식 오류 문구를 타고 대화로 돌아갈 수 있다
 */
async function readProjectText(root: string, relative: string): Promise<string> {
  const file = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !isInside(root, file)) {
    throw new SpecError(`${relative}: 프로젝트 폴더 안의 경로만 쓸 수 있습니다`);
  }
  const outside = (): SpecError => new SpecError(`${relative}: 프로젝트 폴더 밖을 가리키는 링크는 읽지 않습니다`);
  const missing = (): SpecError => new SpecError(`파일이 없습니다: ${file}`);
  let realRoot: string;
  let realFile: string;
  try {
    [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing();
    throw new SpecError(`${relative}: 파일을 열 수 없습니다`);
  }
  if (!isInside(realRoot, realFile)) throw outside();

  // 위의 확인과 여는 것 사이에 경로의 폴더나 파일이 링크로 바뀔 수 있다. 그래서 먼저 열고(마지막 조각이 링크면 열지 않는다),
  // 연 파일이 지금도 그 경로가 가리키는 프로젝트 안의 파일과 같은 파일인지 본 뒤에 그 열린 파일에서 읽는다
  let handle: FileHandle;
  try {
    handle = await open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw missing();
    if (code === 'ELOOP') throw outside();
    throw new SpecError(`${relative}: 파일을 열 수 없습니다`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new SpecError(`${relative}: 일반 파일이 아닙니다`);
    const [rootNow, fileNow] = await Promise.all([realpath(root), realpath(file)]);
    const now = await lstat(fileNow);
    if (!isInside(rootNow, fileNow) || now.dev !== opened.dev || now.ino !== opened.ino) throw outside();
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof SpecError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing();
    throw new SpecError(`${relative}: 파일을 읽을 수 없습니다`);
  } finally {
    await handle.close();
  }
}

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * YAML을 해석한다. 문법 오류는 위치(줄·칸)만 담은 SpecError로 바꾼다 — yaml 라이브러리의 오류 문구에는 문제 줄의 내용이
 * 그대로 실려, 읽으면 안 되는 파일이 읽혔을 때 그 내용이 새는 길이 된다
 */
function parseYaml(source: string, label: string, options?: { merge?: boolean }): unknown {
  try {
    return parse(source, options);
  } catch (error) {
    const pos = (error as { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
    const code = (error as { code?: string }).code;
    throw new SpecError(`${label}의 YAML 문법이 올바르지 않습니다${pos ? `(${pos.line}번째 줄 ${pos.col}번째 칸)` : ''}${code ? ` [${code}]` : ''}`);
  }
}
