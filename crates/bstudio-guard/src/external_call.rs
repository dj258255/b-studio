//! edge 컨테이너 안에서 `edge.mjs` 뒤에 붙여 실행할 호출 대본(옛 TS: `packages/sandbox/src/docker/external-call.ts`, ADR-195 4f A4a).
//! 결과는 표준 출력의 마지막 줄 JSON이다. 감사 기록은 edge 본 프로세스의 표준 출력(`/proc/1/fd/1`)으로 보내
//! 샌드박스 서비스의 호출 기록과 한곳에 남긴다.
//!
//! 요청 값은 JSON 리터럴로만 넣으므로 코드로 해석되지 않는다. 그 JSON은 부르는 쪽이 만든다(Node는 `JSON.stringify`) —
//! 이 모듈은 받은 글자를 그대로 이어 붙일 뿐이라 따옴표·개행·NUL·`$`·역따옴표·역슬래시를 다시 해석하지 않는다.
//! 대본 본문(`CALL_BODY`)은 옛 TS 템플릿 리터럴을 풀어 쓴 것이고 바이트까지 같아야 한다(차등 시험이 확인한다).

/// 요청 뒤에 붙는 고정 본문
const CALL_BODY: &str = r####"
const printResult = (result) => process.stdout.write('\n' + JSON.stringify(result) + '\n');
const writeAudit = (record) => {
  try {
    writeAuditLine('/proc/1/fd/1', JSON.stringify({ edge: 'api', ...record, at: new Date().toISOString() }) + '\n');
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
} else if (hasEncodedSeparator(studioTarget.pathname)) {
  refuse(403, '경로에 인코딩된 구분자나 ;가 있어 규칙을 검사할 수 없습니다');
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
"####;

/// `edge_script`는 `edge.mjs`의 내용, `request_json`은 `{ name, via, ...요청 }`를 JSON으로 쓴 글자(JS 리터럴로 그대로 들어간다)
pub fn external_call_script(edge_script: &str, request_json: &str) -> String {
    [
        // edge.mjs의 서버 시작 조건을 끈다. import는 끌어올려지지만 이 문장은 시작 조건 확인보다 먼저 실행된다
        "process.env.EDGE_MAIN = '0';",
        edge_script,
        "import { writeFileSync as writeAuditLine } from 'node:fs';",
        &format!("const studioRequest = {request_json};"),
        CALL_BODY,
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 앞뒤_조각을_줄바꿈으로_잇는다() {
        let got = external_call_script("EDGE", r#"{"a":1}"#);
        let lines: Vec<&str> = got.splitn(5, '\n').collect();
        assert_eq!(lines[0], "process.env.EDGE_MAIN = '0';");
        assert_eq!(lines[1], "EDGE");
        assert_eq!(lines[2], "import { writeFileSync as writeAuditLine } from 'node:fs';");
        assert_eq!(lines[3], r#"const studioRequest = {"a":1};"#);
        assert!(lines[4].starts_with('\n') && lines[4].ends_with("}\n"));
    }

    #[test]
    fn 요청_글자는_해석하지_않고_그대로_넣는다() {
        let request = r#"{"body":"a'b\"c\nd\u0000$`\\${x} 😀"}"#;
        let got = external_call_script("", request);
        assert!(got.contains(&format!("const studioRequest = {request};\n")));
    }

    #[test]
    fn 본문의_개행_표기는_역슬래시_n_두_글자다() {
        // 옛 TS 템플릿의 `'\\n'`이 만든 글자. 실제 개행으로 바뀌면 출력 줄이 깨진다
        assert!(CALL_BODY.contains(r"process.stdout.write('\n' + JSON.stringify(result) + '\n')"));
        assert!(CALL_BODY.contains(r"+ '\n');"));
    }
}
