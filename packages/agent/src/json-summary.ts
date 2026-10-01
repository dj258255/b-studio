/**
 * 큰 JSON 참조 파일(예: seed/seed.json, 수백 KB)의 구조 요약.
 *
 * requirements.ts의 resolveReferencedFiles는 Workspace.read()의 256KB 상한을 넘는 파일을 만나면 통째로 읽기를
 * 포기한다 — 그러면 지금까지는 "(파일이 커서 미리보기를 만들지 못했습니다)"만 보여 추출 모델이 참조 파일의
 * 모양을 전혀 알 수 없었다. 여기서는 그 상한을 넘겼어도(너무 거대하지만 않으면) 파일을 직접 읽어 구조만
 * 요약한다: 최상위가 배열이면 길이와 첫 항목의 필드 이름·타입, 객체면 키마다(배열 값이면 길이도 함께) 나열한다.
 * 전체 내용 대신 이 요약만 모델 문맥에 들어간다(buildReferencedFilesContext).
 *
 * requirements.ts는 이 모듈의 함수를 호출만 한다(다른 브랜치가 requirements.ts를 고치고 있어 거기 변경은
 * 최소로 둔다).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** 구조 요약을 위해 통째로 읽어볼 만한 상한. 이 이상은 메모리 보호를 위해 포기하고 호출하는 쪽이 크기만 보고한다 */
export const MAX_JSON_SUMMARY_BYTES = 8 * 1024 * 1024;

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `배열(${value.length.toLocaleString('ko-KR')})`;
  return typeof value;
}

/** 배열의 첫 항목이 객체면 "키: 타입" 나열, 원시값이거나 배열이면 보여줄 필드가 없다(undefined) */
function describeFirstItemFields(first: unknown): string | undefined {
  if (!first || typeof first !== 'object' || Array.isArray(first)) return undefined;
  const entries = Object.entries(first as Record<string, unknown>).map(([key, value]) => `${key}: ${describeType(value)}`);
  return entries.length > 0 ? entries.join(', ') : undefined;
}

/** 이미 파싱한 JSON 값의 최상위 모양을 요약 문장으로 만든다 */
export function summarizeJsonStructure(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    const base = `배열, ${parsed.length.toLocaleString('ko-KR')}개 항목`;
    const fields = describeFirstItemFields(parsed[0]);
    return fields ? `${base} · 첫 항목 필드: ${fields}` : base;
  }
  if (parsed && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => (Array.isArray(value) ? `${key} ${value.length.toLocaleString('ko-KR')}개` : key));
    return entries.length > 0 ? entries.join(', ') : '(빈 객체)';
  }
  return String(parsed);
}

/** 문자열을 JSON으로 풀어 구조를 요약한다. JSON이 아니면(파싱 실패) undefined — 호출하는 쪽이 다른 미리보기로 대신한다 */
export function summarizeJsonContent(content: string): string | undefined {
  try {
    return summarizeJsonStructure(JSON.parse(content));
  } catch {
    return undefined;
  }
}

/**
 * Workspace.read()가 256KB 상한 때문에 거절한 JSON 파일을 직접 읽어 구조 요약을 시도한다. 경로는 이미
 * Workspace.read()가 보안 검사(프로젝트 밖·생성물·비밀 파일)를 끝낸 뒤 크기만으로 던진 에러라, 여기서는
 * 다시 검사하지 않는다(resolveReferencedFiles만 이 함수를 부른다 — 임의 경로를 받지 않는다).
 * .json이 아니거나 MAX_JSON_SUMMARY_BYTES를 넘거나 읽기·파싱에 실패하면 undefined.
 */
export async function summarizeLargeJsonFile(root: string, relativePath: string, sizeBytes: number): Promise<string | undefined> {
  if (!/\.json$/i.test(relativePath) || sizeBytes > MAX_JSON_SUMMARY_BYTES) return undefined;
  const content = await readFile(path.join(root, relativePath), 'utf8').catch(() => undefined);
  if (content === undefined) return undefined;
  return summarizeJsonContent(content);
}
