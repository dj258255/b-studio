/**
 * 실행 중인 세션의 작업 복사본에서, 각 managed 서비스의 생성 Dockerfile(Dockerfile.b-studio)을 지금
 * studio.yaml의 systemPackages 선언과 맞춘다(도그푸딩 마찰 113, ADR-137).
 *
 * "생성 파일 다시 만들기"(ADR-101)는 프로젝트를 처음 연 원본 폴더를 다시 훑는 사람의 명시적 동작이라, 세션이
 * 켜져 있는 동안 에이전트가 studio.yaml에 systemPackages를 더해도 자동으로 반영되지 않는다. 이 함수는 그 틈을
 * 메운다 — restartServicesFor(어떤 파일이 바뀌어 서비스를 다시 띄우는 모든 경로: 게이트 검증, 되돌리기,
 * 체크포인트 복원)가 실제로 `docker compose build`를 부르기 전에 호출해, 다시 띄우는 서비스의 Dockerfile을
 * 지금 studio.yaml 선언과 같게 맞춘다. 결과는 멱등적이다(@b-studio/spec의 applySystemPackages) — 선언이 그대로면
 * 파일도 그대로이므로 매번 호출해도 안전하고, 선언을 지우면 Dockerfile의 설치 블록도 함께 사라진다.
 *
 * b-studio가 만든 Dockerfile.b-studio가 없는 서비스(사용자가 직접 다른 이름의 Dockerfile을 쓰는 경우)는
 * 건드리지 않는다 — systemPackages는 생성 Dockerfile에만 적용되는 선언이다.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applySystemPackages, type LoadedProject } from '@b-studio/spec';

/** project-detect.ts(GENERATED_DOCKERFILE)와 이름이 같아야 한다. 값 자체가 안정적인 상수라 중복 선언한다(패키지 경계를 넘는 의존을 늘리지 않는다) */
export const GENERATED_DOCKERFILE = 'Dockerfile.b-studio';

/**
 * services로 좁힌 managed 서비스만 본다(지금 다시 띄우는 서비스만 — 그 밖의 서비스는 이번에 이미지를 다시 빌드하지 않으므로
 * 건드릴 필요가 없다). 바뀐 Dockerfile 경로(프로젝트 루트 기준)를 돌려준다. 베이스 이미지 계열을 몰라
 * applySystemPackages가 던지면 그대로 올려 호출부가 재시작을 실패로 처리하게 한다(조용히 무시하지 않는다)
 */
export async function syncSystemPackages(project: LoadedProject, services: readonly string[]): Promise<string[]> {
  const wanted = new Set(services);
  const changed: string[] = [];
  for (const [name, service] of project.managed) {
    if (!wanted.has(name)) continue;
    const relative = service.path === '.' ? GENERATED_DOCKERFILE : `${service.path}/${GENERATED_DOCKERFILE}`;
    const dockerfilePath = path.join(project.root, relative);
    const current = await readFile(dockerfilePath, 'utf8').catch(() => undefined);
    if (current === undefined) continue; // b-studio가 만든 Dockerfile이 아니면 건드리지 않는다
    const next = applySystemPackages(current, service.systemPackages ?? []);
    if (next !== current) {
      await writeFile(dockerfilePath, next);
      changed.push(relative);
    }
  }
  return changed;
}
