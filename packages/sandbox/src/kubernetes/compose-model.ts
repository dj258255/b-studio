import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LoadedProject } from '@b-studio/spec';

const execFileAsync = promisify(execFile);

/** `docker compose config --format json`이 정규화한 서비스 한 개 (Kubernetes 번역에 쓰는 필드만) */
export interface ComposeService {
  image?: string;
  build?: { context: string; dockerfile?: string; args?: Record<string, string | null> };
  command?: string[] | null;
  entrypoint?: string[] | null;
  /** 값이 null이면 compose 프로세스 환경에서 채우는 항목이다 */
  environment?: Record<string, string | null>;
  working_dir?: string;
  volumes?: Array<{ type: 'bind' | 'volume' | 'tmpfs'; source?: string; target: string; read_only?: boolean }>;
  depends_on?: Record<string, { condition: string; required?: boolean }>;
  healthcheck?: { test?: string[]; interval?: string; timeout?: string; retries?: number; start_period?: string; disable?: boolean };
}

export interface ComposeModel {
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string; external?: boolean } | null>;
}

/**
 * compose 파일 해석(변수 치환, 상대 경로, 짧은 문법)은 docker compose에 맡기고 정규화된 결과만 쓴다.
 * Kubernetes 제공자도 compose를 그대로 프로젝트의 실행 정의로 삼는다
 */
export async function loadComposeModel(
  project: LoadedProject,
  { dockerBin = 'docker', env = process.env }: { dockerBin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ComposeModel> {
  const { stdout } = await execFileAsync(
    dockerBin,
    ['compose', '--project-directory', project.root, '--file', project.composePath, 'config', '--format', 'json'],
    { env, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as ComposeModel;
}
