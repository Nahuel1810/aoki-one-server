# Spec: Reescritura TypeScript — `domain/` + `agent/` (Fase 1)

## Contexto

`aoki-one-server` orquesta robots (carro + elevador) sobre PLCs Festo por Modbus TCP.
Hoy: JavaScript, una sola sucursal, un solo robot, servidor corriendo en una PC de la
LAN de la sucursal, estado autoritativo en memoria (`StateManager`) con snapshot JSON
completo volcado a SQLite en cada paso. Expuesto a internet con VSCode Ports.

El objetivo del negocio es operar **varios robots en varias sucursales**. Eso obliga a
partir el sistema en dos: un **agente por sucursal** (dueño del lazo de control Modbus,
que no puede viajar por internet) y un **plano de control en la nube** (API pública,
cola durable, métricas). La reescritura no se justifica por calidad del código actual
—que es razonable— sino porque la topología destino es otra y el estado en memoria como
fuente de verdad es un callejón sin salida.

**Esta spec cubre la Fase 1: `domain/` + `agent/`.** El agente reemplaza funcionalmente
al servidor actual con el mismo alcance (una sucursal, sin nube), de modo que se pueda
hacer el cambio contra el robot real antes de agregar nada nuevo. `cloud/` es Fase 2.

Usuarios: la app de picking (manda PICK vía API), los operarios de la sucursal (front
propio: ver cola, devolver cajones, destrabar errores).

### Modelo de dominio acordado

```
Sucursal (siteId)
 └── Estantería = Robot (1 carro + 1 elevador)
      ├── Ubicaciones de guardado (cajones con artículos)
      └── Slots de pickeo (lado IZQ / lado DER — el carro no cruza de lado)
```

El flujo normal: picking pide un cajón → el robot lo trae a un slot de pickeo → el
operario saca artículos → se devuelve el cajón a su ubicación original.

### Conocimiento que se porta, no se re-deriva

Sale de horas de planta y se migra con sus tests como contrato de aceptación:
gramática de `locationCode`, traducción a comandos de carro/elevador, tabla de códigos
y errores del PLC, handshake de paso (incluido el split high/low del carro), mutex por
dispositivo, clasificación de errores de conectividad, ranking de slot por cercanía.

## Requerimientos funcionales

### Dominio puro (`packages/domain`)

- **RF01** Parseo de `locationCode` con formato `<estantería><módulo:2>A<nivel:A-L><posición:1>[T|D|L]`.
  Deriva: `baseCode`, estantería, módulo, **lado** (paridad del módulo: par = derecho,
  impar = izquierdo), nivel numérico (A=1…L=12), posición. Rechaza formatos inválidos.
- **RF02** Traducción a comandos: carro = `<posición><parante:2><ladoBit><acciónBit>`,
  donde parante = `ceil(módulo/2)`; elevador ir-a-nivel = `100 + nivel`.
- **RF03** Protocolo PLC: códigos de comando (carro `INIT 41000`, etc.) y decodificación
  de respuesta — `100` OK, `101–199` error (código = valor − 100), `200–299` nivel,
  `300`/`301` presencia de carro. Error `99` es **fatal** (no se reintenta).
- **RF04** Secuencia física de una orden (5 pasos):
  `HOMING → ELEVADOR(nivel origen) → CARRO_BUSCA → ELEVADOR(nivel destino) → CARRO_DEJA|CARRO_DEVUELVE`.
- **RF05** Selección de slot para PICK: **solo slots del mismo lado que el origen**
  (limitación física), ordenados por cercanía — mismo nivel primero, luego distancia de
  nivel, luego distancia de módulo, luego posición.
- **RF06** Máquina de estados de slot: `LIBRE → RESERVADO → BUSCANDO → OCUPADO → DEVOLVIENDO → LIBRE`,
  más `ERROR` para slot inutilizable. Transiciones inválidas son error del dominio, no
  un estado silencioso.
- **RF07** Refcount de devoluciones pendientes (`pendingReturns`, hoy `logicalPickStackDepth`):
  un PICK sobre un cajón que **ya está** en un slot no genera maniobra física, incrementa
  el contador y la orden termina `DONE`. Un PUT con `pendingReturns > 1` decrementa y
  termina `DONE` sin maniobra. Solo el último PUT hace la devolución física.
  Motivo: que dos pedidos del mismo cajón exijan dos devoluciones, para que ningún
  pedido quede sin atender.

### Orquestación (`packages/agent`)

- **RF08** Una orden activa por robot. Cola FIFO por robot.
- **RF09** Orden de servicio: FIFO, con **PICK antes que PUT**. Excepción: si la zona de
  pickeo **de ese lado** está llena, los PUT pasan al frente hasta liberar un slot
  (evita el deadlock de un PICK encabezando la cola sin slots disponibles).
- **RF10** Espera por slot: si no hay slot libre del lado correspondiente, la orden queda
  en espera **sin perder su lugar** y se reactiva **por evento** al liberarse un slot de
  ese lado. La espera es FIFO por `(robot, lado)`: una orden esperando el lado izquierdo
  no bloquea a una que espera el derecho.
- **RF11** PUT — resolución de destino:
  - Slot **con cajón en libros** → destino = `currentBox.sourceLocationCode`; se ignora
    cualquier `targetLocation` recibido.
  - Slot **vacío en libros** (devolución manual fuera-de-libros: alguien tomó el cajón a
    mano, lo restockeó y lo apoya en un slot) → `targetLocation` es **obligatorio**;
    sin él se rechaza con `400`.
  - Nunca se acepta una devolución cuyo destino sea el propio slot.
- **RF12** Avance por confirmación, no por envío: un paso solo avanza cuando el PLC
  responde el código esperado y se verifica el reset de registros.
- **RF13** Recuperación ante fallo de paso — invariante único: **el operario devuelve el
  cajón al punto de origen del paso que falló** y el retry replaya la orden completa
  desde `HOMING`. El slot **conserva su estado** (`RESERVADO` si falló un PICK,
  `OCUPADO` si falló un PUT) a la espera del retry; no pasa a `ERROR`.
  `ERROR` de slot queda reservado para slots realmente inutilizables.
- **RF14** Idempotencia: dedupe de órdenes por `(siteId, externalOrderId)`. Un reenvío
  devuelve la orden existente con `200`, no crea una nueva.
- **RF15** Rehidratación tras reinicio: las órdenes `IN_PROGRESS` vuelven a `PENDING` y
  se reencolan respetando su antigüedad; los slots conservan su estado persistido.

### Transporte Modbus (`packages/agent`)

- **RF16** Un cliente Modbus por dispositivo, con **mutex por dispositivo**: jamás dos
  operaciones simultáneas sobre el mismo socket TCP.
- **RF17** Handshake de paso: escribir `messageIn` (carro: valor partido en dos
  registros consecutivos, high/low), pollear `messageOut` hasta el código esperado,
  resetear `messageIn` y verificar `messageOut = 0`.
- **RF18** Monitor de conectividad con backoff exponencial, recreación de cliente tras N
  fallos y hard-reset de transporte como último recurso. El monitor **cede el socket**
  cuando el orquestador está ejecutando una orden.
- **RF19** Clasificación de errores: solo los de transporte se reintentan. Las excepciones
  Modbus de aplicación y los errores de programación fallan rápido.
- **RF20** Modo simulación (`SIMULATE_PLC`) para operar sin PLC. **Default `false`**:
  arrancar sin configuración no debe simular en silencio.

### API y persistencia (`packages/agent`)

- **RF21** Endpoints: alta de órdenes PICK/PUT, consulta y listado, retry, cancel,
  pausa/reanudación de cola, registro y estado de dispositivos, comando directo a PLC,
  listado y liberación manual de slots, métricas, health.
- **RF22** Toda la API autenticada. El endpoint de ingreso de pedidos valida además
  HMAC del body + timestamp (anti-replay). `siteId` viaja en el body y se valida contra
  la credencial: una sucursal no puede crear órdenes de otra.
- **RF23** Persistencia en SQLite como **fuente de verdad**, con escrituras incrementales
  por entidad. Se elimina el volcado de snapshot completo.
- **RF24** Métricas por orden (espera, duración, estado, ubicación) con reporte filtrable
  por rango de fechas.
- **RF25** `/health` informa estado real: conectividad por dispositivo, profundidad de
  cola por robot, última orden completada, timestamp de arranque.

## Requerimientos no funcionales

**Rendimiento**
- Ninguna operación O(n) sobre el total histórico de órdenes en el camino caliente:
  el dedupe por `(siteId, externalOrderId)` va por índice, no por scan.
- Sin serialización del estado completo por paso (hoy: `getSnapshot()` en cada step).
- Sin busy-loops: la espera por slot y el avance de cola son por evento, no por polling
  de 300 ms. El tick queda solo como red de seguridad de baja frecuencia.
- El estado persistido no crece sin techo: retención configurable para eventos, comandos
  y errores, con purga.

**Latencia y robustez**
- Se mantiene el polling de `messageOut` a 150 ms (latencia percibida de maniobra).
- **Deadline explícito por paso y por orden.** Hoy un paso puede tardar minutos
  (90 s de ACK + hasta 66 s de reintentos de conectividad) sin que nadie lo corte.
- El agente nunca queda colgado indefinidamente: todo bucle tiene salida acotada.

**Seguridad**
- Sin endpoints anónimos. El comando directo al PLC exige rol elevado.
- Validación de entrada por esquema (zod) en todos los endpoints.
- El agente **no expone puertos a internet**. Su API escucha en la LAN de la sucursal.

**Calidad**
- TypeScript estricto, `strict: true`, sin `any`.
- `domain/` es puro: sin I/O, sin `Date.now()` ni `randomUUID` directos (se inyectan),
  100% testeable sin mocks de red.
- ESLint + Prettier + type-check en CI.
- Los 55 tests actuales se portan **antes** de escribir el código nuevo y deben pasar.

**Observabilidad**
- Logs estructurados con nivel y correlación por orden.
- Heartbeat del agente (preparado para que en Fase 2 la nube detecte sucursal caída).

## Diseño de la solución

### Estructura

```
packages/
  domain/   Tipos + lógica pura. Sin I/O. Compartido con cloud/ en Fase 2.
            locationCode, plcProtocol, slotSelection, slotStateMachine,
            orderStateMachine, pendingReturns, orden de servicio de cola.
  agent/    Corre en la sucursal.
            orchestrator/  loop por robot, ejecución de pasos, retry, deadlines
            transport/     ModbusClient, DeviceMutex, clasificación de errores
            persistence/   SQLite (repositorios por entidad, migraciones)
            api/           HTTP local + auth + validación
  cloud/    Fase 2. No se implementa acá.
```

### Decisiones clave

**Estado en SQLite, no en memoria.** El `Map` en memoria deja de ser autoritativo y pasa
a ser, como mucho, caché derivado. Habilita reinicios sin pérdida, escrituras
incrementales baratas y —clave para Fase 2— que el estado sea consultable por la nube.

**Tipos como uniones discriminadas.** Estados de slot, de orden, tipos de paso y `kind`
de respuesta del PLC hoy son strings sueltos. Pasan a ser uniones, y las transiciones a
funciones totales: el compilador obliga a cubrir cada caso.

**Máquina de estados explícita.** Hoy las transiciones de slot y orden están dispersas en
`OrchestratorService` (757 líneas). Se extraen a funciones puras
`(estadoActual, evento) → estadoNuevo | error`, testeables sin Modbus ni HTTP.

**Puerto de origen de órdenes.** El orquestador consume de una interfaz `OrderSource`,
no de una cola concreta. En Fase 1 la implementa la cola SQLite local; en Fase 2, el
cliente que recibe órdenes de la nube. El agente no cambia de forma por eso.

**Deadlines en todos los niveles.** Cada paso y cada orden llevan presupuesto de tiempo.
Al agotarse, la orden va a `ERROR` con causa explícita en vez de quedar colgada.

### Trade-offs considerados

- **Refactor incremental en vez de reescritura**: descartado para el shell (topología y
  modelo de datos distintos), adoptado para el núcleo empírico (protocolo, traducción,
  handshake) que se porta con sus tests.
- **SQLite y no Postgres en el agente**: el agente es de una sola sucursal y debe
  funcionar con internet caído. SQLite no agrega operación. Postgres vive en la nube.
- **Sin Redis/SQS en Fase 1**: la cola durable compartida es un problema de la nube.
  Meterla ahora agrega una dependencia de red a un componente que tiene que sobrevivir
  sin red.
- **Se mantiene el front actual** apuntando a la API nueva. Rediseñarlo ahora mezcla dos
  riesgos en el mismo cutover.

## Cambios de API/DB

### API — diferencias contra el servidor actual

| Cambio | Detalle |
|---|---|
| Auth | Todos los endpoints. HMAC + timestamp en el ingreso de pedidos. |
| `siteId` | Obligatorio al crear órdenes; validado contra la credencial. |
| `targetLocation` en PUT | Obligatorio **solo** si el slot está vacío en libros; ignorado si el slot tiene cajón. Antes: opcional y, si faltaba, devolvía el cajón al mismo slot. |
| `priority` | Se elimina del modelo. Lo reemplaza la regla PICK-antes-que-PUT de RF09. |
| `HTTP_PORT` | Se respeta la variable de entorno (hoy está hardcodeado en `3000`). |
| `/health` | Pasa a health profundo (RF25). |
| `/api/devices/robots` | Se corrige: hoy devuelve `{}` en `queue` con driver externo (Promise sin `await`). |
| `/api/orders/simulate` | Deja de exponer campos que nunca se calculan (`address`, `responseAddress`, `verifyAddress`, `expectedValue`). |
| `SIMULATE_PLC` | Default pasa a `false`. |

Se mantienen las rutas y el contrato de respuesta `{ ok, data }` / `{ ok, error }` para
no romper el front existente.

### DB — esquema nuevo (SQLite, con migraciones)

- `sites(id, name, created_at)`
- `robots(id, site_id, estanteria_code, enabled, status, current_order_id)` — único por `(site_id, estanteria_code)`
- `devices(id, robot_id, type, host, port, unit_id, register_map_json, status, last_seen)`
- `slots(id, robot_id, location_code, side, status, reserved_by_order_id, current_box_json, pending_returns, updated_at)`
- `orders(id, site_id, robot_id, external_order_id, type, origin, status, location_code, target_location, slot_location_code, current_step_index, waiting_for_slot, error_reason, created_at, started_at, finished_at)`
  — índice único `(site_id, external_order_id)`; índice `(robot_id, status, created_at)` para la cola FIFO
- `order_steps(id, order_id, seq, type, device_type, status, retries, started_at, finished_at)`
- `order_history(id, order_id, ts, event, metadata_json)`
- `events(id, ts, entity_type, entity_id, event, metadata_json)` — con purga por retención
- `order_metrics(...)` — se mantiene el esquema actual más `site_id`

Migración desde la base actual: script de importación de `slots` y órdenes abiertas
(el histórico de métricas se conserva agregando `site_id` con valor por defecto).

## UI / Tarea principal

Sin pantallas nuevas en Fase 1. El front actual (`public/index.html`) se repunta a la
API nueva. Tareas del operario, en orden de frecuencia: ver el estado de la zona de
pickeo (qué cajón hay en cada slot), devolver un cajón, destrabar una orden en error.
El rediseño del front queda fuera de alcance.

## Tasks

- [ ] **T01** Andamiaje: monorepo (`packages/domain`, `packages/agent`), TS estricto, ESLint, Prettier, CI con type-check + tests.
- [ ] **T02** Portar los 55 tests actuales como suite de aceptación (rojos al inicio; son el contrato).
- [ ] **T03** `domain`: tipos y uniones discriminadas (slot, orden, paso, respuesta PLC).
- [ ] **T04** `domain`: `locationCode` — parseo, lado por paridad, nivel, posición (RF01).
- [ ] **T05** `domain`: traducción a comandos de carro y elevador (RF02).
- [ ] **T06** `domain`: protocolo y decodificación de respuestas PLC, errores fatales (RF03).
- [ ] **T07** `domain`: selección de slot por lado y cercanía (RF05).
- [ ] **T08** `domain`: máquina de estados de slot + `pendingReturns` (RF06, RF07).
- [ ] **T09** `domain`: máquina de estados de orden y secuencia de pasos (RF04).
- [ ] **T10** `domain`: orden de servicio de cola — FIFO, PICK-antes-que-PUT, inversión por zona llena (RF09).
- [ ] **T11** `agent`: esquema SQLite, migraciones y repositorios por entidad (RF23).
- [ ] **T12** `agent`: cola persistente + espera por slot por evento, FIFO por `(robot, lado)` (RF08, RF10).
- [ ] **T13** `agent`: `ModbusClient` + `DeviceMutex` + clasificación de errores de conectividad (RF16, RF19).
- [ ] **T14** `agent`: handshake de paso con verificación de reset (RF12, RF17).
- [ ] **T15** `agent`: monitor de conectividad con backoff, recreación y cesión de socket (RF18).
- [ ] **T16** `agent`: orquestador — loop por robot, retry, deadlines por paso y orden (RF13).
- [ ] **T17** `agent`: resolución de destino de PUT y devolución manual fuera-de-libros (RF11).
- [ ] **T18** `agent`: dedupe idempotente por `(siteId, externalOrderId)` (RF14) y rehidratación (RF15).
- [ ] **T19** `agent`: API HTTP con validación zod, auth y HMAC en ingreso de pedidos (RF21, RF22).
- [ ] **T20** `agent`: métricas y `/health` profundo (RF24, RF25).
- [ ] **T21** `agent`: logs estructurados, retención y purga de eventos.
- [ ] **T22** Repuntar `public/index.html` a la API nueva.
- [ ] **T23** Script de migración de datos desde la base actual.
- [ ] **T24** Tests unitarios (cobertura completa de `domain`).
- [ ] **T25** Tests funcionales: e2e con PLC simulado, incluidos los caminos de error y recuperación.
- [ ] **T26** Plan de cutover: correr el agente nuevo en paralelo, validar una jornada completa contra el robot real, recién ahí dar de baja el servidor actual.
- [ ] **T27** Descripción de PR.

## Fuera de alcance (Fase 2)

Paquete `cloud/`, conexión saliente agente→nube (HTTPS long-poll o MQTT/TLS), cola
durable compartida, API pública con dominio propio, Postgres, dashboard multi-sucursal,
y el retiro definitivo de VSCode Ports como exposición del webhook.

> **Nota de riesgo**: hay un robot en producción. Nada de big-bang — ver T26.
