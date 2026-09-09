import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep next dev from appending its agent-rules block to our curated CLAUDE.md.
  agentRules: false,
};

export default nextConfig;
