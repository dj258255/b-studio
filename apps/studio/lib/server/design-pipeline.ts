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
  extractRequirementIds,
  Workspace,
  type DesignDocRecord,
} from '@b-studio/agent';
import { getSnapshot } from './sessions';
import { StudioError } from './errors';

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
