import { describe, expect, it } from 'vitest';
import { diffContracts, formatContractChanges, type OpenApiDocument } from './contract-diff';

const before: OpenApiDocument = {
  paths: {
    '/api/orders': { get: {}, post: {} },
    '/api/orders/{id}': { get: {}, parameters: [] },
  },
  components: {
    schemas: {
      Order: {
        type: 'object',
        properties: { id: { type: 'integer', format: 'int64' }, status: { type: 'string' }, total: { type: 'integer' } },
        required: ['status'],
      },
      Legacy: { type: 'object' },
    },
  },
};

describe('diffContracts', () => {
  it('선택 필드 추가는 호환을 깨지 않는다', () => {
    const after = structuredClone(before);
    after.components!.schemas!.Order!.properties!.memo = { type: ['string', 'null'] };

    expect(diffContracts(before, after)).toEqual([
      { kind: 'property-added', target: 'Order.memo', breaking: false, detail: 'string' },
    ]);
  });

  it('삭제, 타입 변경, 필수화, 엔드포인트 삭제를 호환 깨짐으로 표시하고 먼저 보여준다', () => {
    const after = structuredClone(before);
    const order = after.components!.schemas!.Order!;
    delete order.properties!.total;
    order.properties!.status = { $ref: '#/components/schemas/OrderStatus' };
    order.properties!.id = { type: 'integer', format: 'int64' };
    order.required = ['status', 'id'];
    delete after.paths!['/api/orders/{id}'];
    delete after.components!.schemas!.Legacy;
    after.paths!['/api/orders']!.delete = {};

    const changes = diffContracts(before, after);
    expect(changes.map((c) => [c.kind, c.target, c.breaking])).toEqual([
      ['operation-removed', 'GET /api/orders/{id}', true],
      ['schema-removed', 'Legacy', true],
      ['property-became-required', 'Order.id', true],
      ['property-type-changed', 'Order.status', true],
      ['property-removed', 'Order.total', true],
      ['operation-added', 'DELETE /api/orders', false],
    ]);
  });

  it('이전 계약이 없으면 전부 추가로 본다', () => {
    const changes = diffContracts(undefined, before);
    expect(changes.every((c) => !c.breaking)).toBe(true);
    expect(changes.filter((c) => c.kind === 'operation-added')).toHaveLength(3);
  });

  it('사람이 읽을 수 있게 요약한다', () => {
    expect(formatContractChanges([])).toBe('계약 변경 없음');
    expect(formatContractChanges([{ kind: 'property-removed', target: 'Order.total', breaking: true }])).toBe(
      '⚠️ 호환 깨짐 property-removed Order.total',
    );
  });
});
