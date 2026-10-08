/**
 * 세션이 띄울 서비스를 프로젝트별로 고른다(ADR-083). 예전에는 세션마다 프로젝트 compose의 모든 서비스
 * (managed 서비스 + 폴더 열기로 가져온 카프카·레디스 같은 부가 서비스, ADR-073)를 강제로 다 띄웠다.
 * 실제로 개발하는 서비스만 고를 수 있게, 사용자의 선택은 사용자 저장소가 아니라 스튜디오 상태 폴더
 * `~/.cache/b-studio/projects/<프로젝트 id>/services.json`에 둔다(저장소를 더럽히지 않는다).
 *
 * 저장한 선택이 없으면(처음 폴더를 열 때) 기본값(managed 서비스 + 그 서비스가 기대는(depends_on) 서비스의
 * 닫힘, @b-studio/spec의 defaultServiceSelection)을 쓴다 — app이 쓰지 않는 부가 서비스(아무도 기대지 않는
 * 카프카 등)는 기본으로 뜨지 않는다. 저장한 뒤 compose에 새로 생긴 부가 서비스(known 기준, 도그푸딩 마찰 138,
 * ADR-146)는 depends_on 여부와 무관하게 기본으로 켠다 — 나중에 compose에 더한 서비스는 쓰려고 일부러 넣은
 * 것으로 본다(실측: mediamtx는 어느 managed 서비스도 depends_on으로 기대지 않는다).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { defaultServiceSelection, newlyAddedServices, type LoadedProject } from '@b-studio/spec';

export interface ServiceSelectionFile {
  version: 1;
  /** 띄울 compose 서비스 이름(managed·부가 서비스 모두 포함) */
  selected: string[];
  /**
   * 이 선택을 저장할 때 compose에 있던 서비스 이름 전체(도그푸딩 마찰 138, ADR-146). 다음에 읽을 때 여기 없는
   * 이름은 "known 이후에 생긴 서비스"로 보고 depends_on 여부와 무관하게 기본으로 켠다 — 나중에 compose에
   * 더한 부가 서비스는 쓰려고 일부러 넣은 것으로 본다(실측: BE-commerce의 mediamtx는 어느 managed 서비스도
   * depends_on으로 기대지 않는다). 이 필드가 생기기 전에 저장한 파일에는 없다 — 그런 파일은 새로 생긴 서비스를
   * 가려낼 수 없어 아무것도 자동으로 켜지 않는다(처음 폴더를 열 때와 같은 기본값 규칙으로만 간다).
   */
  known?: string[];
  updatedAt: string;
}

export function serviceSelectionStateDir(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(/*turbopackIgnore: true*/ env.B_STUDIO_PROJECTS_STATE_DIR ?? path.join(homedir(), '.cache/b-studio/projects'));
}

function fileFor(projectId: string, dir: string): string {
  return path.join(dir, projectId, 'services.json');
}

/** 저장한 선택을 그대로 읽는다(검증·기본값 적용 없이). 없거나 손상됐으면 undefined */
export async function readServiceSelection(projectId: string, dir = serviceSelectionStateDir()): Promise<ServiceSelectionFile | undefined> {
  const text = await readFile(fileFor(projectId, dir), 'utf8').catch(() => undefined);
  if (!text) return undefined;
  try {
    const data = JSON.parse(text) as Partial<ServiceSelectionFile>;
    if (!Array.isArray(data.selected)) return undefined;
    return {
      version: 1,
      selected: data.selected.filter((entry): entry is string => typeof entry === 'string'),
      ...(Array.isArray(data.known) ? { known: data.known.filter((entry): entry is string => typeof entry === 'string') } : {}),
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    };
  } catch {
    // 손으로 고치다 깨진 파일은 기본값으로 돌아간다(다음 저장이 새로 쓴다)
    return undefined;
  }
}

/**
 * known을 주면 다음에 읽을 때 새로 생긴 서비스를 가려내는 기준점으로 함께 저장한다(도그푸딩 마찰 138, ADR-146).
 * 보통 저장 시점의 project.composeServices 전체를 넘긴다. 생략하면(기존 호출부) known 없이 저장해 예전과 같다.
 */
export async function writeServiceSelection(
  projectId: string,
  selected: readonly string[],
  dir = serviceSelectionStateDir(),
  known?: readonly string[],
): Promise<ServiceSelectionFile> {
  const value: ServiceSelectionFile = {
    version: 1,
    selected: [...new Set(selected)].sort(),
    ...(known ? { known: [...new Set(known)].sort() } : {}),
    updatedAt: new Date().toISOString(),
  };
  const file = fileFor(projectId, dir);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
  return value;
}

export interface ResolvedServiceSelection {
  /** 이번에 띄울 compose 서비스 이름 */
  selected: string[];
  /** 저장한 선택이 없어 기본값(관리형 + 기댐 닫힘)을 쓰고 있는지 */
  isDefault: boolean;
  /**
   * 저장한 선택에 없었지만, known 이후에 새로 생긴 서비스로 보고 depends_on 여부와 무관하게 자동으로 켠 이름
   * (도그푸딩 마찰 138, ADR-146). 비었으면 더한 것이 없다
   */
  addedServices?: string[];
}

/**
 * 이 프로젝트에서 띄울 서비스를 정한다(도그푸딩 마찰 138, ADR-146). 두 경우를 나눈다.
 *  - **저장한 선택이 없다(처음 폴더를 열 때)**: ADR-083 기본값(managed + 그 서비스가 depends_on으로 기대는
 *    서비스의 닫힘)을 쓴다. 아무도 기대지 않는 부가 서비스는 아직 뜨지 않는다.
 *  - **저장한 선택이 있다**: 그 선택을(compose에서 없어진 이름은 걸러낸다) 쓰고, known(저장 시점의 compose
 *    서비스 전체) 이후에 새로 생긴 서비스는 depends_on 여부와 무관하게 전부 기본으로 켠다 — 나중에 compose에
 *    더한 부가 서비스는 쓰려고 일부러 넣은 것으로 본다. 사람이 이미 알고 있던(known에 있던) 서비스를 꺼 둔
 *    선택은 그대로 둔다. known이 없는 저장(이 기능이 생기기 전 v1 파일)이면 가려낼 기준이 없어 아무것도
 *    새로 켜지 않는다 — 그 세션을 한 번 더 시작·재개하거나 서비스 선택을 한 번 바꾸면 known이 생겨 그다음부터
 *    정상 동작한다.
 * 선택이 없거나 걸러진·더해진 뒤에도 하나도 안 남으면 기본값을 쓴다.
 */
export async function serviceSelectionFor(project: Pick<LoadedProject, 'managed' | 'dependsOn' | 'composeServices'>, projectId: string, dir = serviceSelectionStateDir()): Promise<ResolvedServiceSelection> {
  const saved = await readServiceSelection(projectId, dir);
  if (!saved) return { selected: defaultServiceSelection(project), isDefault: true };

  const compose = new Set(project.composeServices);
  const filtered = saved.selected.filter((name) => compose.has(name));
  const known = saved.known ? new Set(saved.known) : undefined;
  const addedServices = newlyAddedServices(known, project.composeServices);

  const selected = [...new Set([...filtered, ...addedServices])].sort();
  if (selected.length === 0) return { selected: defaultServiceSelection(project), isDefault: true };
  return { selected, isDefault: false, ...(addedServices.length > 0 ? { addedServices: addedServices.sort() } : {}) };
}

/** off인 compose 서비스 이름(선택에 없는 서비스. managed·부가 서비스 모두 포함, 도그푸딩 마찰 138) */
export function computeOffServices(project: Pick<LoadedProject, 'composeServices'>, selected: ReadonlySet<string>): Set<string> {
  return new Set(project.composeServices.filter((name) => !selected.has(name)));
}
