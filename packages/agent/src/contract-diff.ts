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

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * 실행 중인 서버에서 추출한 두 OpenAPI 문서를 비교한다.
 * 에이전트가 "필드 추가"를 요청받고 필드를 지우거나 타입을 바꾸면 검증 단계에서 드러나게 하는 것이 목적이다.
 */
export function diffContracts(before: OpenApiDocument | undefined, after: OpenApiDocument): ContractChange[] {
  const changes: ContractChange[] = [];

  const beforeOps = operations(before);
  const afterOps = operations(after);
  for (const op of afterOps) if (!beforeOps.has(op)) changes.push({ kind: 'operation-added', target: op, breaking: false });
  for (const op of beforeOps) if (!afterOps.has(op)) changes.push({ kind: 'operation-removed', target: op, breaking: true });

  const beforeSchemas = before?.components?.schemas ?? {};
  const afterSchemas = after.components?.schemas ?? {};

  for (const name of Object.keys(afterSchemas)) {
    if (!(name in beforeSchemas)) changes.push({ kind: 'schema-added', target: name, breaking: false });
  }
  for (const [name, previous] of Object.entries(beforeSchemas)) {
    const next = afterSchemas[name];
    if (!next) {
      changes.push({ kind: 'schema-removed', target: name, breaking: true });
      continue;
    }
    changes.push(...diffProperties(name, previous, next));
  }

  // 로케일에 따라 순서가 바뀌지 않도록 코드포인트 순으로 정렬한다
  return changes.sort((a, b) => Number(b.breaking) - Number(a.breaking) || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

function diffProperties(schema: string, previous: SchemaObject, next: SchemaObject): ContractChange[] {
  const changes: ContractChange[] = [];
  const beforeProps = previous.properties ?? {};
  const afterProps = next.properties ?? {};
  const beforeRequired = new Set(previous.required ?? []);
  const afterRequired = new Set(next.required ?? []);

  for (const [prop, definition] of Object.entries(afterProps)) {
    const target = `${schema}.${prop}`;
    const old = beforeProps[prop];
    if (!old) {
      // 새 필드가 처음부터 필수면 기존 요청 본문이 거부될 수 있다
      const required = afterRequired.has(prop);
      changes.push({ kind: 'property-added', target, breaking: required, detail: describeType(definition) + (required ? ', required' : '') });
      continue;
    }
    const oldType = describeType(old);
    const newType = describeType(definition);
    if (oldType !== newType) {
      changes.push({ kind: 'property-type-changed', target, breaking: true, detail: `${oldType} → ${newType}` });
    }
    if (!beforeRequired.has(prop) && afterRequired.has(prop)) {
      changes.push({ kind: 'property-became-required', target, breaking: true });
    }
  }
  for (const prop of Object.keys(beforeProps)) {
    if (!(prop in afterProps)) changes.push({ kind: 'property-removed', target: `${schema}.${prop}`, breaking: true });
  }
  return changes;
}

function operations(document: OpenApiDocument | undefined): Set<string> {
  const result = new Set<string>();
  for (const [route, item] of Object.entries(document?.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toLowerCase())) result.add(`${method.toUpperCase()} ${route}`);
    }
  }
  return result;
}

function describeType(schema: SchemaObject): string {
  if (schema.$ref) return schema.$ref.split('/').at(-1) ?? schema.$ref;
  const type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== 'null').join('|') : (schema.type ?? 'any');
  if (type === 'array' && schema.items) return `${describeType(schema.items)}[]`;
  return schema.format ? `${type}(${schema.format})` : type;
}

/** 에이전트에게 보여줄 계약 요약. 원본 JSON보다 훨씬 짧다 */
export function summarizeContract(document: OpenApiDocument): string {
  const ops = [...operations(document)].sort();
  const schemas = Object.entries(document.components?.schemas ?? {}).map(([name, schema]) => {
    const required = new Set(schema.required ?? []);
    const props = Object.entries(schema.properties ?? {})
      .map(([prop, definition]) => `${prop}${required.has(prop) ? '' : '?'}: ${describeType(definition)}`)
      .join(', ');
    return `${name} { ${props} }`;
  });
  return ['operations:', ...ops.map((op) => `  ${op}`), 'schemas:', ...schemas.map((line) => `  ${line}`)].join('\n');
}

export function formatContractChanges(changes: readonly ContractChange[]): string {
  if (changes.length === 0) return '계약 변경 없음';
  return changes
    .map((change) => `${change.breaking ? '⚠️ 호환 깨짐' : '＋'} ${change.kind} ${change.target}${change.detail ? ` (${change.detail})` : ''}`)
    .join('\n');
}
