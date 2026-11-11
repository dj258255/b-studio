import { createRequire } from 'node:module';

/**
 * Rust로 옮긴 YAML 읽기(crates/bstudio-guard `yaml`, ADR-197). sandbox와 같은 `.node` 파일을 싣는다(spec은 sandbox에 의존할 수 없다: sandbox가 spec에 의존한다).
 * createRequire는 경로를 기준으로 한 번만 실으므로 두 패키지가 같은 모듈을 쓴다. 저장소 루트의 `pnpm build:native`가 만든다.
 *
 * 불러오지 못하면 던진다. JS `yaml`로 대신 읽는 길을 두지 않는다 — 두 구현이 함께 있으면 같은 입력을 다르게 읽는 자리가 생긴다
 */
export interface NativeYaml {
  yamlParse(text: string, merge: boolean): { kind: 'value' | 'syntax' | 'unsupported'; json?: string | null; message?: string | null; line: number; col: number };
}

function load(): NativeYaml {
  try {
    return createRequire(import.meta.url)('../../sandbox/native/bstudio_node.node') as NativeYaml;
  } catch (error) {
    throw new Error(`b-studio 네이티브 모듈을 불러오지 못했습니다. 저장소 루트에서 pnpm build:native 를 실행하세요: ${(error as Error).message}`);
  }
}

export const nativeYaml: NativeYaml = load();
