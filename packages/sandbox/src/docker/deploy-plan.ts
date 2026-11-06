import type { LoadedProject } from '@b-studio/spec';
import type { ComposeModel } from '../kubernetes/compose-model';
import { decodeNative, encodeNative, native } from '../native';

/**
 * 무중단 배포 계획의 판정. 무엇을 어떻게 띄울지(기반 스택과 릴리스 스택의 compose, 빌드 인자, 프록시 설정, 정리할 릴리스)를 정하는
 * 코드는 Rust(crates/bstudio-guard/src/deploy_plan.rs)에 있고, 여기는 이름과 시그니처를 지키는 껍데기다(ADR-191).
 * 빌드·compose up·전환·정리는 deploy.ts가 한다. 모양이 어긋난 입력은 Rust가 던진다
 */

/** 운영 주소를 고정하고 릴리스를 무중단으로 바꾸는 프록시. 설정을 다시 읽어도 연결을 끊지 않는다 */
export const DEPLOY_PROXY_IMAGE = 'caddy:2-alpine';

export interface DeployRelease {
  /** 이미지 태그와 compose 프로젝트 이름에 들어간다 */
  id: string;
  createdAt: string;
  finishedAt?: string;
  /** 무엇을 배포했는지. 스튜디오는 체크포인트, CLI는 폴더나 Git 커밋 */
  source: { label: string; sha?: string };
  by?: string;
  /**
   * active: 운영 주소가 가리키는 릴리스, previous: 되돌릴 수 있게 이미지를 남긴 이전 릴리스,
   * retired: 이미지를 지운 오래된 릴리스, failed: 빌드나 준비 확인에 실패해 전환하지 않은 릴리스
   */
  status: 'active' | 'previous' | 'retired' | 'failed';
  /** 서비스 이름 → 운영 이미지 태그 */
  images: Record<string, string>;
  /** 이 릴리스 네트워크에 붙이는 기반 스택의 부가 서비스 (DB 등) */
  baseServices: string[];
  /** 한 줄 요약 */
  error?: string;
  /** 컴파일 에러나 컨테이너 로그처럼 원인을 찾을 줄 */
  errorDetail?: string;
}

export interface DeployHistoryEntry {
  at: string;
  action: 'deploy' | 'rollback' | 'failed';
  release: string;
  /** 전환하기 전에 운영 주소가 가리키던 릴리스 */
  from?: string;
  error?: string;
}

/** 프로젝트 하나의 운영 배포 상태. 스튜디오 서버의 상태 폴더에 둔다 */
export interface DeployState {
  version: 1;
  project: string;
  /** 서비스 이름 → 운영 주소로 공개한 127.0.0.1의 포트. 한 번 정하면 배포를 바꿔도 그대로다 */
  ports: Record<string, number>;
  active?: string;
  releases: DeployRelease[];
  history: DeployHistoryEntry[];
}

export function emptyDeployState(project: string): DeployState {
  return JSON.parse(native.emptyDeployState(project)) as DeployState;
}

/** 배포 자원 이름. 샌드박스(studio-*)와 섞이지 않게 접두사를 따로 쓴다 */
export function deployNames(project: string) {
  return {
    base: native.deployBaseName(project),
    release: (id: string) => native.deployReleaseName(project, id),
    proxy: native.deployProxyName(project),
    image: (service: string, id: string) => native.deployImageName(project, service, id),
    container: (composeProject: string, service: string) => native.deployContainerName(composeProject, service),
  };
}

/** 초 단위까지의 UTC 시각. 태그와 compose 프로젝트 이름에 쓸 수 있는 글자만 쓴다 */
export function newReleaseId(now = new Date()): string {
  return native.newReleaseId(now.getTime());
}

export function proxyListenPort(index: number): number {
  return native.proxyListenPort(index);
}

/** 부가 서비스(DB 등)만 담은 기반 스택. 릴리스를 바꿔도 내리지 않고, 데이터 폴더는 이름 붙인 볼륨에 둔다 */
export function planBaseCompose(
  config: ComposeModel,
  project: Pick<LoadedProject, 'managed' | 'databases'> & { spec?: Pick<LoadedProject['spec'], 'name'> },
): { services: Record<string, unknown>; volumes?: Record<string, unknown> } | undefined {
  const projection = {
    name: project.spec?.name,
    managed: project.managed.map(([name]) => name),
    databases: project.databases.map(([name, database]) => [name, database.engine]),
  };
  return decodeNative<{ services: Record<string, unknown>; volumes?: Record<string, unknown> } | null>(native.planBaseCompose(encodeNative(config), encodeNative(projection))) ?? undefined;
}

/** 릴리스 스택. managed 서비스를 운영 이미지로 띄우고, 준비 확인용으로 루프백의 빈 포트에 공개한다 */
export function planReleaseCompose(
  config: ComposeModel,
  project: Pick<LoadedProject, 'managed' | 'secrets' | 'resources' | 'spec'>,
  { releaseId, images }: { releaseId: string; images: Record<string, string> },
): { services: Record<string, unknown> } {
  const projection = {
    name: project.spec.name,
    managed: project.managed.map(([name, service]) => [name, service.port]),
    secrets: project.secrets.map(([name, secret]) => [name, secret.services]),
    resources: project.resources,
  };
  return decodeNative<{ services: Record<string, unknown> }>(native.planReleaseCompose(encodeNative(config), encodeNative(projection), releaseId, encodeNative(images)));
}

/** 운영 이미지의 빌드 인자. compose build.args에 더해, Dockerfile이 ARG로 선언한 이름 중 compose environment에 값이 있는 것만 넘긴다 */
export function buildArgsFor(
  dockerfile: string,
  build: { args?: Record<string, string | null> } | undefined,
  environment: Record<string, string | null> | undefined,
): Record<string, string> {
  return decodeNative<Record<string, string>>(native.buildArgsFor(dockerfile, encodeNative(build ?? null), encodeNative(environment ?? null)));
}

/** 빌드 출력에서 원인을 찾을 줄만 고른다. 에러를 뜻하는 줄이 없으면 끝부분을 돌려준다 */
export function summarizeBuildOutput(output: string, maxLines = 15): string {
  return native.summarizeBuildOutput(output, maxLines);
}

/** 운영 프록시 설정. 자동 HTTPS는 끄고(루프백 공개), 서비스마다 한 포트에서 릴리스 컨테이너로 넘긴다 */
export function buildCaddyfile(routes: ReadonlyArray<{ listen: number; upstream: string }>): string {
  return native.buildCaddyfile(encodeNative(routes));
}

/** 되돌릴 수 있게 남길 이전 릴리스를 고르고, 그보다 오래된 이전 릴리스를 돌려준다. 같은 객체를 돌려준다(부르는 쪽이 상태를 바꾼다) */
export function releasesToRetire(releases: readonly DeployRelease[], keepPrevious: number): DeployRelease[] {
  return native.releasesToRetire(encodeNative(releases.map((release) => release.status)), keepPrevious).map((index) => releases[index]!);
}

/** 기록을 최근 것부터 정해진 수만큼만 남긴다. 운영 주소가 가리키는 릴리스는 오래됐어도 남긴다 */
export function trimRecords(releases: readonly DeployRelease[], active: string | undefined): DeployRelease[] {
  return native.trimRecords(encodeNative(releases.map((release) => release.id)), active).map((index) => releases[index]!);
}
