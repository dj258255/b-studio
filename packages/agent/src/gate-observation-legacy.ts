import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserPageStep } from './browser-check';
import { compareScreenshot, VisualCompareError, type CompareResult } from './visual-compare';
import type { WorkflowPageCompare } from '@b-studio/spec';

/**
 * D2 이전 `packages/agent/src/gate.ts`의 `#saveSteps`·`#compareDesign`(읽기·비교 부분)·`#serviceOrigins`를 그대로 옮긴 것(차등 시험 기준값).
 * 시험만 import한다. 지금 구현은 `crates/bstudio-io/src/gate_assets.rs`가 한다.
 */
export async function legacySaveSteps(
  name: string,
  steps: readonly BrowserPageStep[],
  save?: (input: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }) => Promise<string>,
): Promise<Array<{ label: string; ok: boolean; detail?: string; artifact?: string }>> {
  const saved: Array<{ label: string; ok: boolean; detail?: string; artifact?: string }> = [];
  for (const [index, step] of steps.entries()) {
    let artifact: string | undefined;
    if (save && step.screenshot) {
      try {
        artifact = await save({ name: `${name} ${index + 1}. ${step.label}`, data: step.screenshot, contentType: 'image/png' });
      } catch (error) {
        console.warn(`화면 확인 스크린샷을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    saved.push({ label: step.label, ok: step.ok, ...(step.detail !== undefined ? { detail: step.detail } : {}), ...(artifact ? { artifact } : {}) });
  }
  return saved;
}

export async function legacyCompareDesign(
  root: string,
  compare: WorkflowPageCompare,
  actual: Buffer | undefined,
  redact: (text: string) => string,
): Promise<CompareResult> {
  if (!actual) throw new Error('디자인 비교에 쓸 뷰포트 스크린샷을 찍지 못했습니다');
  const reference = await readFile(path.join(root, compare.reference)).catch(() => undefined);
  if (!reference) throw new Error(`디자인 기준 이미지를 읽지 못했습니다: ${compare.reference}`);
  try {
    return compareScreenshot({ actual, reference, masks: compare.masks, threshold: compare.threshold });
  } catch (error) {
    // 비교 자체가 성립하지 않는 경우(너비 불일치)는 원인을 그대로 알린다
    if (error instanceof VisualCompareError) throw new Error(redact(error.message));
    throw error;
  }
}

export async function legacyServiceOrigins(
  names: readonly string[],
  skipped: ReadonlySet<string>,
  endpoint: (name: string) => Promise<{ url: string }>,
): Promise<string[]> {
  const origins = new Set<string>();
  for (const name of names) {
    if (skipped.has(name)) continue;
    try {
      origins.add(new URL((await endpoint(name)).url).origin);
    } catch {
      // 아직 준비되지 않았거나 없는 서비스의 주소는 건너뛴다
    }
  }
  return [...origins];
}
