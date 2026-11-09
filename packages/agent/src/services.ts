import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
import type { LoadedProject, ManagedServiceSpec } from '@b-studio/spec';

/**
 * 바뀐 파일이 어느 managed 서비스에 속하는지의 판정은 Rust(crates/bstudio-guard/src/services.rs, ADR-191 3단계 3l)가 한다.
 * 이 파일은 타입과 같은 이름·시그니처의 껍데기다. 판정에 필요한 필드(managed의 이름·path·includes, root, composePath)만 골라 넘기고,
 * 돌려받은 위치로 원래 문자열을 꺼낸다.
 */
export interface FileServiceMapping {
  /** 바뀐 파일이 속한 managed 서비스 (중복 없음, studio.yaml 순서) */
  services: string[];
  /** 어느 서비스에도 속하지 않는 파일(어떤 서비스에도 매인 폴더가 아닌 파일) */
  unmatched: string[];
}

/**
 * 바뀐 파일 경로를 보고 다시 띄워야 할 서비스를 고른다.
 * studio.yaml·compose 파일은 특정 서비스 폴더에 속하지 않지만 모든 managed 서비스의 환경 변수·마운트·
 * top-level configs를 결정한다. 둘 중 하나만 재시작하면 나머지는 옛 설정을 그대로 쓰게 되므로(트러블슈팅 74),
 * 바뀌면 managed 서비스를 전부 다시 띄운다.
 *
 * 한 파일이 두 서비스 모두에 속할 수 있다(`path`나 `includes`가 겹치는 경우, 예: 공유 라이브러리 폴더). 첫 번째
 * 소유자만 고르지 않고 겹치는 서비스를 전부 재시작 대상으로 본다 — 재시작을 덜 하는 쪽보다 더 하는 쪽이 안전하다
 * (도그푸딩 마찰 119, ADR-139)
 */
export function servicesForFiles(project: LoadedProject, files: readonly string[]): FileServiceMapping {
  const managed = project.managed.map(([name, service]) => ({ name, path: service.path, includes: service.includes }));
  const input = encodeNative({ managed, root: project.root ?? '', composePath: project.composePath ?? '', cwd: process.cwd(), files });
  const result = decodeNative<{ services: number[]; unmatched: number[] }>(native.servicesForFiles(input));
  return {
    services: result.services.map((index) => managed[index]!.name),
    unmatched: result.unmatched.map((index) => files[index]!),
  };
}

/**
 * 서비스가 이 파일을 소유하는지: 서비스 폴더(`path`) 아래이거나, `includes`로 선언한 폴더 밖 경로 중 하나에
 * 속한다(ADR-139). `uncoveredChangeWarnings`(packages/agent/src/workflow.ts)도 같은 판정을 쓴다 — 매칭 규칙이
 * 두 곳에 따로 있으면 한쪽만 고치고 잊기 쉽다
 */
export function ownsFile(service: Pick<ManagedServiceSpec, 'path' | 'includes'>, file: string): boolean {
  return native.ownsFile(service.path, service.includes ?? [], file);
}

/**
 * 파일이 compose 파일(프로젝트 루트 기준 상대 경로)인지. studio.yaml과 달리 compose 파일은 서비스 선택의
 * 기본값 규칙(ADR-083)이 쓰는 depends_on 그래프를 바꿀 수 있어, 재시작 쪽(verify.ts)이 새로 생긴 부가 서비스를
 * 올릴지 판단할 때 따로 본다(도그푸딩 마찰 138, ADR-146). root·composePath가 없는 project(최소 fixture)는 false다
 */
export function isComposeFile(project: Pick<LoadedProject, 'root' | 'composePath'>, file: string): boolean {
  return native.isComposeFile(project.root ?? '', project.composePath ?? '', process.cwd(), file);
}
