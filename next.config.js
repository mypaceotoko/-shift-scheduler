/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";
const repoBase = process.env.NEXT_PUBLIC_BASE_PATH ?? "/-shift-scheduler";

const nextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  basePath: isProd ? repoBase : "",
  assetPrefix: isProd ? `${repoBase}/` : "",
};

module.exports = nextConfig;
