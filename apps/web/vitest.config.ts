import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const alias = {
  '@': path.resolve(import.meta.dirname, './src'),
  'virtual:pwa-register': path.resolve(
    import.meta.dirname,
    './src/test/virtual-pwa-register.ts',
  ),
}

const sharedTest = {
  globals: true as const,
  css: false,
  restoreMocks: true,
  exclude: ['src/tests/integration/**'],
  // Several package test tasks run concurrently under turbo; uncapped forks
  // oversubscribe the CPU and starve every suite (timeouts under load).
  maxWorkers: 2,
}

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    // Root options (reporters/coverage) live here; environments are per-project.
    projects: [
      {
        resolve: { alias },
        test: {
          ...sharedTest,
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          // These .test.ts files touch document/localStorage/navigator/RTL.
          exclude: [
            ...sharedTest.exclude,
            'src/tests/utils/i18n.test.ts',
            'src/tests/utils/account-preferences.test.ts',
          ],
          setupFiles: ['./src/test/setup.node.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          ...sharedTest,
          name: 'dom',
          environment: 'happy-dom',
          include: [
            'src/**/*.test.tsx',
            'src/tests/utils/i18n.test.ts',
            'src/tests/utils/account-preferences.test.ts',
          ],
          setupFiles: ['./src/test/setup.dom.ts'],
        },
      },
    ],
  },
})
