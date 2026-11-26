import { execFile } from 'node:child_process';

/** 짧게 끝나는 CLI 명령을 한 번 돌려 표준 출력을 돌려준다. 사전 확인과 모델 목록 조회가 쓴다 */
export function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
