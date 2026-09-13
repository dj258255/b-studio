import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observations, recordObservation } from './model-observations';

const original = process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE;
const directories: string[] = [];

afterEach(() => {
  if (original === undefined) delete process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE;
  else process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE = original;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function isolatedFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'b-studio-observations-'));
  directories.push(directory);
  const file = path.join(directory, 'observations.json');
  process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE = file;
  return file;
}

describe('model observations', () => {
  it('가격을 알 수 없는 실행도 품질과 지연 실측으로 보존한다', () => {
    const file = isolatedFile();
    recordObservation({ modelId: 'claude', passed: true, latencyMs: 1234 });

    expect(observations()).toEqual([{ modelId: 'claude', passed: true, latencyMs: 1234 }]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it('손상되거나 음수인 행은 라우팅 학습에서 제외한다', () => {
    const file = isolatedFile();
    writeFileSync(
      file,
      JSON.stringify([
        { modelId: 'good', passed: false, latencyMs: 500, costUsd: 0.01 },
        { modelId: 'bad-latency', passed: true, latencyMs: -1, costUsd: 0.01 },
        { modelId: 'bad-cost', passed: true, latencyMs: 100, costUsd: -1 },
      ]),
    );

    expect(observations()).toEqual([{ modelId: 'good', passed: false, latencyMs: 500, costUsd: 0.01 }]);
  });
});
