/**
 * 프로젝트 지침 파일 읽기(ADR-077, "반복 행동을 스크립트로 굳히기").
 *
 * 되풀이 행동 감지(apps/studio/lib/repeated-actions.ts)가 찾아 사람이 승인해 만든 스크립트·요약은,
 * 다음 실행이 그 사실을 몰라야 아무 소용이 없다. 그래서 매 실행 시작마다 세션 작업 복사본(`project.root` —
 * 러너마다 다른 자기 SDK 작업 폴더가 아니라 실제 체크아웃) 바로 아래의 AGENTS.md(또는 CLAUDE.md)를 읽어
 * 시스템 프롬프트에 넣는다. b-studio는 지금까지 사용자 전역·프로젝트 설정(훅·플러그인·CLAUDE.md 자동 로드)을
 * 일부러 꺼 왔다(`claude-code-runner.ts`의 `settingSources: []`) — 이 모듈은 그 대신 내용을 직접 읽어
 * "b-studio가 직접 통제하는" 한 문자열로만 전달하므로 그 원칙을 건드리지 않는다.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GuideSpec, LoadedProject } from '@b-studio/spec';
import { parseRequirementsMarkdown, REQUIREMENTS_FILE, summarizeManualStepsForGuide, summarizeRequirementsForGuide } from './requirements';

/** guide 절을 아예 생략한 studio.yaml(스키마가 없는 옛 프로젝트 픽스처 포함)에 쓰는 기본값 */
const DEFAULT_GUIDE: GuideSpec = { file: 'AGENTS.md', maxChars: 8_000, enabled: true };
/** 기본 파일 이름을 그대로 뒀을 때만 시도하는 대체 파일 이름(Claude Code 등이 관례로 쓰는 이름) */
const FALLBACK_FILE = 'CLAUDE.md';

export interface ProjectGuide {
  /** 실제로 읽은 파일 이름(설정한 파일, 또는 그 파일이 없어 대신 읽은 CLAUDE.md) */
  file: string;
  /** 모델에 넘길 본문(예산을 넘었으면 앞부분만 남고 잘렸다는 안내가 붙는다) */
  text: string;
  /** 이 본문이 실제로 차지하는 글자 수(잘린 뒤 기준 — 시스템 프롬프트에 더해지는 고정 비용 그대로) */
  charsUsed: number;
}

/**
 * 프로젝트 루트에서 지침 파일을 읽는다. 꺼져 있거나(guide.enabled=false) 파일이 없으면 그 부분은 건너뛴다 —
 * 호출자(각 러너)는 둘 다 없으면 시스템 프롬프트에 아무것도 더하지 않는다(있지도 않은 파일 때문에 고정 문맥이 늘지 않는다).
 * 읽기는 매 실행마다 새로 한다(캐시하지 않는다): 이전 실행이나 사람이 방금 고친 내용을 이번 실행부터 반영해야 하기 때문이다.
 *
 * docs/requirements.md(ADR-079, "명세 → 요구사항 → 검증 추적")가 있으면 그 요약(요구사항 id·제목·우선순위, must/should만,
 * ≤1,500자, summarizeRequirementsForGuide)을 같은 절 끝에 이어 붙인다 — projectGuideSection이 감싸는 하나의 블록으로 모델에
 * 전달되고, guideChars 지표(loop.ts 등 각 러너가 이미 guide.charsUsed를 metrics.guideChars에 옮긴다)에도 자연히 합쳐진다.
 * AGENTS.md 없이 요구사항 파일만 있어도(guide.enabled=false가 아닌 한) 이 절은 만들어진다 — 두 지침은 별개의 관심사다.
 */
export async function loadProjectGuide(project: LoadedProject): Promise<ProjectGuide | undefined> {
  const base = await loadAgentsGuide(project);
  const requirementsSection = await loadRequirementsGuideSection(project);
  if (!base && !requirementsSection) return undefined;
  const text = base && requirementsSection ? `${base.text}\n\n${requirementsSection}` : (base?.text ?? requirementsSection)!;
  return { file: base?.file ?? REQUIREMENTS_FILE, text, charsUsed: text.length };
}

/** AGENTS.md(또는 대체 이름)를 읽는다. loadProjectGuide의 기존 동작 그대로다 */
async function loadAgentsGuide(project: LoadedProject): Promise<Pick<ProjectGuide, 'file' | 'text'> | undefined> {
  const config = project.spec.guide ?? DEFAULT_GUIDE;
  if (!config.enabled) return undefined;
  const file = config.file ?? DEFAULT_GUIDE.file;
  // 사용자가 파일 이름을 직접 바꿨으면 그 파일만 본다. 기본값(AGENTS.md)일 때만 관례적 대체 이름을 추가로 시도한다
  const candidates = file === DEFAULT_GUIDE.file ? [file, FALLBACK_FILE] : [file];
  const maxChars = config.maxChars ?? DEFAULT_GUIDE.maxChars;

  for (const candidate of candidates) {
    const raw = await tryRead(path.join(project.root, candidate));
    if (raw === undefined) continue;
    if (raw.length <= maxChars) return { file: candidate, text: raw };
    const cutChars = raw.length - maxChars;
    const text = `${raw.slice(0, maxChars)}\n\n[...나머지 ${cutChars.toLocaleString('ko-KR')}자는 길이 제한으로 잘렸습니다. 필요하면 read_file로 ${candidate} 전체를 읽으세요]`;
    return { file: candidate, text };
  }
  return undefined;
}

/**
 * docs/requirements.md가 있으면 요약해 돌려준다. 없거나 요구사항을 하나도 못 읽으면(파일이 깨졌거나 비어 있음) undefined.
 * "## 사람이 할 일"(저장소 권한·협업자 추가, 이메일 제출 등)이 있으면 별도 절로 이어 붙여, 에이전트가 이 절차를
 * 요구사항으로 착각해 시도하지 않도록 매 실행마다 못박는다(ADR-090) — 요구사항이 하나도 없어도 이 절은 만들어진다.
 */
async function loadRequirementsGuideSection(project: LoadedProject): Promise<string | undefined> {
  const raw = await tryRead(path.join(project.root, REQUIREMENTS_FILE));
  if (raw === undefined) return undefined;
  const { requirements, manualSteps } = parseRequirementsMarkdown(raw);
  const requirementsSummary = requirements.length > 0 ? summarizeRequirementsForGuide(requirements) : '';
  const manualStepsSummary = summarizeManualStepsForGuide(manualSteps);
  const combined = [requirementsSummary, manualStepsSummary].filter(Boolean).join('\n\n');
  return combined || undefined;
}

async function tryRead(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    // 파일이 없거나(ENOENT) 읽지 못하면 그 이름은 없는 것으로 본다 — 다음 후보를 시도하거나 아무것도 넣지 않는다
    return undefined;
  }
}
