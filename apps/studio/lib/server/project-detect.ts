/**
 * 아무 폴더나 프로젝트로 열 때(ADR-067), 폴더를 보고 스택을 알아내 b-studio가 돌릴 파일(studio.yaml·개발용 compose·Dockerfile)을 제안한다.
 *
 * 알아내는 스택(폴더 바로 아래와 한 단계 아래 폴더):
 *  - Next.js: package.json의 의존성에 next. 패키지 관리자는 잠금 파일로(pnpm·yarn·npm)
 *  - Vite(React·Vue·Svelte 등): package.json의 의존성에 vite(Next가 아닐 때)
 *  - Spring Boot: build.gradle(.kts)에 org.springframework.boot, 또는 pom.xml에 spring-boot
 *  - FastAPI: requirements.txt·pyproject.toml에 fastapi. 앱 모듈은 `X = FastAPI(`가 있는 파일에서
 *
 * 만드는 파일은 사용자 파일과 이름이 겹치지 않게 `studio.yaml`·`compose.b-studio.yaml`·서비스 폴더의 `Dockerfile.b-studio`다.
 * 쓰기는 이 모듈이 하지 않는다(제안만). 쓰는 쪽(project-registry)이 git 추적에서 빼 둔다.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type DetectedTemplate = 'nextjs' | 'vite' | 'spring-boot' | 'fastapi';

export interface DetectedService {
  name: string;
  template: DetectedTemplate;
  /** 프로젝트 폴더 기준. 폴더 바로 아래면 '.' */
  path: string;
  port: number;
  preview: 'browser' | 'openapi';
  ready: { path: string; expectStatus?: number };
  contract?: string;
  /** Dockerfile 본문 */
  dockerfile: string;
  /** compose 서비스에 더 붙일 볼륨(이름 → 컨테이너 경로) */
  volumes: Record<string, string>;
  /** 사람이 확인해야 할 추측 */
  notes: string[];
}

export interface ProjectDetection {
  folder: string;
  name: string;
  /** 이미 studio.yaml이 있으면 그대로 쓴다(아무것도 만들지 않는다) */
  hasSpec: boolean;
  services: DetectedService[];
  warnings: string[];
}

export interface GeneratedFile {
  /** 프로젝트 폴더 기준 */
  path: string;
  content: string;
}

export const SPEC_FILE = 'studio.yaml';
export const GENERATED_COMPOSE = 'compose.b-studio.yaml';
export const GENERATED_DOCKERFILE = 'Dockerfile.b-studio';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'build', 'dist', 'target', '.gradle', '.venv', 'venv', '__pycache__', '.idea', '.vscode']);

export async function detectProject(folder: string): Promise<ProjectDetection> {
  const root = path.resolve(folder);
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`폴더가 아닙니다: ${root}`);
  const name = path.basename(root);
  if (await exists(path.join(root, SPEC_FILE))) return { folder: root, name, hasSpec: true, services: [], warnings: [] };

  const candidates = ['.', ...(await childDirs(root))];
  const found: Array<Omit<DetectedService, 'name'>> = [];
  for (const relative of candidates) {
    const service = await detectDir(path.join(root, relative), relative);
    if (service) found.push(service);
  }
  // 폴더 바로 아래가 앱이면(단일 앱 저장소) 하위 폴더에서 찾은 것은 그 앱의 일부일 가능성이 커서 버린다
  const rootApp = found.find((service) => service.path === '.');
  const services = nameServices(rootApp ? [rootApp] : found);
  const warnings: string[] = [];
  if (services.length === 0) warnings.push('Next.js·Vite·Spring Boot·FastAPI 앱을 찾지 못했습니다. studio.yaml을 직접 쓰거나 지원하는 스택인지 확인하세요');
  return { folder: root, name, hasSpec: false, services, warnings };
}

/** 서비스 이름: 폴더 바로 아래면 역할(web/api), 하위 폴더면 폴더 이름. compose 이름 규칙에 맞추고 겹치지 않게 한다 */
function nameServices(found: ReadonlyArray<Omit<DetectedService, 'name'>>): DetectedService[] {
  const used = new Set<string>();
  return found.map((service) => {
    const base = service.path === '.' ? (service.template === 'nextjs' || service.template === 'vite' ? 'web' : 'api') : sanitize(path.basename(service.path));
    let name = base || 'app';
    for (let index = 2; used.has(name); index++) name = `${base}-${index}`;
    used.add(name);
    return { name, ...service };
  });
}

/** studio.yaml의 이름 규칙(소문자로 시작, 소문자·숫자·-)에 맞춘다. 맞출 수 없으면 빈 문자열 */
export function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/g, '')
    .replace(/-{2,}/g, '-');
}

async function detectDir(dir: string, relative: string): Promise<Omit<DetectedService, 'name'> | undefined> {
  return (await detectNode(dir, relative)) ?? (await detectSpring(dir, relative)) ?? (await detectFastApi(dir, relative));
}

/** Next.js 또는 Vite 앱. Next가 있으면 Next로 본다 */
async function detectNode(dir: string, relative: string): Promise<Omit<DetectedService, 'name'> | undefined> {
  const pkg = await readJson(path.join(dir, 'package.json'));
  if (!pkg) return undefined;
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
  const template: DetectedTemplate | undefined = deps.next ? 'nextjs' : deps.vite ? 'vite' : undefined;
  if (!template) return undefined;
  const manager = await packageManager(dir, pkg);
  const lockless = manager === 'npm' && !(await exists(path.join(dir, 'package-lock.json')));
  const install = lockless ? 'npm install' : { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', npm: 'npm ci' }[manager];
  const exec = { pnpm: 'pnpm exec', yarn: 'yarn', npm: 'npx' }[manager];
  const port = template === 'nextjs' ? 3000 : 5173;
  const dev = template === 'nextjs' ? `${exec} next dev --hostname 0.0.0.0 --port ${port}` : `${exec} vite --host 0.0.0.0 --port ${port} --strictPort`;
  const notes: string[] = [];
  if (lockless) notes.push('잠금 파일이 없어 npm install로 설치합니다(버전이 달라질 수 있습니다)');
  return {
    template,
    path: relative,
    port,
    preview: 'browser',
    ready: { path: '/' },
    dockerfile: [
      '# b-studio가 만든 개발용 이미지(ADR-067). 소스는 compose에서 마운트하고 의존성은 컨테이너 안에서 설치한다',
      'FROM node:22-bookworm-slim',
      '',
      'RUN corepack enable',
      'WORKDIR /app',
      'ENV NEXT_TELEMETRY_DISABLED=1 \\',
      '    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \\',
      // pnpm은 저장소를 마운트한 소스 폴더(/app) 안에 만들 수 있다. 사용자 폴더와 체크포인트에 섞이지 않게 컨테이너 볼륨에 둔다
      '    npm_config_update_notifier=false \\',
      '    npm_config_store_dir=/cache/pnpm',
      '',
      `EXPOSE ${port}`,
      `CMD ["sh", "-c", "${install} && exec ${dev}"]`,
      '',
    ].join('\n'),
    volumes: { 'node-modules': '/app/node_modules', ...(template === 'nextjs' ? { next: '/app/.next' } : {}), ...(manager === 'pnpm' ? { 'pnpm-store': '/cache/pnpm' } : {}) },
    notes,
  };
}

async function packageManager(dir: string, pkg: Record<string, unknown>): Promise<'pnpm' | 'yarn' | 'npm'> {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'npm') return declared;
  if (await exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

async function detectSpring(dir: string, relative: string): Promise<Omit<DetectedService, 'name'> | undefined> {
  const gradleFile = (await exists(path.join(dir, 'build.gradle.kts'))) ? 'build.gradle.kts' : (await exists(path.join(dir, 'build.gradle'))) ? 'build.gradle' : undefined;
  const gradle = gradleFile ? await readText(path.join(dir, gradleFile)) : undefined;
  const pom = await readText(path.join(dir, 'pom.xml'));
  const isGradle = gradle?.includes('org.springframework.boot') ?? false;
  const isMaven = !isGradle && (pom?.includes('spring-boot') ?? false);
  if (!isGradle && !isMaven) return undefined;
  const build = (isGradle ? gradle : pom) ?? '';
  const java = javaVersion(build) ?? 21;
  const port = (await springPort(dir)) ?? 8080;
  const notes: string[] = [];
  const actuator = build.includes('spring-boot-starter-actuator');
  const springdoc = build.includes('springdoc-openapi');
  const ready = actuator ? { path: '/actuator/health' } : springdoc ? { path: '/v3/api-docs' } : { path: '/', expectStatus: 404 };
  if (!actuator && !springdoc) notes.push('상태 확인 경로를 몰라 "/"가 404를 돌려주면 준비된 것으로 봅니다. actuator를 넣거나 studio.yaml의 ready를 고치세요');
  const wrapper = isGradle ? await exists(path.join(dir, 'gradlew')) : await exists(path.join(dir, 'mvnw'));
  const run = isGradle
    ? wrapper
      ? '["./gradlew", "bootRun", "--no-daemon", "--console=plain"]'
      : '["gradle", "bootRun", "--no-daemon", "--console=plain"]'
    : wrapper
      ? '["./mvnw", "-q", "spring-boot:run"]'
      : '["mvn", "-q", "spring-boot:run"]';
  const image = wrapper ? `eclipse-temurin:${java}-jdk` : isGradle ? `gradle:jdk${java}` : `maven:3-eclipse-temurin-${java}`;
  if (!wrapper) notes.push(`${isGradle ? 'Gradle' : 'Maven'} 래퍼가 없어 ${image} 이미지의 도구로 실행합니다`);
  return {
    template: 'spring-boot',
    path: relative,
    port,
    preview: springdoc ? 'openapi' : 'browser',
    ready: { ...ready },
    ...(springdoc ? { contract: '/v3/api-docs' } : {}),
    dockerfile: [
      '# b-studio가 만든 개발용 이미지(ADR-067). 소스는 compose에서 마운트하고, 의존성은 첫 기동 때 받는다(프록시 설정은 샌드박스가 넣는다)',
      `FROM ${image}`,
      '',
      'WORKDIR /app',
      ...(isGradle ? ['ENV GRADLE_USER_HOME=/gradle-home', ''] : []),
      `EXPOSE ${port}`,
      `CMD ${run}`,
      '',
    ].join('\n'),
    volumes: isGradle ? { 'gradle-home': '/gradle-home', 'gradle-project': '/app/.gradle', build: '/app/build' } : { 'maven-home': '/root/.m2', target: '/app/target' },
    notes: [...notes, '첫 기동은 의존성을 받느라 몇 분 걸릴 수 있습니다'],
  };
}

function javaVersion(build: string): number | undefined {
  const match =
    build.match(/JavaLanguageVersion\.of\((\d+)\)/) ??
    build.match(/JavaVersion\.VERSION_(\d+)/) ??
    build.match(/sourceCompatibility\s*=\s*['"]?(\d+)/) ??
    build.match(/<java\.version>(\d+)<\/java\.version>/);
  const version = match ? Number(match[1]) : undefined;
  return version && version >= 8 ? version : undefined;
}

async function springPort(dir: string): Promise<number | undefined> {
  const resources = path.join(dir, 'src/main/resources');
  const properties = await readText(path.join(resources, 'application.properties'));
  const yaml = (await readText(path.join(resources, 'application.yml'))) ?? (await readText(path.join(resources, 'application.yaml')));
  const match = properties?.match(/^\s*server\.port\s*=\s*(\d+)/m) ?? yaml?.match(/server:\s*\n\s+port:\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function detectFastApi(dir: string, relative: string): Promise<Omit<DetectedService, 'name'> | undefined> {
  const requirements = await readText(path.join(dir, 'requirements.txt'));
  const pyproject = await readText(path.join(dir, 'pyproject.toml'));
  const hasFastApi = /(^|\n)\s*fastapi\b/i.test(requirements ?? '') || /["']fastapi/i.test(pyproject ?? '') || /(^|\n)\s*fastapi\s*=/i.test(pyproject ?? '');
  if (!hasFastApi) return undefined;
  const entry = await fastApiModule(dir);
  const notes: string[] = [];
  if (!entry.found) notes.push('FastAPI 앱을 만드는 파일을 찾지 못해 main:app으로 실행합니다. 다르면 Dockerfile.b-studio를 고치세요');
  const install = requirements ? 'pip install --no-cache-dir -r requirements.txt' : 'pip install --no-cache-dir uv && uv pip install --system -r pyproject.toml';
  return {
    template: 'fastapi',
    path: relative,
    port: 8000,
    preview: 'openapi',
    ready: { path: '/openapi.json' },
    contract: '/openapi.json',
    dockerfile: [
      '# b-studio가 만든 개발용 이미지(ADR-067). 소스는 compose에서 마운트하고 의존성은 컨테이너 안에서 설치한다',
      'FROM python:3.12-slim',
      '',
      'WORKDIR /app',
      'ENV PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1',
      '',
      'EXPOSE 8000',
      `CMD ["sh", "-c", "${install} && exec uvicorn ${entry.target} --reload --host 0.0.0.0 --port 8000"]`,
      '',
    ].join('\n'),
    volumes: {},
    notes,
  };
}

async function fastApiModule(dir: string): Promise<{ target: string; found: boolean }> {
  for (const file of ['main.py', 'app.py', 'app/main.py', 'src/main.py', 'api/main.py']) {
    const text = await readText(path.join(dir, file));
    const match = text?.match(/^(\w+)\s*=\s*FastAPI\(/m);
    if (match) return { target: `${file.replace(/\.py$/, '').replaceAll('/', '.')}:${match[1]}`, found: true };
  }
  return { target: 'main:app', found: false };
}

/** 제안한 서비스로 만들 파일. 이미 studio.yaml이 있으면 아무것도 만들지 않는다 */
export function generateFiles(detection: ProjectDetection): GeneratedFile[] {
  if (detection.hasSpec || detection.services.length === 0) return [];
  const files: GeneratedFile[] = [{ path: SPEC_FILE, content: specYaml(detection) }, { path: GENERATED_COMPOSE, content: composeYaml(detection.services) }];
  for (const service of detection.services) files.push({ path: posixJoin(service.path, GENERATED_DOCKERFILE), content: service.dockerfile });
  return files;
}

function specYaml(detection: ProjectDetection): string {
  const lines = [
    '# b-studio가 폴더를 보고 만든 설정(ADR-067). 이 파일과 compose.b-studio.yaml·Dockerfile.b-studio는 git 추적에서 빼 두었습니다.',
    '# 틀린 추측이 있으면 고쳐도 됩니다. 팀과 나누려면 .git/info/exclude에서 빼고 커밋하세요',
    'version: 1',
    `name: ${sanitize(detection.name) || 'project'}`,
    `compose: ${GENERATED_COMPOSE}`,
    '',
    'services:',
  ];
  for (const service of detection.services) {
    lines.push(`  ${service.name}:`, '    source: managed', `    template: ${service.template}`, `    path: ${yamlString(service.path)}`, `    port: ${service.port}`, `    preview: ${service.preview}`);
    const ready = [`path: ${service.ready.path}`, ...(service.ready.expectStatus ? [`expectStatus: ${service.ready.expectStatus}`] : []), `timeoutSeconds: ${service.template === 'spring-boot' ? 900 : 300}`];
    lines.push(`    ready: { ${ready.join(', ')} }`);
    if (service.contract) lines.push(`    contract: { extract: ${service.contract} }`);
    for (const note of service.notes) lines.push(`    # 확인: ${note}`);
  }
  lines.push('');
  return lines.join('\n');
}

function composeYaml(services: readonly DetectedService[]): string {
  const lines = ['# b-studio가 만든 개발용 compose(ADR-067). 샌드박스가 이 파일로 서비스를 띄운다', 'services:'];
  const volumes: string[] = [];
  for (const service of services) {
    const context = service.path === '.' ? '.' : `./${service.path}`;
    lines.push(`  ${service.name}:`, `    build: { context: ${context}, dockerfile: ${GENERATED_DOCKERFILE} }`, '    volumes:', `      - ${context}:/app`);
    for (const [volume, target] of Object.entries(service.volumes)) {
      const name = `${service.name}-${volume}`;
      lines.push(`      - ${name}:${target}`);
      volumes.push(name);
    }
  }
  if (volumes.length > 0) lines.push('', 'volumes:', ...volumes.map((volume) => `  ${volume}:`));
  lines.push('');
  return lines.join('\n');
}

function posixJoin(dir: string, file: string): string {
  return dir === '.' ? file : `${dir.replace(/\/+$/, '')}/${file}`;
}

function yamlString(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : JSON.stringify(value);
}

async function childDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function readText(file: string): Promise<string | undefined> {
  return readFile(file, 'utf8').catch(() => undefined);
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
