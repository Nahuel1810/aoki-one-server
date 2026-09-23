# Spec: Frontend nuevo — Vite + React + TypeScript

## Contexto

Hoy el front son dos archivos estáticos sin build servidos por Express:

- `public/index.html` — 1673 líneas (~700 CSS + ~830 JS inline). Gestión de pedidos y de dispositivos en dos tabs.
- `public/metricas.html` — 591 líneas. Reporte por rango de fechas.

No comparten tipografía, paleta, componentes ni navegación: no hay un solo enlace entre las dos
páginas en ningún sentido. Son dos productos visuales distintos sobre la misma API.

Deuda concreta que motiva el reemplazo, no la estética:

- **La lista de slots está hardcodeada en el navegador.** `RIGHT_PICK_SLOTS` / `LEFT_PICK_SLOTS`
  (`index.html:837-852`) duplican `src/config/pickSlots.js`, que es configurable por `PICK_SLOTS`.
  Ya pueden divergir; con multi-robot se rompe. `GET /api/slots` tiene la verdad y el front la
  ignora para construir el tablero.
- **Un toque en cualquier parte de un slot ocupado encola un PUT sin confirmación**
  (`index.html:1617-1625`). Eso mueve el carro físicamente. El propio código reconoce el riesgo en
  el panel de liberar slot ("no está en cada tarjeta para evitar toques accidentales") pero lo
  aplica al botón inocuo y no al que mueve el robot. En una tablet táctil, con la mano apoyada, es
  un accidente esperando.
- **Re-render por `innerHTML` completo cada 5 s sobre 4 endpoints.** Ya hay parches manuales por
  eso: `renderReleaseSlotBar` guarda `prev` para no perder la selección del `<select>`. Es
  reconciliación escrita a mano.
- **`renderKpis()` (`index.html:1128-1133`) calcula cuatro variables y no escribe nada al DOM.** El
  `<section class="hero">` quedó vacío pero su CSS (`.kpi-row`, `.kpi`, `.title`, `.subtitle`) sigue
  presente: ~80 líneas muertas.
- **`normalizeSlotStatus` mapea `FREE→LIBRE`, `OCCUPIED→OCUPADO`, etc. contra un backend que nunca
  devolvió inglés**: `SLOT_STATUS` en `StateManager.js:4` ya es español. Defensa inventada.
- **`metricas.html` no escapa nada** (línea 517, `row.locationCode` va directo al template),
  mientras `index.html` escapa a mano con `asSafe()`.
- **Colisión semántica de color**: el verde de marca es el de los botones primarios *y* el de "slot
  ocupado" (`.status-ok`). Acción y estado comparten color, y "ocupado" queda pintado de
  verde-éxito cuando operativamente es justo lo que requiere atención humana.
- Los errores de toda la vista de pedidos van a un `<div class="status-line">` al pie de la columna
  derecha, invisible en uso real.

### Dónde se usa

**Tablet táctil montada junto al robot.** El operario está de pie, posiblemente con guantes, sin
teclado físico ni mouse. Esto manda sobre todo lo demás: targets grandes, nada de `hover` como
mecanismo (los `title="..."` actuales no existen en táctil), nada de `<select>` nativos chicos, y
confirmación explícita para cualquier acción que mueva el robot.

### La tarea real

El flujo normal lo maneja el sistema de picking vía API: el operario **no crea pedidos**. La
pantalla es, la enorme mayoría del tiempo, un **display pasivo**. Se toca solo por excepción:
devolver un cajón, destrabar una orden en error, y muy de vez en cuando pedir un cajón a mano. Se
diseña para observación primero y acción por excepción segundo.

### Relación con la reescritura del backend

`docs/specs/2026-09-17-rewrite-ts-domain-agent.md` (Fase 1) mantiene deliberadamente las rutas y el
contrato `{ ok, data }` / `{ ok, error }`. Por eso el front puede rehacerse **antes** que el backend
sin quedar atado al cutover del robot en producción: si el front nuevo sale mal, no para la
operación. El backend queda para después.

## Requerimientos funcionales

### Navegación

- **RF01** Tres rutas planas, sin jerarquía ni permisos: `/` (zona de pickeo), `/dispositivos`,
  `/metricas`. Navegación siempre visible y alcanzable con el pulgar. Sin login, sin roles, sin
  gating: cualquiera que abra la tablet llega a las tres.

### Zona de pickeo (`/`) — vista principal

- **RF02** El tablero de slots se construye **exclusivamente desde `GET /api/slots`**. Ninguna
  constante de ubicaciones en el código del front.
- **RF03** Los slots se agrupan por robot y por lado (izquierdo / derecho), usando el campo `side`
  que la API pasa a exponer (ver *Cambios de API*). Con un solo robot el agrupamiento por robot no
  se muestra; aparece solo cuando hay más de uno.
- **RF04** Cada slot muestra **solo el cajón**: la ubicación que el operario ve en la app de
  picking, más el estado. El código del slot de pickeo **no se muestra** — en el depósito nadie lo
  conoce ni lo necesita: qué lugar es se deduce de dónde está la celda en el tablero, que espeja la
  estantería.
- **RF05** Estados de slot renderizados: `LIBRE`, `RESERVADO`, `BUSCANDO`, `OCUPADO`, `DEVOLVIENDO`,
  `ERROR` — los valores literales que ya devuelve la API. Sin capa de traducción de sinónimos.
- **RF06** Devolver un cajón: se toca el slot ocupado y se abre una confirmación que nombra
  explícitamente el cajón antes de mandar la orden. Nunca en un solo toque.
- **RF07** El tablero ocupa el **ancho completo**: es la tarea. Los pedidos van **debajo**, en fila,
  y solo ocupan lugar cuando hay algo en curso. Pedir o guardar a mano es acción **secundaria**.
- **RF08** Una orden en `ERROR` expone Reintentar y Cancelar. Las órdenes sanas no muestran esos
  botones: son acciones de excepción, no de rutina.
- **RF09** Estado del robot (en marcha / pausado) y su control, en un header persistente, no al pie
  de una columna.
- **RF10** Pedir y guardar a mano viven en un panel secundario que se abre bajo demanda, no
  ocupando la vista principal.
- **RF11** Marcar un lugar como vacío se mantiene como última opción, en el panel secundario, con
  confirmación y advirtiendo que el robot no se mueve: solo corrige lo que el sistema cree.
- **RF12** Se pregunta a dónde va el cajón **solo cuando el sistema no sabe de dónde salió**. Si lo
  tiene registrado, el destino lo resuelve el backend desde `currentBox.sourceLocationCode` y el
  campo no se muestra.
- **RF27** El selector de "guardar un cajón" ofrece **solo cajones reales**. Listar los lugares
  vacíos daba once opciones idénticas que decían "Lugar vacío", entre las que no se puede elegir.

### Dispositivos (`/dispositivos`)

- **RF13** La pantalla es de **diagnóstico**: por robot, si está operativo y, por equipo, si responde
  y **cuándo fue su última respuesta**. IP y puerto son dato secundario.
- **RF14** El alta y la edición de equipos viven en un **panel**, no en la pantalla: se hacen una vez
  por instalación. El backend hace upsert por `(robotId, type)`, así que editar es registrar de nuevo.
- **RF15** Cada equipo se puede configurar desde su fila, con los datos precargados.

### Métricas (`/metricas`)

- **RF16** Filtro por rango de fechas con presets táctiles (hoy, 7 días, 30 días) además del rango
  manual: elegir fechas con teclado en pantalla es el peor caso de esta tablet.
- **RF17** KPIs de **pedidos**, no de movimientos: traer un cajón y guardarlo es **un** pedido, no
  dos. Arriba va lo que mide si el sistema cumple su propósito — pedidos completados, espera
  promedio y máxima hasta tener el cajón, pedidos con error — y el desglose (picking / manuales /
  movimientos / movimientos por pedido / cuánto de la espera fue turno) queda como contexto.
  Cada magnitud en su propia tarjeta: "Pedidos 0" con "22 movimientos" de subtítulo obligaba a
  pensar para entender que no se contradecían.
- **RF18** Ranking de cajones más solicitados en el rango, ordenado por cantidad.
- **RF19** El contenido se escapa por construcción (JSX), cerrando el agujero de `metricas.html`.

### Marca y lenguaje

- **RF23** El wordmark de Aoki va en el header, sobre fondo oscuro de marca.
- **RF24** Los textos hablan el idioma del depósito, no el del sistema: nada de "slot", "cola",
  "libros", "encolar", "maniobra", rutas de API ni códigos de error en pantalla. Un slot `OCUPADO`
  se muestra como **Listo**, porque para el operario significa que su cajón ya lo está esperando.
- **RF25** Sin texto de relleno: una etiqueta o una ayuda existen solo si cambian lo que alguien
  va a hacer. El detalle técnico de un error va a la consola, no a la pantalla.
- **RF26** Cada vista y el panel de acciones **entran completos en la pantalla de la tablet**
  (1240×810 útiles), sin scroll vertical ni horizontal. La tablet se opera de pie: si hay que
  scrollear para ver el estado o completar una acción, se usa mal. Fijado con tests.

### Transversales

- **RF20** Toda respuesta de la API se valida con un esquema antes de entrar al estado de la UI. Una
  respuesta inesperada produce un error visible, no una pantalla rota a mitad de render.
- **RF21** Actualización automática cada 5 s con reintento y backoff. Al perderse la conexión con el
  servidor se muestra un aviso persistente; al recuperarse, desaparece solo.
- **RF22** Estados de carga y de vacío explícitos en las tres rutas. Nada de tablero en blanco
  mientras llega la primera respuesta.

## Requerimientos no funcionales

**Rendimiento**

- Sin re-render del árbol completo en cada poll: solo cambia lo que cambió.
- La actualización automática se suspende con la pestaña oculta (ya lo hace el front actual) y se
  reanuda al volver.
- Bundle inicial por debajo de 250 KB gzip. Métricas en chunk aparte por ruta.
- Sin polling cuando no hay nadie mirando esa ruta.

**Táctil e industrial**

- Objetivo de toque mínimo **56×56 px** (por encima del mínimo de 44 px: hay guantes de por medio).
  Separación mínima de 8 px entre objetivos adyacentes.
- Diseñado para landscape a 1280×800; utilizable desde 1024×768.
- Ninguna información ni acción dependiente de `hover`, `title` o clic derecho.
- Toda acción que mueva el robot pide confirmación explícita. Regla del sistema, no decisión por
  pantalla.
- Legibilidad a distancia de brazo con luz de galpón: contraste AA como piso, AAA en los datos del
  tablero.

**Calidad**

- TypeScript `strict: true`. Sin `any`.
- ESLint + Prettier + type-check antes del build.
- El front no reimplementa lógica de dominio: ni ubicaciones, ni traducción de estados, ni
  derivación de lado. Si hace falta un dato derivado, lo expone la API.

**Accesibilidad**

- El estado nunca se comunica solo por color: siempre color + etiqueta.
- Diálogos, foco y navegación por teclado resueltos por primitivas accesibles, no a mano.

**Despliegue**

- El build es estático y lo sirve el **mismo proceso Express**. El agente corre en una PC de
  sucursal; no se agrega un segundo proceso ni un segundo puerto.

**Fuera de alcance**

- Auth, login y `siteId`: no se modelan. Cuando el backend los exija se agregan en el cliente HTTP,
  que es el único lugar que emite requests.
- Tema oscuro: los tokens quedan preparados, pero no se implementa.
- Reemplazo del polling por SSE/WebSocket.

## Diseño de la solución

### Stack

| Pieza | Elección | Por qué |
|---|---|---|
| Build | Vite | Dev server instantáneo, build estático. Sin SSR: es una app de LAN, no tiene SEO ni first-load que optimizar. |
| UI | React 19 + TS strict | — |
| Datos | TanStack Query | Reemplaza `setInterval`, el flag `isRefreshingOrders`, el backoff inexistente y los parches de "guardar el valor previo". Es exactamente el problema que el front actual resuelve a mano y mal. |
| Estilos | Tailwind v4 | Tokens como variables CSS, sin runtime. |
| Componentes | shadcn/ui (Radix) | Accesible y headless: da diálogos y foco correctos sin imponer una marca. El código queda en el repo, no es una dependencia opaca. |
| Validación | Zod | Esquemas en el borde (RF20). |
| Router | React Router | Tres rutas, nada más. |
| Tests | Vitest + Testing Library; Playwright + MSW | Unitario para lógica de presentación, e2e para los flujos críticos. |

### Estructura

```
aoki-one-server/
├── packages/
│   └── web/
│       ├── src/
│       │   ├── api/          cliente HTTP + esquemas zod + hooks de Query
│       │   ├── components/   primitivas (shadcn) y compuestos
│       │   ├── routes/       pickeo/ · dispositivos/ · metricas/
│       │   ├── design/       tokens, estados, tipografía
│       │   └── main.tsx
│       └── vite.config.ts    build → ../../public-dist
├── src/                      backend actual (JS, sin tocar)
└── public/                   se elimina en el cutover
```

El cliente HTTP es el **único** lugar del front que hace `fetch`. Cuando el backend exija auth y
`siteId`, se toca un archivo.

### Decisiones clave

**El tablero se dibuja desde los datos, no desde una constante.** Es la corrección de fondo: hoy la
forma de la zona de pickeo vive en el navegador y el estado en el servidor, y nada garantiza que
coincidan. Pasa a haber una sola fuente.

**Confirmación sobre el toque destructivo, no sobre el inocuo.** Se invierte el criterio actual.

**El color se reserva al estado.** Neutros para todo el chrome y un único acento de marca para la
acción primaria, distinto de cualquier color de estado. Esto corrige la colisión verde-acción /
verde-ocupado. La semántica queda: `LIBRE` neutro sin relleno · `RESERVADO` / `BUSCANDO` /
`DEVOLVIENDO` ámbar con indicador de actividad · `OCUPADO` índigo (hay algo que retirar, no es
"éxito") · `ERROR` rojo. El verde queda solo para "sistema operando" en el header.

**Una sola tipografía, con cifras tabulares.** Inter Variable. Los códigos de ubicación y los
contadores dejan de bailar en cada actualización. Hoy hay cuatro familias entre las dos páginas.

**Movimiento mínimo y funcional.** Se eliminan el `fadeIn` global, el overlay de ruido, la grilla de
fondo y los `blur` de `metricas.html`. Animación solo donde comunica actividad física real.

### Trade-offs considerados

- **Rehacer el front antes que el backend**: invierte el orden que la spec de backend sugería (T22:
  "se mantiene el front actual"). Se adopta porque el contrato `{ ok, data }` está garantizado y
  porque el front no toca el robot: es el lado barato de equivocarse. La condición es no cortar los
  dos el mismo día.
- **Mantener el front sin build**: descartado. El re-render por `innerHTML` ya obliga a
  reconciliación manual con un solo robot.
- **Next.js**: descartado. SSR, routing de servidor y build pesado sin un solo beneficio en LAN.
- **Mantine / MUI**: descartados. Traen un lenguaje visual de dashboard genérico que después hay que
  pelear; shadcn parte de cero con tokens propios.
- **Proceso aparte para el front**: descartado. Una PC de sucursal, un proceso.
- **Web components o Lit**: descartado. Menos ecosistema para el problema de datos, que es el
  verdadero costo acá.

## Cambios de API/DB

Sin cambios de DB. Un solo cambio de API, mínimo:

| Endpoint | Cambio | Motivo |
|---|---|---|
| `GET /api/orders/metrics/report` | `summary` agrega `totalOrders` (pedidos: el PUT que cierra un PICK no cuenta aparte), `manualOrders`, y `pickingOrders` pasa a contar solo PICK. `totalManoeuvres` se conserva. | El KPI pedía movimientos del robot; lo que se quiere medir es cuántos pedidos hubo. |
| `GET /api/slots` | Agregar `side` (`LEFT`/`RIGHT`) y `robotId` a cada slot | RF03. `parseLocationCode` ya deriva `side` por paridad de módulo (`locationTranslator.js:57-58`), pero `buildInitialSlot` no lo persiste ni lo expone. Sin esto el front tendría que reimplementar la regla de paridad, que es justamente lo que se quiere evitar. |

Notas sobre endpoints existentes, sin cambio requerido:

- `GET /api/devices/robots` ya incluye `queue`, lo que hace redundante a
  `GET /api/orders/queue/status`. El front actual llama a los dos. El front nuevo usa
  `/api/orders/queue/status`, porque la spec del backend documenta que `queue` en
  `/api/devices/robots` devuelve `{}` con driver externo (Promise sin `await`). Se consolidan cuando
  ese bug se corrija.
- `POST /api/orders` con `type: "PUT"` hoy acepta `targetLocation` opcional. El front nuevo lo envía
  solo cuando el slot no tiene cajón registrado (RF12), que es el comportamiento que la spec del backend
  fija. Contra el backend actual funciona igual.
- `app.js` debe servir el build de `packages/web` en lugar de `public/` (una línea, en el cutover).

## UI / Tarea principal

**La tarea es mirar.** El operario levanta la vista, ve qué cajón hay en cada slot y sigue
trabajando. Todo lo demás es excepción.

Jerarquía de `/`:

1. **El tablero de slots** domina la pantalla. Es el único elemento que se lee de lejos. El código de
   ubicación del cajón es el dato más grande de la interfaz.
2. **Estado del sistema** en el header: operando o en pausa, y si hay algo en error. Persistente.
3. **Los pedidos** como columna lateral: qué viene y qué se está haciendo ahora.
4. **Las acciones manuales**, detrás de un toque, en un panel que se abre.

Un slot comunica cuatro cosas y ninguna más: qué cajón tiene, en qué estado está, si se está
moviendo, y si se puede tocar. Sin metadatos, sin timestamps, sin IDs internos.

## Tasks

- [x] **T01** Andamiaje: `packages/web` con Vite + React + TS strict, ESLint, Prettier, type-check.
- [x] **T02** Design system: tokens (color de estado vs. acento de marca, tipografía con cifras tabulares, escala táctil de 56 px) y primitivas shadcn base (botón, diálogo, campo, badge).
- [x] **T03** Cliente HTTP único + esquemas zod de todas las respuestas + hooks de TanStack Query con polling, backoff y suspensión por visibilidad (RF20, RF21).
- [x] **T04** Layout y las tres rutas con navegación táctil persistente (RF01).
- [x] **T05** Backend: exponer `side` y `robotId` en `GET /api/slots`.
- [x] **T06** Tablero de slots desde la API, agrupado por robot y lado (RF02-RF05).
- [x] **T07** Devolución de cajón con confirmación explícita (RF06).
- [x] **T08** Cola de pedidos con acciones de excepción en órdenes en error (RF07, RF08).
- [x] **T09** Header de estado del sistema con pausa/reanudación (RF09).
- [x] **T10** Panel de acciones manuales: buscar cajón, devolver manual con `targetLocation` condicional, liberar slot (RF10-RF12).
- [x] **T11** Ruta `/dispositivos` (RF13-RF15).
- [x] **T12** Ruta `/metricas` con presets de rango (RF16-RF19).
- [x] **T13** Estados de carga, vacío y error en las tres rutas (RF22).
- [x] **T14** Build estático servido por Express. **El front anterior no se eliminó**: quedó servido
      en `/legacy` hasta que el nuevo pase una jornada contra el robot real, para poder volver atrás
      sin rebuild (ver Nota de riesgo).
- [x] **T15** Tests unitarios (Vitest + Testing Library): derivación de estado de slot, agrupación por lado, condicionalidad de `targetLocation`, formateo de métricas.
- [x] **T16** Tests funcionales (Playwright + MSW): ver el tablero, devolver un cajón con confirmación, destrabar una orden en error.
- [ ] **T17** Verificación en la tablet real: tamaños de toque con guantes, legibilidad y ausencia de
      dependencias de hover. **Pendiente: requiere el hardware.** Los e2e cubren lo automatizable
      (objetivos ≥ 56 px y ausencia de scroll horizontal a 1280×800), pero legibilidad a distancia y
      uso con guantes se validan en el equipo real.
- [x] **T18** Descripción de PR.

> **Nota**: hay un robot en producción, pero esta spec no lo toca — salvo T05, que agrega dos campos
> de solo lectura a una respuesta existente. El cutover es reemplazar archivos estáticos y es
> reversible dejando `public/` en su lugar hasta validar.
