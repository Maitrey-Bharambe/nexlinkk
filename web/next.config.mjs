import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Only the version reaches the browser (shown on the sign-in page), not package.json.
  env: { NEXT_PUBLIC_APP_VERSION: version },
  // Allow the dev server to be opened from other PCs on a private LAN.
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.16.*.*', '*.local'],
  poweredByHeader: false,
  // /api/v1, Socket.IO and the agent relay are served by server.js in this
  // same process, so every browser call is same-origin: the session cookie is
  // HttpOnly + SameSite=Strict and never touched by JavaScript.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
