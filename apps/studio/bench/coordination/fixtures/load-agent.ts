// 벤치처럼 tsx가 CommonJS로 옮기는 경로에서 @b-studio/agent를 불러올 수 있는지 확인하는 파일(load.test.ts가 실행한다)
import { runCodexAgent } from '@b-studio/agent';

console.log(`loaded:${typeof runCodexAgent}`);
