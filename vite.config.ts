import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the repo at /Plinkworks/.
export default defineConfig({
  base: process.env.PLINK_BASE ?? '/Plinkworks/',
  // The Rapier WASM ships inlined in its JS chunk, so the main bundle is large by design.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4096 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Plinkworks',
        short_name: 'Plinkworks',
        description: 'A physics sandbox that makes music.',
        theme_color: '#0b0c12',
        background_color: '#0b0c12',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // The app shell (including the inlined Rapier WASM) is cached at install, so it runs offline.
      workbox: { globPatterns: ['**/*.{js,css,html,png,svg,woff2}'], maximumFileSizeToCacheInBytes: 8 * 1024 * 1024 },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
