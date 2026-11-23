import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // npm run sim builds into its own folder so it can run beside a normal dev server.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Local testing of single sign-on uses 127.0.0.1 alongside the hubs; 10.0.0.* lets a phone
  // on the home network use the dev server (e.g. to download the ArciumAlarm APK). Development only.
  allowedDevOrigins: ['127.0.0.1', '10.0.0.*'],
  // The dev badge sits over the workspace bar's account button (bottom left).
  devIndicators: false,
  // The simulated backend's in-process Postgres loads its own WebAssembly files: leave it unbundled.
  serverExternalPackages: ['@electric-sql/pglite'],
  // Never cache HTML documents / API responses so a rebuild is picked up on a
  // normal reload. The hashed /_next/ static chunks are excluded and stay cached.
  // The old site's addresses (bookmarks, the hubs' Dashboards menu) lead to their dashboards.
  async redirects() {
    return [
      { source: '/portal/:rest*', destination: '/w/factory.machine', permanent: false },
      { source: '/fusion/:rest*', destination: '/w/macro.analysis', permanent: false },
      { source: '/control', destination: '/w/control.machines', permanent: false },
      { source: '/control/schedule', destination: '/w/control.schedule', permanent: false },
      { source: '/watchlists', destination: '/w/datahub.portfolios', permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: '/((?!_next/).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
