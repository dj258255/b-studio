import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 플랫폼별 Claude Code 실행 파일을 자기 패키지 위치 기준으로 찾으므로 번들에 넣지 않고 node_modules에서 그대로 불러온다
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
