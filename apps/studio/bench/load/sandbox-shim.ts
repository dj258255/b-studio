/**
 * 부하 스모크 전용 샌드박스 shim. tsx가 bench/load/tsconfig.json의 paths로 `@b-studio/sandbox` 대신 이 파일을 불러온다.
 * 실제 패키지를 그대로 다시 내보내고 providerFromEnv만 가짜 제공자로 바꾼다(Docker를 띄우지 않는다).
 * 런타임 전용이며 apps/studio의 정식 타입 검사 대상은 아니다(실제 타입은 패키지에서 온다).
 */
export * from '../../../../packages/sandbox/src/index';
export { providerFromEnv } from './fake-provider';
