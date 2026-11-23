import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as current from './gate-workflow';

/**
 * 게이트가 끝에 다시 읽는 요구사항 문서 자리(링크·폴더·큰 파일)를 읽지 못하면 통과가 아니라 실패인지 본다(Rust `bstudio-io::gate_workflow`).
 * 옛 TS 사본과 견주던 시험(`gate-workflow-differential.test.ts`)에서 사본과 무관한 확인만 남겼다(#1347).
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gate-workflow-scn-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function file(relative: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

const REQUIREMENT = (extra: string) => `# 요구사항

## R1. 제목
- 종류: api · 우선순위: must
- 인수 조건:
  - a
${extra}- 상태: 미착수
`;
const MANUAL = '- 확인: 범수 · 2026-10-01 · 체크포인트 abc1234 · 메모 화면에서 확인\n';
const MANUAL_CHANGED = '- 확인: 다른사람 · 2026-10-02 · 체크포인트 def5678 · 메모 고침\n';

describe('gate-workflow: 요구사항 문서 자리를 읽지 못하면 실패다', () => {
  it('요구사항 문서 자리가 링크·폴더·큰 파일이면 실패한다(통과 아님)', async () => {
    const expectFailure = async (label: string) => {
      const right = await current.requirementRecordChecks(root, { kind: 'missing' });
      expect(right, label).toMatchObject([{ stage: 'review', name: 'manual-verification', ok: false, attempts: 1 }]);
      expect(right[0]?.detail, label).toContain('일반 파일로 되돌리세요');
    };
    await file('real.md', REQUIREMENT(MANUAL));
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await symlink(path.join(root, 'real.md'), path.join(root, 'docs/requirements.md'));
    await expectFailure('symlink');

    await rm(path.join(root, 'docs/requirements.md'));
    await mkdir(path.join(root, 'docs/requirements.md'));
    await expectFailure('directory');

    await rm(path.join(root, 'docs/requirements.md'), { recursive: true });
    await file('docs/requirements.md', 'x'.repeat(256 * 1024 + 1));
    await expectFailure('too large');
  });
});
