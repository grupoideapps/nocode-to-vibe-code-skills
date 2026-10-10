import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O renderer interpreta o export em runtime; nada de otimização de imagem
  // remota (assets vêm do S3 da plataforma com URLs arbitrárias).
  images: { unoptimized: true },
};

export default nextConfig;
