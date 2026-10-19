const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://127.0.0.1:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow the dev server to be opened from other PCs on a private LAN.
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.16.*.*', '*.local'],
  poweredByHeader: false,
  // REST calls stay same-origin (/api/v1 → control plane) so the session cookie
  // can be HttpOnly + SameSite=Strict and never touched by JavaScript.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${CONTROL_PLANE_URL}/api/v1/:path*` }];
  },
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
