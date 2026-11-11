import { native } from '../native';
import type { ExternalCallRequest } from '../types';

/**
 * edge 컨테이너 안에서 edge.mjs 뒤에 붙여 실행할 호출 코드. 결과는 표준 출력의 마지막 줄 JSON이다.
 * 감사 기록은 edge 본 프로세스의 표준 출력(/proc/1/fd/1)으로 보내 샌드박스 서비스의 호출 기록과 한곳에 남긴다.
 * 요청 값은 JSON 리터럴로만 넣으므로 코드로 해석되지 않는다
 */
export function externalCallScript(edgeScript: string, request: ExternalCallRequest & { name: string; via: string }): string {
  // 대본 조립은 Rust(crates/bstudio-guard/src/external_call.rs)가 한다. 요청의 JSON 글자는 여기서 만들어 그대로 넘긴다
  // (같은 JSON.stringify라 옛 코드와 바이트가 같고, 짝 없는 서로게이트도 \udXXX로 쓰여 napi 경계에서 바뀌지 않는다)
  return native.externalCallScript(edgeScript, JSON.stringify(request));
}
