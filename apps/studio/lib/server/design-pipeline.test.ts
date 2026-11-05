import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake: { workDir?: string; status: 'ready' | 'idle'; owner?: string; modelId?: string; backend?: string } = { status: 'ready' };

const mocks = vi.hoisted(() => ({ commitWorkingCopyDocs: vi.fn(async () => undefined) }));
vi.mock('./sessions', () => ({
  getSnapshot: vi.fn((id: string) => (id === 'missing' ? undefined : { id, workDir: fake.workDir, status: fake.status, owner: fake.owner, modelId: fake.modelId })),
  commitWorkingCopyDocs: mocks.commitWorkingCopyDocs,
  sessionBackend: vi.fn(() => (fake.backend ?? 'api') as never),
}));

import { assertDesignApprovedForRequest } from './design-pipeline';

const SESSION_ID = 's1';

describe('design-pipeline', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'b-studio-design-pipeline-'));
    fake.workDir = workDir;
    fake.status = 'ready';
    mocks.commitWorkingCopyDocs.mockClear();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('assertDesignApprovedForRequest — 서버 강제 승인 게이트', () => {
    it('그 요구사항을 다루는 설계 문서가 없으면 통과한다(옵트인)', async () => {
      await expect(assertDesignApprovedForRequest(SESSION_ID, '[R9] 아무 요청')).resolves.toBeUndefined();
    });

  });
});
