/**
 * "기능 흐름(파이프라인)" — 설계 먼저, 구현은 따로(ADR-100).
 *
 * 범수 님의 작업 방식을 코드로 강제한다: 설계는 메인 세션이 맡고(읽기만 묻는 "조사" 모드로 설계 문서를 받는다),
 * 구현은 저렴한 코더에게, 검토는 다른 계열 모델이, 마지막 확인은 다시 설계한 쪽이 한다. "완료"(구현이 끝났다)와
 * "성공"(다른 계열 모델 검토 + 검증 재실행 통과)을 나눈다. 지켜야 하는 조건은 프롬프트로 부탁하지 않고 서버가 막는다.
 *
 * 설계 문서는 세션 작업 복사본의 `docs/design/NN-제목.md`(본문, 사람이 읽는 글)와 그 옆의 `.meta.json` 사이드카
 * (요구사항 id·작업 묶음·승인 상태 — 서버가 판정에 쓰는 구조화된 값)로 이뤄진다. 기존 "문서" 탭의 범용 설계 노트
 * (`docs/NN-제목.md`, packages/agent/src/docs.ts)와는 다른 자리를 쓴다 — 그 흐름은 서버가 강제하는 승인 상태를
 * 모르므로 섞지 않는다. 옵트인: 그 요구사항을 다루는 설계 문서가 하나도 없으면 지금처럼 구현을 바로 시작할 수 있다.
 *
 * 세션 내부(샌드박스·워크스페이스 객체)에는 닿지 않고, sessions.ts가 이미 내보낸 getSnapshot·commitWorkingCopyDocs와
 * 스냅샷의 workDir(작업 복사본 루트)만으로 움직인다 — sessions.ts 자체는 건드리지 않는다.
 */
import {
  checkDesignApproval,
  DESIGN_APPROVAL_REQUIRED_MESSAGE,
  DESIGN_PIPELINE_DIR,
  DesignDocRecordSchema,
  designPipelineDocPath,
  designPipelineSidecarPath,
  extractRequirementIds,
  isDesignPipelineDocPath,
  nextDesignPipelineDocNumber,
  parseDesignBundlesTable,
  Workspace,
  type DesignDocRecord,
} from '@b-studio/agent';
import { commitWorkingCopyDocs, getSnapshot, sessionBackend } from './sessions';
import { StudioError } from './errors';
import { modelFamily } from './model-family';

function requireReadySnapshot(id: string, action: string) {
  const snapshot = getSnapshot(id);
  if (!snapshot) throw new StudioError(404, '세션을 찾을 수 없습니다');
  if (snapshot.status !== 'ready') throw new StudioError(409, `샌드박스가 준비된 뒤에 ${action} 수 있습니다`);
  return snapshot;
}

/** docs/design/ 아래 사이드카(.meta.json)를 모두 읽어 유효한 레코드만 돌려준다. 폴더가 없으면 빈 배열 */
async function listDesignDocSidecars(workDir: string): Promise<DesignDocRecord[]> {
  const workspace = new Workspace(workDir);
  let files: string[];
  try {
    files = (await workspace.list(DESIGN_PIPELINE_DIR, 2)).filter((entry) => entry.endsWith('.meta.json'));
  } catch {
    return [];
  }
  const records = await Promise.all(
    files.map(async (file) => {
      try {
        return DesignDocRecordSchema.parse(JSON.parse(await workspace.read(file)));
      } catch {
        // 손상된 사이드카 하나 때문에 나머지 설계 문서를 못 보게 하지 않는다
        return undefined;
      }
    }),
  );
  return records.filter((record): record is DesignDocRecord => record !== undefined).sort((a, b) => a.number - b.number);
}

/** 세션의 모든 설계 파이프라인 문서(초안·승인 모두). "요구사항" 탭의 "파이프라인" 하위 화면이 연다 */
export async function listSessionDesignDocs(id: string): Promise<DesignDocRecord[]> {
  const snapshot = getSnapshot(id);
  if (!snapshot) throw new StudioError(404, '세션을 찾을 수 없습니다');
  return listDesignDocSidecars(snapshot.workDir);
}

export interface SaveDesignDocInput {
  title: string;
  /** 명시적으로 주면 그대로 쓰고, 없으면 제목+본문에서 R-id를 스스로 뽑는다 */
  requirementIds?: string[];
  /** "조사" 모드로 받은 설계 답(또는 사람이 직접 쓴 설계). docs/design/NN-제목.md 본문 그대로 쓴다 */
  body: string;
  createdBy: string;
}

/**
 * 설계 문서를 새로 만든다(항상 "초안" 상태로 시작한다). 본문의 "작업 묶음" 표를 구조화해 사이드카에 남기므로,
 * 표가 없어도 막지 않는다(차단하지 않는다 — 나중에 사람이 고쳐 쓸 수 있다). 바로 문서 체크포인트로 남긴다
 * (요구사항 저장·이슈 발행 사이드카와 같은 이유 — 작업 분해가 이 세션의 최신 체크포인트에서 시작해도 이어받는다).
 */
export async function saveSessionDesignDoc(id: string, input: SaveDesignDocInput): Promise<DesignDocRecord> {
  const snapshot = requireReadySnapshot(id, '설계 문서를 만들');
  const title = input.title.trim();
  if (!title) throw new StudioError(400, '제목이 필요합니다');
  const body = input.body.trim();
  if (!body) throw new StudioError(400, '설계 문서 내용이 필요합니다');

  const workspace = new Workspace(snapshot.workDir);
  let existing: string[];
  try {
    existing = await workspace.list(DESIGN_PIPELINE_DIR, 2);
  } catch {
    existing = [];
  }
  const number = nextDesignPipelineDocNumber(existing);
  const docPath = designPipelineDocPath(number, title);
  const sidecarPath = designPipelineSidecarPath(docPath);
  const requirementIds = input.requirementIds?.length ? [...new Set(input.requirementIds)] : [...new Set(extractRequirementIds(`${title}\n${body}`))];
  const bundles = parseDesignBundlesTable(body);
  const record: DesignDocRecord = {
    path: docPath,
    number,
    title,
    requirementIds,
    bundles,
    status: 'draft',
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  };

  await workspace.write(docPath, body.endsWith('\n') ? body : `${body}\n`);
  await workspace.write(sidecarPath, JSON.stringify(record, null, 2));
  await commitWorkingCopyDocs(id, [docPath, sidecarPath], `docs: ${title} 설계 문서를 만든다`);
  return record;
}

/**
 * 사람이 설계를 승인한다(초안 → 승인됨). 이미 승인된 설계는 다시 승인하지 않는다(409).
 * 승인 전까지는 이 설계가 다루는 요구사항의 구현을 assertDesignApprovedForRequest가 막는다.
 */
export async function approveSessionDesignDoc(id: string, docPath: string, owner: string): Promise<DesignDocRecord> {
  const snapshot = requireReadySnapshot(id, '설계를 승인할');
  if (!isDesignPipelineDocPath(docPath)) throw new StudioError(400, '설계 파이프라인 문서 경로가 아닙니다');
  const workspace = new Workspace(snapshot.workDir);
  const sidecarPath = designPipelineSidecarPath(docPath);
  const raw = await workspace.read(sidecarPath).catch(() => undefined);
  if (raw === undefined) throw new StudioError(404, '설계 문서를 찾을 수 없습니다');
  const record = DesignDocRecordSchema.parse(JSON.parse(raw));
  if (record.status === 'approved') throw new StudioError(409, '이미 승인된 설계입니다');
  const approved: DesignDocRecord = { ...record, status: 'approved', approvedBy: owner, approvedAt: new Date().toISOString() };
  await workspace.write(sidecarPath, JSON.stringify(approved, null, 2));
  await commitWorkingCopyDocs(id, [sidecarPath], `docs: ${record.title} 설계를 승인한다`);
  return approved;
}

/**
 * 요청 글에 언급된 요구사항 id(`R4`, `R4.1` 같은 토큰)가 아직 승인되지 않은 설계 문서의 범위에 걸리면
 * 409(DESIGN_APPROVAL_REQUIRED_MESSAGE)로 막는다. 그 요구사항을 다루는 설계 문서가 하나도 없으면(옵트인) 통과한다.
 * 메시지 라우트(구현 요청)와 작업 계획(나눠서 병렬로 하기) 양쪽에서 부른다 — 프롬프트가 아니라 서버가 막는다.
 */
export async function assertDesignApprovedForRequest(id: string, request: string): Promise<void> {
  const requirementIds = extractRequirementIds(request);
  if (requirementIds.length === 0) return;
  const snapshot = getSnapshot(id);
  if (!snapshot) return; // 세션이 없으면 다른 판정(authorizeSession 등)이 먼저 막는다
  const designDocs = await listDesignDocSidecars(snapshot.workDir);
  const check = checkDesignApproval(requirementIds, designDocs);
  if (check.blocked) throw new StudioError(409, DESIGN_APPROVAL_REQUIRED_MESSAGE);
}

/** 이 세션의 백엔드·모델이 속한 모델 계열(구현자 계열). 검토 독립성 판정에 쓴다 */
export function sessionImplementerFamily(id: string) {
  const snapshot = getSnapshot(id);
  if (!snapshot) return 'unknown' as const;
  return modelFamily(sessionBackend(snapshot), snapshot.modelId);
}
