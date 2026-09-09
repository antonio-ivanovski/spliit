import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const publicWebHosts = (process.env.WEB_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
  .flatMap((origin) => {
    try {
      const hostname = new URL(origin).hostname
      return hostname === 'localhost' || hostname === '127.0.0.1'
        ? []
        : [hostname]
    } catch {
      return []
    }
  })

const buildSha =
  process.env.VITE_BUILD_SHA ?? process.env.CF_PAGES_COMMIT_SHA ?? 'unknown'

export default defineConfig({
  // All workspace apps share the repository-level .env file. Vite otherwise
  // resolves env files relative to apps/web when this task runs via Turbo.
  envDir: path.resolve(import.meta.dirname, '../..'),
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      devOptions: { enabled: false },
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: [
        'logo.svg',
        'logo-with-text.svg',
        'favicon/favicon.ico',
        'favicon/apple-touch-icon.png',
      ],
      manifest: {
        id: '/',
        name: 'Spliit Cloud',
        short_name: 'Spliit',
        description: 'Share expenses with friends & family',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        launch_handler: {
          client_mode: 'navigate-existing',
        },
        background_color: '#ffffff',
        theme_color: '#047857',
        lang: 'en',
        icons: [
          {
            src: '/logo-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/logo-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/logo-512x512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        // Precache one complete Vite graph per deploy. HTML and hashed chunks
        // must switch together so a stale entry point cannot import missing
        // modules. Cloudflare Pages files stay out of the app-shell cache.
        globPatterns: [
          '**/*.{html,js,css,svg,png,ico,webp,woff2,json,webmanifest}',
        ],
        globIgnores: [
          '_worker.js',
          '404.html',
          // ~3 MiB receipt-upload codec; not needed to launch the app offline.
          'assets/heic-to-*.js',
        ],
      },
    }),
  ],
  server: {
    port: 3000,
    allowedHosts: publicWebHosts,
  },
  preview: {
    port: 3000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  define: {
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(buildSha),
  },
})
