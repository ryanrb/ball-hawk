import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/ball-hawk/',

  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Ball Hawk',
        short_name: 'BallHawk',
        description: 'Golf ball finder with GPS tracking and AI detection',
        theme_color: '#0d0d1a',
        background_color: '#0d0d1a',
        display: 'fullscreen',
        orientation: 'portrait',
        start_url: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],

  optimizeDeps: {
    include: ['mapbox-gl'],
  },

  server: {
    host: true,
    port: 5173,
  },
});
