import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 스튜디오 컨테이너 이미지는 standalone 서버만 복사한다 (Dockerfile).
  // 워크스페이스 패키지와 저장소 루트의 node_modules까지 추적하도록 저장소 루트를 추적 기준으로 삼는다
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // 서버 코드는 번들에 들어가 원본이 필요 없는데도 추적에 딸려 오는 원본과 테스트를 뺀다
  outputFileTracingExcludes: {
    "/*": ["./components/**/*", "./lib/**/*"],
  },
  // 플랫폼별 Claude Code 실행 파일을 자기 패키지 위치 기준으로 찾으므로 번들에 넣지 않고 node_modules에서 그대로 불러온다
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
