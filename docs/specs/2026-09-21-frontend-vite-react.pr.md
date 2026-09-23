# feat(web): frontend nuevo en Vite + React + TypeScript

Reemplaza los dos HTML estáticos de `public/` por una app en `packages/web`. El front anterior
queda servido en `/legacy` durante la validación.

Spec: `docs/specs/2026-09-21-frontend-vite-react.md`

## Por qué

El front eran 2264 líneas repartidas en dos archivos sin build, sin componentes ni tokens
compartidos y sin un solo enlace entre ellos. Lo que motivó el reemplazo no fue la estética:

- **La forma de la zona de pickeo vivía en el navegador.** `RIGHT_PICK_SLOTS`/`LEFT_PICK_SLOTS`
  duplicaban `src/config/pickSlots.js`, que es configurable por `PICK_SLOTS`. Nada garantizaba que
  coincidieran, y con multi-robot se rompía.
- **Un toque en un slot ocupado encolaba un PUT sin confirmación**, y eso mueve el carro. El código
  ya reconocía el riesgo ("no está en cada tarjeta para evitar toques accidentales") pero aplicaba
  el cuidado al botón inocuo, no al que mueve el robot. En una tablet táctil es un accidente
  esperando.
- **Re-render por `innerHTML` cada 5 s**, con reconciliación a mano (`renderReleaseSlotBar` guardaba
  el valor previo del `<select>` para no perderlo) y un mutex casero (`isRefreshingOrders`).
- **`metricas.html` no escapaba nada**; `index.html` escapaba a mano con `asSafe()`.
- **Acción y estado compartían color**: el verde de marca era el de los botones primarios *y* el de
  "slot ocupado".

## Qué cambia

### Front nuevo (`packages/web`)

Vite 8 · React 19 · TypeScript strict · TanStack Query · Tailwind v4 · Radix · Zod · React Router.

Tres rutas planas, sin roles ni gating: `/` (zona de pickeo), `/dispositivos`, `/metricas`.

- **El tablero se dibuja desde `/api/slots`.** Ninguna ubicación hardcodeada. Los slots se agrupan
  por robot y lado y se ordenan por nivel y posición usando los campos que el backend deriva.
- **Guardar un cajón pide confirmación** y muestra de qué cajón se trata antes de mandarlo.
- **Reintentar/Cancelar solo aparecen en órdenes en `ERROR`.** Una orden sana no ofrece cancelarse.
- **Estado del sistema y pausa/reanudación en el header**, persistentes. Pausar no pide confirmación
  (es la acción segura); reanudar sí, porque vuelve a mover el robot.
- **Las acciones manuales viven en un panel lateral**: el flujo normal entra por la API de picking y
  el operario no crea pedidos salvo por excepción.
- **Se pregunta el destino solo si el sistema no sabe de dónde salió el cajón.** Si lo sabe, lo
  resuelve el backend; mandarlo sería pisar la fuente de verdad.
- **Toda respuesta de la API se valida con Zod** antes de entrar al estado de la UI.
- **Aviso de conexión persistente en el header**, conservando en pantalla el último dato bueno.

**Marca y lenguaje.** El wordmark de Aoki va sobre un header oscuro con el teal de marca
(`#1582a4`, tomado del logo), que es también el color de la acción primaria; ningún estado usa ese
teal, así que un botón nunca se lee como un estado. Los textos hablan el idioma del depósito: se
fueron "slot", "cola", "libros", "encolar" y "maniobra", y un slot `OCUPADO` se muestra como
**Listo**, que es lo que significa para quien va a buscar el cajón. El detalle técnico de un error
(ruta, esquema) va a la consola; en pantalla queda una frase que se entiende.

**La celda del tablero muestra solo el cajón.** El código del slot de pickeo no aparece: en el
depósito nadie lo conoce, y lo que se busca es la ubicación que da la app de picking. Qué lugar es
se ve por dónde está la celda, que espeja la estantería.

Diseñado para la tablet junto al robot: objetivos de toque de 56 px (por encima del mínimo de 44,
hay guantes), nada depende de `hover` ni de `title`, tipografía empaquetada en el bundle (la
sucursal puede no tener internet y el front anterior pedía Google Fonts), y cifras tabulares para
que los códigos no bailen en cada refresco.

### Backend (cambio mínimo)

`GET /api/slots` ahora expone `side`, `robotId`, `level` y `position` por slot. Los cuatro se
derivan de `locationCode` con `parseLocationCode`, que ya los calculaba. Sin esto, el front tendría
que reimplementar la gramática de ubicaciones, que es justo lo que se quiere evitar.

En `hydrateFromSnapshot` estos campos se recalculan siempre y nunca se toman del snapshot, que puede
ser anterior a que existieran.

`app.js` sirve el build de `packages/web` con fallback de SPA para las rutas del navegador, y monta
el front anterior en `/legacy`.

### Sin cambios

Ninguna otra ruta, ningún contrato de respuesta, ninguna migración de datos. Auth y `siteId` quedan
fuera de alcance por decisión de la spec; cuando el backend los exija se agregan en `api/client.ts`,
el único lugar del front que hace `fetch`.

## Verificación

- 55 tests del backend: pasan sin cambios.
- 36 tests unitarios (Vitest + Testing Library): disposición del tablero, condicionalidad de
  `targetLocation`, filtrado y orden de los pedidos, rangos de fecha, tolerancia de los esquemas.
- 10 tests funcionales (Playwright, viewport 1280×800 con `hasTouch`): ver el tablero, devolver un
  cajón con confirmación, cancelar sin encolar, destrabar una orden en error, navegar las tres
  rutas, caída de conexión, objetivos de toque ≥ 56 px, ausencia de scroll horizontal.
- `tsc -b` y `eslint` limpios.
- Bundle inicial: **183 kB gzip** (presupuesto de la spec: 250 kB). Métricas en chunk aparte.

Dos bugs propios los encontró la verificación, no la revisión: `ConnectionBanner` actualizaba estado
durante el render de otra ruta (resuelto con `useSyncExternalStore`) y el `useEffect` que limpiaba
el formulario de devolución (resuelto remontando por `key`).

## Notas de decisión

- **Se interceptó la API con `page.route` de Playwright en vez de MSW** (la spec decía MSW):
  Playwright ya intercepta red sin service worker ni dependencia extra. El glob `**/api/**` no sirve
  porque en dev también matchea los módulos fuente `/src/api/*.ts`; se filtra por pathname.
- **El teal de marca es la acción primaria y ningún estado lo usa.** Así se corrige la colisión
  verde-acción / verde-ocupado del front anterior. `OCUPADO` es violeta y no verde: un cajón
  esperando no es un "éxito", es trabajo pendiente.
- **`packages/web` no usa workspaces de npm.** Tiene su propio `node_modules` y no toca el
  `package.json` del backend más allá de dos scripts, para no rehoistear `better-sqlite3` (binario
  nativo) con un robot en producción.

## Pendiente

- **T17**: validación en la tablet real (legibilidad a distancia, uso con guantes). Requiere el
  hardware.
- **Retirar `/legacy`** y borrar `public/index.html` y `public/metricas.html` una vez que el front
  nuevo haya pasado una jornada completa contra el robot real.
