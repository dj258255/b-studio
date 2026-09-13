import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ModelObservation } from '@b-studio/agent';

const LIMIT = 5_000;

export function observations(): ModelObservation[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(/* turbopackIgnore: true */ filePath(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(valid).slice(-LIMIT);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.error('[b-studio] 모델 실측 기록을 읽지 못했습니다', error);
    return [];
  }
}

export function recordObservation(observation: ModelObservation): void {
  if (!valid(observation)) throw new Error('모델 실측값이 올바르지 않습니다');
  const file = filePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = [...observations(), observation].slice(-LIMIT);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

function filePath(): string {
  return path.resolve(
    /* turbopackIgnore: true */ process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE ?? path.join(homedir(), '.cache', 'b-studio', 'model-observations.json'),
  );
}

function valid(value: unknown): value is ModelObservation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ModelObservation>;
  return (
    typeof item.modelId === 'string' &&
    typeof item.passed === 'boolean' &&
    typeof item.latencyMs === 'number' &&
    Number.isFinite(item.latencyMs) &&
    item.latencyMs >= 0 &&
    (item.costUsd === undefined || (typeof item.costUsd === 'number' && Number.isFinite(item.costUsd) && item.costUsd >= 0))
  );
}
