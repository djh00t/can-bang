import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    isolate: true,
    sequence: { concurrent: false, shuffle: false },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'test/**'],
      thresholds: {
        lines: 85,
        statements: 80,
        functions: 80,
        branches: 60,
      },
    },
  },
})
