# chore: andamiaje del monorepo TypeScript y reorganizacion de la spec (T01)

**Rama**: `rewrite/01-spec-y-andamiaje` → `feat/frontend-vite-react`

## Qué hace

Prepara el terreno para reescribir el servidor de robots en TypeScript: reorganiza la spec de Fase 1 y levanta el monorepo con sus gates de calidad. No cambia ningún comportamiento del sistema que corre hoy.

Primero de un stack de 5 PRs; los siguientes construyen encima.

## Cambios técnicos

**Spec** (`docs/specs/2026-09-17-rewrite-ts-domain-agent.md`)

- La topología destino pasa de 2 paquetes a 3: `domain` + `agent` + `server`. El agente sigue en la notebook de la sucursal porque es la única forma de hablar Modbus con los PLCs, pero deja de ser el punto de entrada de los pedidos: la app de picking pasa a apuntar a un servidor Linux propio. Con eso se retira VSCode Ports.
- Agrega RF26–RF32 (ingreso con HMAC, cola durable, entrega por long-poll con lease, reporte idempotente, presencia, credencial de sucursal) y RF33–RF37 (espejo local, outbox, órdenes sin enlace, degradación explícita, backoff).
- RF22 se detalla en dos niveles sin login de usuario: la API local se controla por red y solo el comando directo a PLC pide token de mantenimiento.

**Monorepo**

- npm workspaces con `packages/domain`, `packages/agent`, `packages/server`. `packages/web` queda deliberadamente afuera: tiene su propio lockfile y su propia spec en curso.
- ESM puro con `nodenext`, `tsc -b` con project references, TS estricto compartido (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- ESLint flat type-aware con `no-explicit-any` y `no-unsafe-*` en error. Prettier. CI en GitHub Actions.

## Detalles que costaron

- **`tsBuildInfoFile` va dentro de `outDir`.** Fuera de `dist`, borrar `dist` no invalidaba el buildinfo: `tsc -b` declaraba todo up-to-date, salía exit 0 sin emitir nada y `npm start` rompía con MODULE_NOT_FOUND.
- **`tsconfig.eslint.json` resuelve `@aoki-one/domain` por `paths`, no por `references`.** Con references, TS se niega a resolver los fuentes contra el proyecto referenciado (TS6305) y el lint quedaba dependiendo de haber corrido el build antes.
- **`typecheck` es `tsc -b && tsc -p tsconfig.eslint.json`** para que los tests también estén tipados: solo con `tsc -b`, un error de tipos en un test pasaba el gate porque vitest transpila con esbuild sin chequear tipos.
- **CI usa `npm ci` sin fallback.** Con `npm ci || npm install`, un lockfile desincronizado nunca rompe el pipeline.
- **El `clean` borra `dist` entero**, no solo lo que tsc conoce: un archivo cuyo fuente ya no existe sobrevivía a `tsc -b --clean` y quedaba resolviendo en runtime.

## Testing

- Los 4 gates en verde desde limpio: `build`, `typecheck`, `lint`, `format:check`.
- La suite legacy (`node --test`, 60 tests) sigue pasando sin cambios: este PR no toca `src/`.
- Verificado que los gates fallan cuando deben: un `any` explícito rompe el lint y un error de tipos dentro de un `.test.ts` rompe el type-check.
