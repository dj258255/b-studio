import { decodeNative, encodeNative, native } from '@b-studio/sandbox';

/**
 * 두 OpenAPI 문서를 견주는 판정은 Rust(crates/bstudio-guard/src/contract_diff.rs, ADR-191 3단계 3e)가 한다.
 * 여기는 타입 선언과, 값을 JSON으로 건네고 받는 껍데기다. 모양이 어긋난 문서면 던진다(검증은 그 서비스를 "계약 추출 실패"로 알린다)
 */

/** 비교에 필요한 만큼만 정의한 OpenAPI 문서 형태 */
export interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, SchemaObject> };
}

interface SchemaObject {
  type?: string | string[];
  $ref?: string;
  format?: string;
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  required?: string[];
}

export type ContractChangeKind =
  | 'operation-added'
  | 'operation-removed'
  | 'schema-added'
  | 'schema-removed'
  | 'property-added'
  | 'property-removed'
  | 'property-type-changed'
  | 'property-became-required';

export interface ContractChange {
  kind: ContractChangeKind;
  /** `GET /api/orders` 또는 `Order.memo` */
  target: string;
  /** 기존 클라이언트를 깨뜨릴 수 있는 변경인지 */
  breaking: boolean;
  detail?: string;
}

/**
 * 실행 중인 서버에서 추출한 두 OpenAPI 문서를 비교한다.
 * 에이전트가 "필드 추가"를 요청받고 필드를 지우거나 타입을 바꾸면 검증 단계에서 드러나게 하는 것이 목적이다.
 */
export function diffContracts(before: OpenApiDocument | undefined, after: OpenApiDocument): ContractChange[] {
  return decodeNative<ContractChange[]>(native.diffContracts(encodeNative(before ?? null), encodeNative(after)));
}

/** 에이전트에게 보여줄 계약 요약. 원본 JSON보다 훨씬 짧다 */
export function summarizeContract(document: OpenApiDocument): string {
  return native.summarizeContract(encodeNative(document));
}

export function formatContractChanges(changes: readonly ContractChange[]): string {
  return native.formatContractChanges(encodeNative(changes));
}
