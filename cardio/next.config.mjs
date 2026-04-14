/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  typescript: { ignoreBuildErrors: true },
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
