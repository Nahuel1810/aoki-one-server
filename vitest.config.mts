import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Los tests corren contra el codigo fuente del dominio, no contra packages/domain/dist.
    // Sin este alias, `npm run test:packages` sobre un checkout limpio falla con
    // "Failed to resolve entry for package @aoki-one/domain" porque el symlink del
    // workspace apunta a dist/ y todavia no se corrio el build.
    alias: {
      '@aoki-one/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/{domain,agent,server}/src/**/*.test.ts'],
    // La suite de aceptacion (los 55 portados) corre aparte: esta roja por diseño hasta
    // que T03+ implemente el contrato, y este gate es bloqueante.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.aceptacion.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
})
