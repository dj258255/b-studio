import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { boardMcpToolSpecs } from '../board-mcp';
import { gatewayToolSpecs } from '../claude-gateway-runner';
import { createOrdersProject } from '../test-helpers';
import { mcpToolName } from './mcp';

/**
 * Code Mode(도구 정의 여러 개 대신 도구 하나와 그 API의 TypeScript 선언을 주고, 모델이 쓴 코드를 격리 실행기에서 도는 방식)의 크기 측정(ADR-228).
 * 토큰 계산기가 없어(오프라인) 글자 수와 UTF-8 바이트를 잰다. 토큰은 바이트/4(영어 JSON의 흔한 어림)에서 바이트/3(한글이 섞인 글) 사이로 어림한 값일 뿐이다.
 * 이 시험은 ADR의 수치를 다시 만드는 길이고, 선언 생성기가 모든 스키마 꼴을 다루는지(모르는 꼴은 던진다)도 본다
 */

type Schema = { type?: string; description?: string; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema };

/** 입력 스키마 → TypeScript 타입 글. 모르는 꼴은 던진다(조용히 any로 두지 않는다) */
function toTs(schema: Schema, indent = ''): string {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `${toTs(schema.items ?? {}, indent)}[]`;
    case 'object': {
      const required = new Set(schema.required ?? []);
      const lines = Object.entries(schema.properties ?? {}).map(([key, value]) => `${indent}  ${value.description ? `/** ${value.description} */ ` : ''}${key}${required.has(key) ? '' : '?'}: ${toTs(value, `${indent}  `)};`);
      return lines.length === 0 ? '{}' : `{\n${lines.join('\n')}\n${indent}}`;
    }
    default:
      throw new Error(`모르는 스키마 꼴: ${JSON.stringify(schema).slice(0, 80)}`);
  }
}

const declarationOf = (specs: Array<{ name: string; description?: string; input_schema: unknown }>): string =>
  `declare const b: {\n${specs.map((spec) => `  /** ${spec.description ?? ''} */\n  ${spec.name}(input: ${toTs(spec.input_schema as Schema, '  ')}): Promise<string>;`).join('\n')}\n};`;

const sizeOf = (text: string) => ({ chars: text.length, bytes: Buffer.byteLength(text) });
const tokens = (bytes: number) => ({ low: Math.round(bytes / 4), high: Math.round(bytes / 3) });

function project(names: string[]): LoadedProject {
  return {
    root: '/tmp/none',
    spec: { name: 'demo' },
    managed: names.map((name, index) => [name, { source: 'managed', template: 'spring-boot', path: name, port: 8080 + index, preview: 'openapi', contract: { extract: '/v3/api-docs' } }]),
  } as unknown as LoadedProject;
}

async function measure(label: string, loaded: LoadedProject) {
  const specs = [...gatewayToolSpecs(loaded), ...boardMcpToolSpecs({ modelWrites: true })] as Array<{ name: string; description?: string; input_schema: unknown }>;
  // 모델이 받는 도구 정의: 이름은 mcp__b-studio__도구, 칸은 이름·설명·입력 스키마
  const definitions = JSON.stringify(specs.map((spec) => ({ name: mcpToolName('b-studio', spec.name), description: spec.description ?? '', input_schema: spec.input_schema })));
  // Code Mode: 도구 하나(코드를 받는다)와 그 설명에 든 API 선언
  const declaration = declarationOf(specs);
  const codeMode = JSON.stringify({
    name: 'run_code',
    description: `TypeScript 코드를 격리 실행기에서 돌린다. 전역 b로 아래 API를 부른다(모두 문자열을 돌려준다). 결과는 console.log로 낸 글만 돌아온다.\n${declaration}`,
    input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  });
  const result = { label, tools: specs.length, definitions: sizeOf(definitions), codeMode: sizeOf(codeMode), declaration: sizeOf(declaration) };
  return result;
}

describe('Code Mode 크기 측정', () => {
  it('b-studio MCP 도구 정의와 Code Mode(도구 하나 + TypeScript 선언)의 크기를 잰다', async () => {
    const results = [await measure('서비스 1개(orders)', await createOrdersProject('code-mode-')), await measure('서비스 3개', project(['api', 'web', 'worker']))];
    for (const result of results) {
      const saved = 1 - result.codeMode.bytes / result.definitions.bytes;
      console.log(
        `[code-mode] ${result.label}: 도구 ${result.tools}개, 정의 ${result.definitions.chars}자/${result.definitions.bytes}B(토큰 어림 ${tokens(result.definitions.bytes).low}~${tokens(result.definitions.bytes).high}), Code Mode ${result.codeMode.chars}자/${result.codeMode.bytes}B(토큰 어림 ${tokens(result.codeMode.bytes).low}~${tokens(result.codeMode.bytes).high}), 줄어든 비율 ${(saved * 100).toFixed(1)}%`,
      );
      // ADR-228이 근거로 삼는 사실: 이 도구 수에서 Code Mode는 정의 크기를 눈에 띄게 줄이지 못한다(TypeScript 선언이 JSON 스키마와 같은 정보를 담는다)
      expect(saved).toBeLessThan(0.3);
    }
  });
});
