import { readFileSync } from 'node:fs';
import { apiKeyEnvName, clientForProfile, parseInteractiveArgs, runInteractiveSession } from '@b-studio/agent';
import { loadModelFile, modelFilePath, ModelFileError } from './agent-tty/model-file';

/**
 * API 모드의 자체 에이전트 CLI 진입점(ADR-225). claude CLI와 같은 인자로 불리고, 모델은 `--settings` 파일 옆의
 * agent-model.json에서 읽는다. 모델 파일을 읽지 못하면 세션을 시작하지 않고 사유를 stderr에 적고 1로 끝난다
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(`${version} (b-studio agent)\n`);
    return 0;
  }
  const { settingsFile } = parseInteractiveArgs(args);
  if (!settingsFile) {
    process.stderr.write('--settings 파일이 필요합니다(모델 파일을 그 폴더에서 찾습니다)\n');
    return 1;
  }
  let loaded;
  try {
    loaded = loadModelFile(modelFilePath(settingsFile));
  } catch (error) {
    if (!(error instanceof ModelFileError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const abort = new AbortController();
  for (const name of ['SIGTERM', 'SIGHUP'] as const) process.once(name, () => abort.abort());
  await runInteractiveSession({
    args,
    cwd: process.cwd(),
    client: clientForProfile(loaded.profile, { env: loaded.env }),
    stdin: process.stdin,
    stdout: process.stdout,
    pricing: loaded.profile.pricing,
    signal: abort.signal,
    scrubEnvNames: [apiKeyEnvName(loaded.profile)],
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
