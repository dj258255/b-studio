import type { Sandbox, StartOptions } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import type { AgentEvent } from './loop';
import { servicesForFiles } from './services';
import { captureBaselines, formatVerificationReport, verifyChanges, type ContractFetcher, type VerificationReport } from './verify';
import type { OpenApiDocument } from './contract-diff';
import type { Workspace } from './workspace';

export type GateOutcome =
  | { kind: 'pass' }
  /** 모델에게 돌려줄 게이트 결과. 고친 뒤 다시 턴을 끝내게 한다 */
  | { kind: 'retry'; feedback: string }
  | { kind: 'exhausted'; summary: string };

export interface GateOptions {
  project: LoadedProject;
  sandbox: Sandbox;
  workspace: Workspace;
  allowBreaking: boolean;
  maxVerifyAttempts: number;
  fetcher: ContractFetcher;
  signal?: AbortSignal;
  onServiceStatus?: StartOptions['onStatus'];
  onEvent: (event: AgentEvent) => void;
}

/**
 * 모델이 턴을 끝낼 때마다 도는 검증 게이트.
 * 모델 호출 방식(직접 만든 루프, 로컬 Claude Code)과 무관하게 같은 규칙으로 완료를 판정하도록 루프에서 분리했다.
 */
export class VerificationGate {
  attempts = 0;
  /** 마지막 검증 결과 */
  report: VerificationReport | undefined;
  readonly #options: GateOptions;
  readonly #baselines: ReadonlyMap<string, OpenApiDocument>;
  #verifiedVersion = 0;
  #failedServices = new Set<string>();

  private constructor(options: GateOptions, baselines: ReadonlyMap<string, OpenApiDocument>) {
    this.#options = options;
    this.#baselines = baselines;
  }

  /** 계약 비교 기준은 모델이 파일을 바꾸기 전에 잡아야 한다 */
  static async create(options: GateOptions): Promise<VerificationGate> {
    return new VerificationGate(options, await captureBaselines(options.sandbox, options.project, options.fetcher));
  }

  async check(): Promise<GateOutcome> {
    const { project, sandbox, workspace, allowBreaking, maxVerifyAttempts, fetcher, signal, onServiceStatus, onEvent } = this.#options;
    if (workspace.changedFiles().length === 0) return { kind: 'pass' };

    const files = this.#filesToVerify();
    onEvent({ type: 'verify_start', files });
    this.#verifiedVersion = workspace.version;
    const report = await verifyChanges({
      sandbox,
      project,
      changedFiles: files,
      baselines: this.#baselines,
      allowBreaking,
      fetcher,
      start: { signal, onStatus: onServiceStatus },
    });
    this.report = report;
    this.#failedServices = new Set(report.restarted.filter((check) => !check.ready).map((check) => check.service));

    const text = formatVerificationReport(report, { allowBreaking });
    onEvent({ type: 'verify_result', report, text });
    if (report.ok) return { kind: 'pass' };

    this.attempts += 1;
    if (this.attempts >= maxVerifyAttempts) {
      return { kind: 'exhausted', summary: `검증 게이트를 ${this.attempts}번 통과하지 못했습니다` };
    }
    return {
      kind: 'retry',
      feedback: `[b-studio 검증 게이트] 변경 사항이 검증을 통과하지 못했습니다. 아래 결과를 보고 고친 뒤 턴을 끝내세요.\n\n${text}`,
    };
  }

  /** 지난 검증 이후 바뀐 파일 + 지난번에 준비에 실패한 서비스의 파일 (고치지 않았더라도 다시 확인해야 한다) */
  #filesToVerify(): string[] {
    const { project, workspace } = this.#options;
    const files = new Set(workspace.changedSince(this.#verifiedVersion));
    if (this.#failedServices.size > 0) {
      for (const file of workspace.changedFiles()) {
        const [owner] = servicesForFiles(project, [file]).services;
        if (owner && this.#failedServices.has(owner)) files.add(file);
      }
    }
    return [...files].sort();
  }
}
