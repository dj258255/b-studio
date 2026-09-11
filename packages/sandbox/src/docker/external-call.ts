import type { ExternalCallRequest } from '../types';

/**
 * edge 컨테이너 안에서 edge.mjs 뒤에 붙여 실행할 호출 코드. 결과는 표준 출력의 마지막 줄 JSON이다.
 * 감사 기록은 edge 본 프로세스의 표준 출력(/proc/1/fd/1)으로 보내 샌드박스 서비스의 호출 기록과 한곳에 남긴다.
 * 요청 값은 JSON 리터럴로만 넣으므로 코드로 해석되지 않는다
 */
export function externalCallScript(edgeScript: string, request: ExternalCallRequest & { name: string; via: string }): string {
  return [
    // edge.mjs의 서버 시작 조건을 끈다. import는 끌어올려지지만 이 문장은 시작 조건 확인보다 먼저 실행된다
    "process.env.EDGE_MAIN = '0';",
    edgeScript,
    "import { writeFileSync as writeAuditLine } from 'node:fs';",
    `const studioRequest = ${JSON.stringify(request)};`,
    CALL_BODY,
  ].join('\n');
}

const CALL_BODY = `
const printResult = (result) => process.stdout.write('\\n' + JSON.stringify(result) + '\\n');
const writeAudit = (record) => {
  try {
    writeAuditLine('/proc/1/fd/1', JSON.stringify({ edge: 'api', ...record, at: new Date().toISOString() }) + '\\n');
  } catch {}
};
const studioTarget = new URL(studioRequest.path, 'http://edge');
const studioMethod = studioRequest.method.toUpperCase();
const studioExternal = parseExternals(process.env.EDGE_EXTERNALS).find((item) => item.name === studioRequest.name);
const studioEntry = { caller: STUDIO_CALLER, via: studioRequest.via, target: studioRequest.name, method: studioMethod, path: studioTarget.pathname };
const refuse = (status, reason) => {
  writeAudit({ ...studioEntry, decision: 'deny', status, reason });
  printResult({ decision: 'deny', status, body: 'b-studio: ' + reason, masked: 0, reason });
};

if (!studioExternal) {
  refuse(404, '등록하지 않은 API입니다');
} else if (!isAllowedCall(studioExternal.policy, STUDIO_CALLER, studioMethod, studioTarget.pathname)) {
  refuse(403, 'studio(에이전트 도구·API 탐색기)에 허용하지 않은 호출입니다');
} else {
  try {
    const body = studioRequest.body ? Buffer.from(studioRequest.body) : undefined;
    const headers = studioRequest.body ? { 'content-type': 'application/json' } : {};
    const result = await callUpstream(studioExternal, process.env, { method: studioMethod, pathname: studioTarget.pathname, search: studioTarget.search, headers, body });
    writeAudit({ ...studioEntry, decision: 'allow', status: result.status, masked: result.masked });
    printResult({ decision: 'allow', status: result.status, contentType: result.headers['content-type'], body: result.body.toString('utf8'), masked: result.masked });
  } catch (error) {
    if (error instanceof ApiPolicyError) refuse(error.status, error.message);
    else refuse(502, '사내 API에 연결하지 못했습니다 (' + (error?.code ?? error?.message ?? String(error)) + ')');
  }
}
`;
