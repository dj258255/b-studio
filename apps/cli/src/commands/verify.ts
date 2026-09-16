import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify, styleText } from 'node:util';
import { fetchContract, VerificationGate, Workspace, type AgentEvent } from '@b-studio/agent';
import type { LoadedProject } from '@b-studio/spec';
import { runSandboxSession } from '../session';
import { createLabeler, describe, print, type Label } from '../ui';

const execFileAsync = promisify(execFile);

export interface VerifyCommandOptions {
  keep: boolean;
  logs: boolean;
  allowBreaking: boolean;
}

/** 현재 작업 트리의 변경을 에이전트와 같은 검증 게이트로 확인한다. 체크포인트는 만들지 않는다 */
export async function verify(project: LoadedProject, options: VerifyCommandOptions): Promise<number> {
  const label = createLabeler(project);

  let files: string[];
  try {
    files = await changedFiles(project.root);
  } catch (error) {
    print(label('studio'), styleText('red', `Git 변경을 읽지 못했습니다: ${describe(error)}`));
    return 2;
  }

  if (files.length === 0) {
    print(label('studio'), '검증할 변경이 없습니다 (게이트를 돌리지 않았습니다)');
    return 3;
  }

  const workspace = new Workspace(project.root);
  const tracked = trackFiles(workspace, files, label);
  if (tracked === 0) {
    print(label('studio'), '검증할 변경이 없습니다 (게이트를 돌리지 않았습니다)');
    return 3;
  }
  print(label('studio'), `검증할 변경 파일 ${tracked}개를 에이전트와 같은 게이트로 확인합니다`);
  print(label('studio'), styleText('dim', '계약 비교 기준은 현재 코드입니다. 편집기에서 이미 깬 계약은 이 명령으로 잡지 못합니다'));

  return runSandboxSession(project, { keep: options.keep, followLogs: options.logs }, async ({ sandbox, signal, label }) => {
    const gate = await VerificationGate.create({
      project,
      sandbox,
      workspace,
      allowBreaking: options.allowBreaking,
      maxVerifyAttempts: 1,
      fetcher: fetchContract,
      signal,
      onEvent: printVerifyEvent(label),
    });

    const outcome = await gate.check();
    if (outcome.kind === 'pass') {
      print(label('studio'), styleText('green', '검증 게이트를 통과했습니다'));
      return 0;
    }
    print(label('studio'), styleText('red', '검증 게이트를 통과하지 못했습니다'));
    print(label('studio'), 'feedback' in outcome ? outcome.feedback : outcome.summary);
    return 1;
  });
}

/** 바깥 변경을 하나씩 작업 공간에 알린다. 거부된 경로는 건너뛰고 이유를 출력한다 */
function trackFiles(workspace: Workspace, files: readonly string[], label: Label): number {
  let tracked = 0;
  for (const file of files) {
    if (file.endsWith('/')) {
      print(label('studio'), styleText('yellow', `건너뛴 경로: ${file} (폴더는 검증 대상이 아닙니다)`));
      continue;
    }
    try {
      workspace.trackExternalChanges([file]);
      tracked += 1;
    } catch (error) {
      print(label('studio'), styleText('yellow', `건너뛴 경로: ${file} (${describe(error)})`));
    }
  }
  return tracked;
}

/** Git이 보는 현재 작업 트리 변경을 프로젝트 루트 기준 상대 경로로 모은다 */
export async function changedFiles(root: string): Promise<string[]> {
  const git = (...args: string[]) => execFileAsync('git', ['-C', root, ...args]).then(({ stdout }) => stdout);
  // -uall: 추적하지 않는 폴더를 한 항목으로 접지 않고 안의 파일을 하나씩 준다. 폴더 경로를 파일로 넘기면 게이트가 EISDIR로 죽는다
  const [status, toplevel] = await Promise.all([git('status', '--porcelain=v1', '-uall', '-z'), git('rev-parse', '--show-toplevel')]);

  // git rev-parse는 물리 경로를 주므로, 링크를 풀지 않는 resolve와 비교하면 macOS /tmp → /private/tmp 같은 경우 전부 걸러진다
  const [projectRoot, repoRoot] = await Promise.all([realpath(root), realpath(toplevel.trim())]);
  const files = new Set<string>();
  for (const gitPath of parsePorcelain(status)) {
    // git status는 저장소 루트 기준이므로, 프로젝트가 하위 폴더면 프로젝트 밖 경로를 걸러 낸다
    const absolute = path.resolve(repoRoot, gitPath);
    if (!isInside(projectRoot, absolute)) continue;
    files.add(path.relative(projectRoot, absolute).split(path.sep).join('/'));
  }
  return [...files].sort();
}

/** `git status --porcelain=v1 -z` 출력에서 경로만 뽑는다. 이름이 바뀐 항목은 옛 경로와 새 경로를 모두 넣는다 */
function parsePorcelain(output: string): string[] {
  const fields = output.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // 이름 바뀜·복사는 다음 필드가 원래 경로다 (추적하지 않는 새 파일도 있으므로 둘 다 넣는다)
    if (status.includes('R') || status.includes('C')) {
      const original = fields[i + 1];
      if (original) {
        paths.push(original);
        i += 1;
      }
    }
  }
  return paths;
}

function printVerifyEvent(label: Label) {
  return (event: AgentEvent) => {
    switch (event.type) {
      case 'stage':
        print(label('studio'), styleText('dim', `작업 단계 · ${stageLabel(event.stage)}`));
        break;
      case 'verify_start':
        print(label('studio'), `검증 게이트: 파일 ${event.files.length}개 → 서비스 재시작, 준비 판정, 계약 비교`);
        break;
      case 'verify_result':
        print(label('studio'), styleText(event.report.ok ? 'green' : 'red', event.text));
        break;
      case 'workflow_check':
        print(
          label('studio'),
          styleText(event.check.ok ? 'green' : 'red', `${stageLabel(event.check.stage)} · ${event.check.name} · ${event.check.ok ? '통과' : '실패'}${event.check.attempts > 1 ? ` (시도 ${event.check.attempts}회)` : ''}`),
        );
        if (!event.check.ok && event.check.detail) print(label('studio'), styleText('dim', event.check.detail.split('\n').slice(0, 8).join('\n')));
        break;
    }
  };
}

function stageLabel(stage: string): string {
  return (
    {
      plan: '계획',
      implement: '구현',
      run: '실행',
      browser_check: '브라우저 확인',
      contract_check: 'API 계약 확인',
      test: '테스트',
      review: '리뷰',
      checkpoint: '체크포인트',
    } as Record<string, string>
  )[stage] ?? stage;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
