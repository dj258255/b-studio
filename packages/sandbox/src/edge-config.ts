import type { EgressRule, LoadedProject } from '@b-studio/spec';

/** 샌드박스 네트워크의 유일한 출입구 (packages/sandbox/edge/edge.mjs). Docker와 Kubernetes 제공자가 같은 설정을 쓴다 */
export const EDGE_SERVICE = 'b-studio-edge';
export const EDGE_PROXY_PORT = 3128;
export const EDGE_IMAGE = 'node:22-bookworm-slim';
const EDGE_FIRST_PORT = 20_000;

/** 기본으로 허용하는 외부 호스트: 템플릿이 의존성을 받는 패키지 저장소와 Next 템플릿의 next/font/google */
export const DEFAULT_EGRESS_ALLOW = [
  'registry.npmjs.org',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'repo.maven.apache.org',
  'repo1.maven.org',
  // Google이 운영하는 Maven Central 공식 미러. Spring Boot 템플릿이 먼저 쓴다(docs/troubleshooting.md 45)
  'maven-central.storage-download.googleapis.com',
  'plugins.gradle.org',
  'plugins-artifacts.gradle.org',
  'services.gradle.org',
  'downloads.gradle.org',
  // Gradle 래퍼의 배포판(services.gradle.org/distributions/…)은 GitHub 릴리스로 넘겨 준다(307 → github.com → 302 → release-assets).
  // HTTPS는 CONNECT 터널이라 경로로 좁힐 수 없어 호스트로 연다(ADR 참고). npm·Go 의존성도 GitHub에서 받는 일이 많다
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
];

/** managed 서비스가 edge에서 공개되는 포트. 서비스 순서로 정해 여러 서비스가 같은 컨테이너 포트를 써도 겹치지 않는다 */
export function edgePortFor(project: LoadedProject, service: string): number {
  const index = project.managed.findIndex(([name]) => name === service);
  if (index === -1) throw new Error(`'${service}'은(는) managed 서비스가 아닙니다`);
  return EDGE_FIRST_PORT + index;
}

/** 프록시를 거치지 않고 부를 이름: 로컬, 샌드박스 서비스, edge가 받는 등록한 사내 API */
export function directHosts(project: LoadedProject, services: readonly string[]): string[] {
  return ['localhost', '127.0.0.1', ...services, ...(project.external ?? []).map(([name]) => name)];
}

/** 서비스가 밖으로 나가는 HTTP(S)를 edge 프록시로 보내게 하는 환경 변수 */
export function proxyEnvironment(direct: readonly string[]): Record<string, string> {
  const proxy = `http://${EDGE_SERVICE}:${EDGE_PROXY_PORT}`;
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: direct.join(','),
    no_proxy: direct.join(','),
    // Node 22.21+ 의 기본 fetch는 이 값이 있어야 HTTP(S)_PROXY를 따른다. corepack 0.36(2026-09 베이스 이미지)이
    // 자체 프록시 처리를 없애 이 값이 없으면 격리 네트워크에서 pnpm을 받지 못한다(#69). 이 값을 모르는 옛 Node는 무시하므로 해가 없다
    NODE_USE_ENV_PROXY: '1',
    // JVM(Gradle, 앱)은 프록시 환경 변수를 읽지 않으므로 시스템 속성으로 넘긴다
    JAVA_TOOL_OPTIONS: [
      `-Dhttp.proxyHost=${EDGE_SERVICE}`,
      `-Dhttp.proxyPort=${EDGE_PROXY_PORT}`,
      `-Dhttps.proxyHost=${EDGE_SERVICE}`,
      `-Dhttps.proxyPort=${EDGE_PROXY_PORT}`,
      `-Dhttp.nonProxyHosts=${direct.join('|')}`,
    ].join(' '),
  };
}

/** edge 프로세스 설정. 값을 그대로 담는다 (compose override는 $를 따로 적는다) */
export function edgeEnvironment(project: LoadedProject, services: readonly string[]): Record<string, string> {
  const egress: EgressRule[] = [...DEFAULT_EGRESS_ALLOW, ...(project.egress ?? [])];
  return {
    EDGE_MAIN: '1',
    EDGE_FORWARDS: project.managed.map(([name, service]) => `${edgePortFor(project, name)}=${name}:${service.port}`).join(','),
    EDGE_EGRESS: JSON.stringify(egress),
    EDGE_CALLERS: services.join(','),
    EDGE_EXTERNALS: JSON.stringify((project.external ?? []).map(([name, service]) => ({ name, baseUrl: service.baseUrl, policy: service.policy }))),
  };
}
