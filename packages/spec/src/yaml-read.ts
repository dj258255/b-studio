import { nativeYaml } from './native';

/** Rust 읽기 쪽이 `NaN`·`Infinity`·`-0`을 JSON에 담는 표시 객체의 키(crates/bstudio-guard/src/js_json.rs, sandbox의 decodeNative와 같다) */
const NONFINITE_KEY = '\u0000nf';

export class YamlReadError extends Error {
  constructor(
    /** `syntax`: 문법이 올바르지 않음(JS `yaml`도 실패하는 입력 포함), `unsupported`: JS와 다르게 읽을 수 있어 읽지 않는 꼴 */
    readonly kind: 'syntax' | 'unsupported',
    /** 문제 글자를 담지 않는 설명(읽으면 안 되는 파일의 내용이 오류 글로 새지 않게) */
    readonly detail: string,
    /** 1부터. 모르면 0 */
    readonly line: number,
    readonly col: number,
  ) {
    super(detail);
  }

  /** "(3번째 줄 5번째 칸)" 꼴. 위치를 모르면 빈 글자 */
  get where(): string {
    return this.line > 0 ? `(${this.line}번째 줄${this.col > 0 ? ` ${this.col}번째 칸` : ''})` : '';
  }
}

/**
 * YAML 글자를 JS 값으로 읽는다. 성공한 값은 JS `yaml@2.9.0`의 `parse(source)`(merge가 true면 `parse(source, { merge: true })`)와 같다.
 * 문법이 틀렸거나 지원하지 않는 꼴이면 `YamlReadError`를 던진다
 */
export function readYaml(source: string, options?: { merge?: boolean }): unknown {
  const result = nativeYaml.yamlParse(source, options?.merge === true);
  if (result.kind === 'value' && typeof result.json === 'string') {
    return JSON.parse(result.json, (_key, item: unknown) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item) && NONFINITE_KEY in item) return Number((item as Record<string, string>)[NONFINITE_KEY]);
      return item;
    });
  }
  if (result.kind === 'syntax' || result.kind === 'unsupported') throw new YamlReadError(result.kind, result.message ?? '', result.line, result.col);
  throw new Error(`알 수 없는 YAML 읽기 결과입니다: ${String(result.kind)}`);
}
