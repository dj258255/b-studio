import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_APPROVAL_REQUIRED_MESSAGE } from '@b-studio/agent';

const fake: { workDir?: string; status: 'ready' | 'idle'; owner?: string; modelId?: string; backend?: string } = { status: 'ready' };

const mocks = vi.hoisted(() => ({ commitWorkingCopyDocs: vi.fn(async () => undefined) }));
vi.mock('./sessions', () => ({
  getSnapshot: vi.fn((id: string) => (id === 'missing' ? undefined : { id, workDir: fake.workDir, status: fake.status, owner: fake.owner, modelId: fake.modelId })),
  commitWorkingCopyDocs: mocks.commitWorkingCopyDocs,
  sessionBackend: vi.fn(() => (fake.backend ?? 'api') as never),
}));

import { approveSessionDesignDoc, assertDesignApprovedForRequest, listSessionDesignDocs, saveSessionDesignDoc } from './design-pipeline';
import { StudioError } from './errors';

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

  const BODY = `# 설계

## 작업 묶음

| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |
| --- | --- | --- | --- | --- |
| B1 입력 폼 | 버튼이 눌린다 | 30-60 | 폼 | apps/studio/components/x.tsx |
`;

  describe('saveSessionDesignDoc · listSessionDesignDocs', () => {
    it('초안으로 설계 문서를 만들고 사이드카를 함께 남긴다', async () => {
      const record = await saveSessionDesignDoc(SESSION_ID, { title: '채팅 입력', body: BODY, requirementIds: ['R1'], createdBy: 'me' });
      expect(record.status).toBe('draft');
      expect(record.path).toBe('docs/design/01-채팅-입력.md');
      expect(record.bundles).toHaveLength(1);
      expect(mocks.commitWorkingCopyDocs).toHaveBeenCalledOnce();

      const docs = await listSessionDesignDocs(SESSION_ID);
      expect(docs).toHaveLength(1);
      expect(docs[0]?.requirementIds).toEqual(['R1']);
    });

    it('요구사항 id를 명시하지 않으면 본문에서 스스로 찾는다', async () => {
      const record = await saveSessionDesignDoc(SESSION_ID, { title: '결제', body: `R3을 다룹니다\n\n${BODY}`, createdBy: 'me' });
      expect(record.requirementIds).toEqual(['R3']);
    });

    it('샌드박스가 준비되지 않았으면 만들 수 없다', async () => {
      fake.status = 'idle';
      await expect(saveSessionDesignDoc(SESSION_ID, { title: 'x', body: 'y', createdBy: 'me' })).rejects.toThrow(StudioError);
    });
  });

  describe('approveSessionDesignDoc', () => {
    it('초안을 승인하면 상태가 바뀌고 다시 커밋한다', async () => {
      const created = await saveSessionDesignDoc(SESSION_ID, { title: '채팅 입력', body: BODY, requirementIds: ['R1'], createdBy: 'me' });
      mocks.commitWorkingCopyDocs.mockClear();
      const approved = await approveSessionDesignDoc(SESSION_ID, created.path, 'owner');
      expect(approved.status).toBe('approved');
      expect(approved.approvedBy).toBe('owner');
      expect(mocks.commitWorkingCopyDocs).toHaveBeenCalledOnce();
    });

    it('이미 승인된 설계를 다시 승인하면 409', async () => {
      const created = await saveSessionDesignDoc(SESSION_ID, { title: '채팅 입력', body: BODY, createdBy: 'me' });
      await approveSessionDesignDoc(SESSION_ID, created.path, 'owner');
      await expect(approveSessionDesignDoc(SESSION_ID, created.path, 'owner')).rejects.toThrow(StudioError);
    });

    it('없는 설계 문서는 404', async () => {
      await expect(approveSessionDesignDoc(SESSION_ID, 'docs/design/99-없음.md', 'owner')).rejects.toThrow(StudioError);
    });
  });

  describe('assertDesignApprovedForRequest — 서버 강제 승인 게이트', () => {
    it('그 요구사항을 다루는 설계 문서가 없으면 통과한다(옵트인)', async () => {
      await expect(assertDesignApprovedForRequest(SESSION_ID, '[R9] 아무 요청')).resolves.toBeUndefined();
    });

    it('승인되지 않은 설계가 다루는 요구사항이면 409 "설계 승인 전에는 구현을 시작할 수 없습니다"', async () => {
      await saveSessionDesignDoc(SESSION_ID, { title: '채팅 입력', body: BODY, requirementIds: ['R1'], createdBy: 'me' });
      await expect(assertDesignApprovedForRequest(SESSION_ID, '[R1] 채팅 입력을 구현해 주세요')).rejects.toThrow(DESIGN_APPROVAL_REQUIRED_MESSAGE);
    });

    it('승인된 뒤에는 통과한다', async () => {
      const created = await saveSessionDesignDoc(SESSION_ID, { title: '채팅 입력', body: BODY, requirementIds: ['R1'], createdBy: 'me' });
      await approveSessionDesignDoc(SESSION_ID, created.path, 'owner');
      await expect(assertDesignApprovedForRequest(SESSION_ID, '[R1] 채팅 입력을 구현해 주세요')).resolves.toBeUndefined();
    });

    it('요청에 요구사항 id가 없으면 통과한다', async () => {
      await saveSessionDesignDoc(SESSION_ID, { title: '채팅 입력', body: BODY, requirementIds: ['R1'], createdBy: 'me' });
      await expect(assertDesignApprovedForRequest(SESSION_ID, '그냥 아무거나 고쳐줘')).resolves.toBeUndefined();
    });
  });
});
