/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  typescript: { ignoreBuildErrors: true },
  experimental: {
    outputFileTracingIncludes: {
      '/api/process': ['./data/reference-bank.json', './data/confusion-pairs.json'],
    },
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    config.resolve.fallback = {
      ...config.resolve.fallback,
      canvas: false,
      fs: false,
      path: false,
    };
    return config;
  },
};

export default nextConfig;
