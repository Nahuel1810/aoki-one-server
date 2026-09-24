import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// Suite de aceptacion: los 55 tests portados del servidor legacy (T02).
//
// Son el contrato de la reescritura. Arrancan ROJOS a proposito: el esqueleto de
// packages/{domain,agent,server} declara las firmas y todas tiran NotImplemented, asi que
// los tests compilan y fallan. Van pasando a verde a medida que T03 a T21 implementan.
//
// Corre aparte de test:packages porque ese gate es bloqueante y esta suite no lo puede
// tumbar durante las ~20 tasks que tarda en implementarse. Cuando llegue a verde se
// fusiona con la suite de unidad y pasa a bloquear.
export default defineConfig({
  resolve: {
    alias: {
      '@aoki-one/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/{domain,agent,server}/src/**/*.aceptacion.test.ts'],
    environment: 'node',
    globals: false,
  },
})
