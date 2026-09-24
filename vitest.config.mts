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
    // La suite de aceptacion ya esta en verde, asi que entra al gate bloqueante
    // junto con la de unidad: a partir de aca una regresion sobre el contrato
    // portado rompe el pipeline, que es todo el punto de haberla escrito.
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // T24 pide cobertura completa de `domain`, y el umbral es lo que hace que
      // "completa" siga significando algo dentro de seis meses: bajar de ahi
      // rompe el pipeline en vez de pasar desapercibido.
      //
      // Es 100% real, no negociado: las dos unicas ramas que no se pueden
      // ejercitar —guards que existen solo porque noUncheckedIndexedAccess tipa
      // los grupos de la regex como `string | undefined`— estan excluidas con
      // `v8 ignore` y su razon escrita al lado.
      //
      // El resto de los paquetes NO tiene umbral todavia: el agente y el
      // servidor se cubren con la suite de aceptacion y con los tests que entren
      // con cada task, y poner un numero alto ahora obligaria a inventar tests de
      // cableado en vez de tests de comportamiento.
      thresholds: {
        'packages/domain/src/**/*.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
})
