import { execFile } from 'node:child_process';
import { promisify, styleText } from 'node:util';
import { DockerDeployer, resolveSecrets, type DeployLog } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { createLabeler, describe, print } from '../ui';

const execFileAsync = promisify(execFile);

export interface DeployCommandOptions {
  status: boolean;
  rollback?: string;
  remove: boolean;
  volumes: boolean;
}

/** 운영 배포. 기본은 지금 폴더의 코드로 새 릴리스를 만든다 */
export async function deploy(project: LoadedProject, options: DeployCommandOptions): Promise<number> {
  const deployer = new DockerDeployer(project, { secrets: await resolveSecrets(project) });
  const label = createLabeler(project);
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const onLog = (log: DeployLog) => {
    const text = log.stage === 'build' && log.service ? styleText('dim', log.text) : log.text;
    print(label(log.service ?? 'deploy'), text);
  };

  try {
    if (options.status) {
      printStatus(await deployer.status());
      return 0;
    }
    if (options.remove) {
      await deployer.remove({ volumes: options.volumes, onLog });
      return 0;
    }
    const started = Date.now();
    const result = options.rollback
      ? await deployer.rollback(options.rollback, { signal: stop.signal, onLog })
      : await deployer.deploy(await describeSource(project.root), { signal: stop.signal, onLog });
    print(label('deploy'), styleText('green', `릴리스 ${result.release.id} 운영 중 (${((Date.now() - started) / 1_000).toFixed(1)}초)`));
    for (const [service, url] of Object.entries(result.urls)) console.log(`  ${service.padEnd(12)} ${url}`);
    return 0;
  } catch (error) {
    print(label('deploy'), styleText('red', `실패: ${describe(error)}`));
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) print(label('deploy'), styleText('dim', detail.trim()));
    return stop.signal.aborted ? 130 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** Git 저장소면 커밋과 커밋하지 않은 변경 여부를, 아니면 폴더 경로를 배포 기록에 남긴다 */
async function describeSource(root: string): Promise<{ label: string; sha?: string }> {
  try {
    const git = (...args: string[]) => execFileAsync('git', ['-C', root, ...args]).then(({ stdout }) => stdout.trim());
    const [sha, subject, dirty] = await Promise.all([git('rev-parse', 'HEAD'), git('log', '-1', '--format=%s'), git('status', '--porcelain', '--', '.')]);
    return { label: `${sha.slice(0, 7)} ${subject}${dirty ? ' (커밋하지 않은 변경 포함)' : ''}`, sha };
  } catch {
    return { label: `폴더 ${root}` };
  }
}

function printStatus({ state, urls, containers }: Awaited<ReturnType<DockerDeployer['status']>>): void {
  if (!state.active) console.log('운영 중인 릴리스가 없습니다');
  for (const [service, url] of Object.entries(urls)) console.log(`  ${service.padEnd(12)} ${url}`);
  for (const container of containers) console.log(`  ${container.name.padEnd(40)} ${container.state}`);
  console.log();
  for (const release of state.releases) {
    const marker = release.id === state.active ? '*' : ' ';
    console.log(`${marker} ${release.id}  ${release.status.padEnd(8)} ${release.source.label}${release.error ? `  (${release.error})` : ''}`);
    if (release.errorDetail) for (const line of release.errorDetail.split('\n').slice(-5)) console.log(`      ${line}`);
  }
}
