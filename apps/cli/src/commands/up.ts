import type { LoadedProject } from '@b-studio/spec';
import { runSandboxSession } from '../session';
import { print } from '../ui';

/** 샌드박스를 띄우고 Ctrl+C까지 로그를 보여준다 */
export function up(project: LoadedProject, { keep }: { keep: boolean }): Promise<number> {
  return runSandboxSession(project, { keep, followLogs: true }, async ({ signal, label }) => {
    print(label('studio'), 'Ctrl+C로 종료합니다');
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    return 130;
  });
}
