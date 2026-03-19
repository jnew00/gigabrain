import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        // Block direct access to the data directory
        { source: "/data/:path*", destination: "/404" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
