import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readRegularFileBytesSync } from './workspace';

/**
 * D2 이전 `packages/agent/src/gate.ts`의 평가 자산 지문·훑기·비교를 그대로 옮긴 것(차등 시험 기준값).
 * 시험만 import한다. 지금 구현은 `crates/bstudio-io/src/gate_assets.rs`(훑기)와 `crates/bstudio-guard/src/gate_assets.rs`(판정)가 한다.
 */
const MAX_EVALUATION_ASSET_FILES = 2_000;
const MAX_EVALUATION_ASSET_LIST = 20;

export type LegacyBaseline = { kind: 'ok'; digests: Map<string, string> } | { kind: 'error'; detail: string };

interface EvaluationAssetScan {
  digests: Map<string, string>;
  count: number;
}

function evaluationAssetFailure(stage: string, detail: string): { stage: string; name: string; ok: boolean; attempts: number; detail: string } {
  return { stage, name: 'evaluation-assets', ok: false, attempts: 1, detail };
}

export function legacyDescribeEvaluationAssetChange(changed: readonly string[]): string {
  const shown = changed.slice(0, MAX_EVALUATION_ASSET_LIST);
  const rest = changed.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} 외 ${rest}개` : shown.join(', ');
  return `평가 자산이 바뀌었습니다: ${list}. 평가 자산은 사람이 고칩니다 — 되돌리고 구현을 고치세요. 평가 자산이 틀렸다고 판단하면 그 까닭을 답에 적어 사람에게 알리세요.`;
}

export function legacyEvaluationAssetChecks(
  hasAssets: boolean,
  hasTests: boolean,
  baseline: LegacyBaseline,
  current: LegacyBaseline,
): Array<{ stage: string; name: string; ok: boolean; attempts: number; detail?: string }> {
  if (!hasAssets) return [];
  const stage = hasTests ? 'test' : 'review';
  if (current.kind === 'error') return [evaluationAssetFailure(stage, current.detail)];
  if (baseline.kind === 'error') return [evaluationAssetFailure(stage, baseline.detail)];
  const changed = [...new Set([...baseline.digests.keys(), ...current.digests.keys()])]
    .filter((file) => baseline.digests.get(file) !== current.digests.get(file))
    .sort();
  if (changed.length === 0) return [{ stage, name: 'evaluation-assets', ok: true, attempts: 1 }];
  return [{ stage, name: 'evaluation-assets', ok: false, attempts: 1, detail: legacyDescribeEvaluationAssetChange(changed) }];
}

export async function legacyFingerprintEvaluationAssets(root: string, assets: readonly string[]): Promise<LegacyBaseline> {
  const scan: EvaluationAssetScan = { digests: new Map(), count: 0 };
  for (const asset of assets) {
    const error = await collectEvaluationAsset(root, path.normalize(asset), scan);
    if (error) return { kind: 'error', detail: `${asset}: ${error}` };
  }
  return { kind: 'ok', digests: scan.digests };
}

async function collectEvaluationAsset(root: string, relative: string, scan: EvaluationAssetScan): Promise<string | undefined> {
  if (!parentsAreReal(root, relative)) return '상위 폴더가 심볼릭 링크입니다';
  const absolute = path.join(root, relative);
  const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => error);
  if (info instanceof Error) {
    if (info.code === 'ENOENT' || info.code === 'ENOTDIR') return undefined;
    return `읽을 수 없습니다(${info.code ?? '알 수 없는 오류'})`;
  }
  if (info.isSymbolicLink()) return '심볼릭 링크입니다';
  if (!info.isDirectory()) return recordEvaluationFile(absolute, relative, scan);
  return walkEvaluationAssetDir(absolute, relative, scan);
}

async function walkEvaluationAssetDir(dir: string, relative: string, scan: EvaluationAssetScan): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error);
  if (entries instanceof Error) return `폴더를 읽지 못했습니다(${entries.code ?? '알 수 없는 오류'})`;
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childRelative = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) return `${childRelative}: 심볼릭 링크입니다`;
    if (entry.isDirectory()) {
      const error = await walkEvaluationAssetDir(path.join(dir, entry.name), childRelative, scan);
      if (error) return error;
    } else if (entry.isFile()) {
      const error = recordEvaluationFile(path.join(dir, entry.name), childRelative, scan);
      if (error) return error;
    } else {
      return `${childRelative}: 일반 파일도 폴더도 아닙니다`;
    }
  }
  return undefined;
}

function recordEvaluationFile(absolute: string, relative: string, scan: EvaluationAssetScan): string | undefined {
  scan.count += 1;
  if (scan.count > MAX_EVALUATION_ASSET_FILES) return `파일이 ${MAX_EVALUATION_ASSET_FILES}개를 넘습니다 — 선언을 좁히세요`;
  const read = readRegularFileBytesSync(absolute);
  if (read.kind !== 'bytes') return read.kind === 'irregular' ? read.reason : '파일이 없습니다';
  if (!read.complete) return '읽는 동안 파일이 바뀌었습니다';
  scan.digests.set(relative, createHash('sha256').update(read.content).digest('hex'));
  return undefined;
}

function parentsAreReal(root: string, relative: string): boolean {
  const parent = path.dirname(relative);
  if (parent === '.') return true;
  try {
    return realpathSync(path.join(root, parent)) === path.join(realpathSync(root), parent);
  } catch {
    return true;
  }
}
