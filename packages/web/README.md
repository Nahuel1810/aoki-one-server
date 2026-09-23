# Aoki One — frontend

Interfaz de operación: zona de pickeo, equipos y métricas. Se sirve como build
estático desde el mismo Express que expone la API (`src/app.js`).

## Instalación

Desde la raíz del repo, `npm install` alcanza: un `postinstall` instala también
las dependencias de este paquete.

Si hace falta instalarlas por separado:

```bash
npm --prefix packages/web install
```

> `packages/web` **no** está en los `workspaces` de la raíz y tiene su propio
> `node_modules`. Es deliberado: evita rehoistear `better-sqlite3`, que es un
> binario nativo, en una PC con un robot en producción. Cuando el cutover esté
> validado se puede incorporar al workspace.

Para los tests funcionales hace falta además el navegador de Playwright, que no
viene con `npm install`:

```bash
npm --prefix packages/web exec playwright install chromium
```

## Comandos

Desde la raíz:

| Comando | Qué hace |
|---|---|
| `npm run dev:web` | Dev server en http://localhost:5173, con la API proxeada a `:3000` |
| `npm run build:web` | Build a `public-dist/`, que es lo que sirve Express |

Dentro de `packages/web`:

| Comando | Qué hace |
|---|---|
| `npm test` | Tests unitarios (Vitest) |
| `npm run test:e2e` | Tests funcionales (Playwright, viewport de la tablet) |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

## Cómo verlo funcionando

En desarrollo hacen falta dos procesos: el backend en `:3000` (`npm start` o
`npm run dev` desde la raíz) y el dev server (`npm run dev:web`). El front
consume rutas relativas, así que Vite las proxea a la API.

En producción es un solo proceso: `npm run build:web` y después `npm start`.
Express sirve el build en `/`, y el front anterior queda en `/legacy` hasta que
este se valide contra el robot real.
