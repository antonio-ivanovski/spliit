import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Several package test tasks run concurrently under turbo; uncapped forks
    // oversubscribe the CPU and starve every suite (timeouts under load).
    maxWorkers: 2,
  },
})
