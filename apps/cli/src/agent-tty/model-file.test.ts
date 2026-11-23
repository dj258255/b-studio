import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadModelFile, modelFilePath, ModelFileError } from './model-file';

const profile = {
  id: 'p',
  provider: 'openai',
  model: 'm',
  label: 'P',
  capabilities: ['tools'],
  contextWindow: 32000,
  pricing: { inputPerMillion: 1, outputPerMillion: 2 },
  baselineQuality: 0.8,
  baselineLatencyMs: 100,
  baseUrl: 'http://127.0.0.1:1/v1',
};

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'model-file-'));
  file = path.join(dir, 'agent-model.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(content: unknown, mode = 0o600) {
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  chmodSync(file, mode);
}

describe('모델 파일', () => {
  it('설정 파일과 같은 폴더의 agent-model.json을 가리킨다', () => {
    expect(modelFilePath(path.join(dir, 'settings.json'))).toBe(file);
  });

  it('링크면 600의 올바른 파일을 가리켜도 거절한다(확인한 대상과 읽는 대상이 갈리지 않게)', () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, JSON.stringify({ profile, apiKey: 'k' }));
    chmodSync(real, 0o600);
    symlinkSync(real, file);
    expect(() => loadModelFile(file)).toThrow(/링크/);
  });

  it('FIFO면 열다가 멈추지 않고 거절한다', () => {
    execFileSync('mkfifo', ['-m', '600', file]);
    // 열기가 멈추면 이벤트 루프째 막혀 시험의 시간 상한도 걸리지 않는다. 자식 프로세스에서 상한을 두고 돌린다
    const loader = fileURLToPath(import.meta.resolve('tsx'));
    const script = `import { loadModelFile } from ${JSON.stringify(fileURLToPath(new URL('./model-file.ts', import.meta.url)))};
try { loadModelFile(${JSON.stringify(file)}); console.log('읽음'); } catch (error) { console.log(error.message); }`;
    const out = execFileSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    expect(out).toMatch(/일반 파일이 아닙니다/);
  });

  it('키 없는 anthropic 설정은 거절한다(SDK가 환경 변수의 키로 대신하지 않게)', () => {
    write({ profile: { ...profile, provider: 'anthropic', baseUrl: undefined } });
    expect(() => loadModelFile(file)).toThrow(/apiKey가 필요합니다/);
  });

  it('없으면 거절한다', () => {
    expect(() => loadModelFile(file)).toThrow(ModelFileError);
  });

  it('그룹·다른 사용자 권한이 있으면 거절한다', () => {
    write({ profile, apiKey: 'k' }, 0o644);
    expect(() => loadModelFile(file)).toThrow(/권한이 600이 아닙니다/);
    write({ profile, apiKey: 'k' }, 0o640);
    expect(() => loadModelFile(file)).toThrow(/권한이 600이 아닙니다/);
  });

  it('JSON이 아니면 거절한다', () => {
    write('{not json');
    expect(() => loadModelFile(file)).toThrow(/JSON/);
  });

  it('모델 설정이 올바르지 않으면 거절한다', () => {
    write({ profile: { ...profile, provider: 'nope' } });
    expect(() => loadModelFile(file)).toThrow(/모델 설정이 올바르지 않습니다/);
    write({});
    expect(() => loadModelFile(file)).toThrow(ModelFileError);
  });

  it('올바르면 설정과 키가 든 env를 돌려주고, 키는 설정 객체에 없다', () => {
    write({ profile, apiKey: 'sk-secret' });
    const loaded = loadModelFile(file);
    expect(loaded.profile.id).toBe('p');
    expect(loaded.env).toEqual({ OPENAI_API_KEY: 'sk-secret' });
    expect(JSON.stringify(loaded.profile)).not.toContain('sk-secret');
    write({ profile: { ...profile, apiKeyEnv: 'MY_KEY' }, apiKey: 'sk-2' });
    expect(loadModelFile(file).env).toEqual({ MY_KEY: 'sk-2' });
  });
});
