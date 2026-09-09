import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const integrationApiUrl =
  process.env.INTEGRATION_API_URL ?? 'http://localhost:3101'

export default defineConfig({
  // Keep the integration API separate from the sequential local-dev ports.
  envDir: path.resolve(import.meta.dirname, '../..'),
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify(integrationApiUrl),
  },
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/tests/integration/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.dom.ts'],
    css: false,
    restoreMocks: true,
    fileParallelism: true,
    // Integration tests share the API/DB with other suites; a single worker
    // keeps their resource use predictable.
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
