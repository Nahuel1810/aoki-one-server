# Spec: Reescritura TypeScript — `domain/` + `agent/` + `server/` (Fase 1)

## Contexto

`aoki-one-server` orquesta robots (carro + elevador) sobre PLCs Festo por Modbus TCP.
Hoy: JavaScript, una sola sucursal, un solo robot, servidor corriendo en una PC de la
LAN de la sucursal, estado autoritativo en memoria (`StateManager`) con snapshot JSON
completo volcado a SQLite en cada paso. Expuesto a internet con VSCode Ports.

El objetivo del negocio es operar **varios robots en varias sucursales**. Eso obliga a
partir el sistema en dos planos: un **agente por sucursal** (dueño del lazo de control
Modbus, que no puede viajar por internet) y un **servidor de pedidos** (API pública, cola
durable, histórico). La reescritura no se justifica por calidad del código actual —que es
razonable— sino porque la topología destino es otra y el estado en memoria como fuente de
verdad es un callejón sin salida.

### Topología destino de esta fase

```
App de picking ──HTTPS + HMAC──▶  Servidor Linux propio  (packages/server)
                                  cola durable · dedupe · histórico
                                              ▲
                                              │ long-poll HTTPS saliente
                                              │ (lo inicia siempre el agente)
Sucursal — LAN ───────────────────────  Notebook  (packages/agent)
                                              │             │
                 Tablet del operario ◀──HTTP LAN            └──Modbus TCP──▶ PLCs Festo
```

El agente sigue corriendo en una notebook de la LAN de la sucursal —es la única forma de
hablar Modbus con los PLCs— pero **deja de ser el punto de entrada de los pedidos**. La app
de picking pasa a apuntar al servidor Linux, y con eso **se retira VSCode Ports**: el agente
no expone ningún puerto a internet, solo abre conexiones salientes.

**Esta spec cubre la Fase 1: `domain/` + `agent/` + `server/`.** Entre los tres reemplazan
funcionalmente al servidor actual con el mismo alcance operativo (una sucursal, un robot),
de modo que se pueda hacer el cambio contra el robot real antes de agregar nada nuevo. Lo
multi-sucursal es Fase 2.

Usuarios: la app de picking (manda PICK al servidor Linux), los operarios de la sucursal
(front propio contra el agente: ver cola, devolver cajones, destrabar errores).

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
- **RF14** Idempotencia: el dedupe por `(siteId, externalOrderId)` es responsabilidad del
  servidor (RF26). El agente mantiene además el mismo índice único localmente, porque
  admite órdenes manuales sin enlace (RF35) y porque una re-entrega del servidor tras un
  lease vencido no debe crear una segunda orden.
- **RF15** Rehidratación tras reinicio: las órdenes `IN_PROGRESS` vuelven a `PENDING` y
  se reencolan respetando su antigüedad; los slots conservan su estado persistido. Al
  recuperar el enlace, el agente reconcilia antes de pedir trabajo nuevo: drena el outbox
  (RF34) y re-reclama las órdenes que tenía en vuelo.

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

### API local y persistencia (`packages/agent`)

- **RF21** Endpoints de la API LAN: alta de órdenes **manuales** PICK/PUT desde la tablet,
  consulta y listado, retry, cancel, pausa/reanudación de cola, registro y estado de
  dispositivos, comando directo a PLC, listado y liberación manual de slots, métricas,
  health. El ingreso de pedidos de picking ya no entra por acá: entra por el servidor (RF26).
- **RF22** Autorización de la API local en dos niveles, **sin login de usuario**:
  - **Operario — sin credencial.** Todo lo que consume la tablet: slots, alta de órdenes
    manuales, retry, cancel, pausa/reanudación, liberación manual de slot, listado y alta
    de dispositivos, métricas, health. El control es de red: el listener bindea a la IP de
    LAN (`HTTP_BIND`), no hay ruta desde internet y el proceso no expone puertos hacia
    afuera. Estar en la red de la sucursal equivale a estar parado frente a la tablet. Un
    token embebido en el bundle que sirve el propio agente no agregaría nada: quien puede
    pedir el bundle se lo lleva.
  - **Mantenimiento — token.** Solo el comando directo a PLC, que escribe registros Modbus
    salteándose el orquestador y las máquinas de estado. Token estático de la configuración
    del agente, por header. No viaja en el bundle del front: se usa desde una herramienta de
    diagnóstico.

  Son credenciales distintas de las otras dos del sistema: el HMAC de picking y la
  autenticación de cliente viven en el servidor (RF26), que es el único componente expuesto
  a internet, y la credencial de sucursal (RF32) solo se usa en sentido saliente.
- **RF23** Persistencia en SQLite como **fuente de verdad de la ejecución** (slots, cajones,
  pasos, estado del robot), con escrituras incrementales por entidad. Se elimina el volcado
  de snapshot completo. El servidor es fuente de verdad de la **admisión** de pedidos; el
  agente nunca consulta al servidor para decidir un paso físico.
- **RF24** Métricas por orden (espera, duración, estado, ubicación) con reporte filtrable
  por rango de fechas.
- **RF25** `/health` informa estado real: conectividad por dispositivo, profundidad de
  cola por robot, última orden completada, timestamp de arranque y **estado del enlace con
  el servidor** (conectado / degradado, último contacto, tamaño del outbox).

### Servidor de pedidos (`packages/server`)

Corre en un Linux propio, fuera de la sucursal. Es el único componente expuesto a internet.

- **RF26** Ingreso de pedidos: endpoint autenticado que valida HMAC del body + timestamp
  (anti-replay). `siteId` viaja en el body y se valida contra la credencial: una sucursal no
  puede crear órdenes de otra. Dedupe por `(siteId, externalOrderId)` con índice único; un
  reenvío devuelve la orden existente con `200`, no crea una nueva.
- **RF27** Cola durable por `(siteId, robotId)`, con el estado de cada orden y su histórico
  de transiciones. Sobrevive a reinicios del servidor y del agente.
- **RF28** Entrega por long-poll: el agente pide trabajo y el servidor retiene la conexión
  hasta que hay órdenes o vence el timeout. Lo entregado queda con **lease** a nombre de ese
  agente; si el lease vence sin reporte, la orden vuelve a estar disponible. La re-entrega
  usa el mismo `externalOrderId`, de modo que el dedupe del agente (RF14) la absorbe sin
  duplicar trabajo físico.
- **RF29** Reporte de estado: el agente informa transiciones de orden. El servidor las
  aplica de forma idempotente, ordenadas por secuencia monótona por orden; un reporte viejo
  o repetido se descarta sin efecto.
- **RF30** Consulta de estado de orden para la app de picking, por `externalOrderId`.
- **RF31** Presencia: el agente envía heartbeat; el servidor marca la sucursal como caída
  tras N heartbeats perdidos y lo expone en su health.
- **RF32** Autenticación agente↔servidor por credencial de sucursal. Toda la comunicación
  la **inicia el agente**: el servidor nunca abre una conexión hacia la sucursal.

### Sincronización (`packages/agent`)

- **RF33** Espejo local: toda orden reclamada se persiste en SQLite **antes** de empezar a
  ejecutarse. La ejecución de una orden nunca depende de que el enlace esté vivo.
- **RF34** Outbox: las transiciones que no se pudieron reportar se acumulan y se drenan al
  reconectar, en orden y con reintento idempotente. Ningún cambio de estado se pierde por
  una caída de red.
- **RF35** Órdenes locales: las que crea el operario desde la tablet se admiten y ejecutan
  **sin enlace**, con `externalOrderId` generado localmente y prefijado por agente para no
  colisionar con los de picking. Se empujan al servidor al reconectar.
- **RF36** Degradación explícita: sin enlace el agente sigue operando con lo que tiene en su
  cola local y lo informa por `/health` (RF25), para que el front muestre el aviso. No hay
  modo silencioso: o está sincronizado o lo dice.
- **RF37** Backoff en el long-poll: reconexión con backoff exponencial, jitter y techo. Un
  servidor caído no genera una tormenta de reintentos.

## Requerimientos no funcionales

**Rendimiento**
- Ninguna operación O(n) sobre el total histórico de órdenes en el camino caliente:
  el dedupe por `(siteId, externalOrderId)` va por índice, no por scan.
- Sin serialización del estado completo por paso (hoy: `getSnapshot()` en cada step).
- Sin busy-loops: la espera por slot y el avance de cola son por evento, no por polling
  de 300 ms. El tick queda solo como red de seguridad de baja frecuencia. El long-poll no
  cuenta como polling: la conexión queda retenida en el servidor.
- El estado persistido no crece sin techo: retención configurable para eventos, comandos
  y errores, con purga.

**Latencia y robustez**
- Se mantiene el polling de `messageOut` a 150 ms (latencia percibida de maniobra).
- **Deadline explícito por paso y por orden.** Hoy un paso puede tardar minutos
  (90 s de ACK + hasta 66 s de reintentos de conectividad) sin que nadie lo corte.
- El agente nunca queda colgado indefinidamente: todo bucle tiene salida acotada.
- El enlace con el servidor tiene su propio timeout y **no participa** de los deadlines de
  paso ni de orden: una red lenta no puede abortar una maniobra en curso.

**Seguridad**
- El **agente no expone puertos a internet**. Su API escucha en la LAN de la sucursal y
  hacia afuera solo abre conexiones salientes. Se retira VSCode Ports.
- El **servidor** es el único expuesto: TLS, sin endpoints anónimos, HMAC + timestamp en el
  ingreso de pedidos, credencial por sucursal para el agente.
- El comando directo al PLC exige rol elevado y existe solo en la API local.
- Validación de entrada por esquema (zod) en todos los endpoints, de los dos lados.

**Calidad**
- TypeScript estricto, `strict: true`, sin `any`.
- `domain/` es puro: sin I/O, sin `Date.now()` ni `randomUUID` directos (se inyectan),
  100% testeable sin mocks de red.
- ESLint + Prettier + type-check en CI.
- Los 55 tests actuales se portan **antes** de escribir el código nuevo y deben pasar.

**Observabilidad**
- Logs estructurados con nivel y correlación por orden, con el mismo id a los dos lados
  del enlace.
- Heartbeat del agente: el servidor detecta la sucursal caída (RF31).

## Diseño de la solución

### Estructura

```
packages/
  domain/   Tipos + lógica pura. Sin I/O. Compartido por agent/ y server/.
            locationCode, plcProtocol, slotSelection, slotStateMachine,
            orderStateMachine, pendingReturns, orden de servicio de cola.
  agent/    Corre en la notebook de la sucursal.
            orchestrator/  loop por robot, ejecución de pasos, retry, deadlines
            transport/     ModbusClient, DeviceMutex, clasificación de errores
            sync/          cliente long-poll, outbox, reconciliación
            persistence/   SQLite (repositorios por entidad, migraciones)
            api/           HTTP local (LAN) + validación
  server/   Corre en el Linux propio. Único componente expuesto a internet.
            api/           ingreso de pedidos (HMAC), consulta, endpoints de agente
            queue/         cola durable, leases, entrega por long-poll
            persistence/   SQLite (repositorios por entidad, migraciones)
  web/      Front del operario. Spec propia:
            docs/specs/2026-09-21-frontend-vite-react.md
```

### Decisiones clave

**Estado en SQLite, no en memoria.** El `Map` en memoria deja de ser autoritativo y pasa
a ser, como mucho, caché derivado. Habilita reinicios sin pérdida, escrituras
incrementales baratas y que el estado sobreviva a las caídas de enlace con el servidor.

**Tipos como uniones discriminadas.** Estados de slot, de orden, tipos de paso y `kind`
de respuesta del PLC hoy son strings sueltos. Pasan a ser uniones, y las transiciones a
funciones totales: el compilador obliga a cubrir cada caso.

**Máquina de estados explícita.** Hoy las transiciones de slot y orden están dispersas en
`OrchestratorService` (757 líneas). Se extraen a funciones puras
`(estadoActual, evento) → estadoNuevo | error`, testeables sin Modbus ni HTTP.

**Puerto de origen de órdenes.** El orquestador consume de una interfaz `OrderSource`, no
de una cola concreta. La implementación de producción es el cliente long-poll contra el
servidor, respaldado por la cola SQLite local; una cola puramente local queda como
implementación de prueba y como modo de contingencia. El orquestador no sabe de dónde
vienen las órdenes.

**Dos libros, no uno.** El servidor es fuente de verdad de **qué pedidos existen**
(admisión, idempotencia, histórico). El agente es fuente de verdad de **qué está pasando
físicamente** (slots, cajones, pasos). Ninguno reescribe el libro del otro: el agente
reporta transiciones, el servidor entrega órdenes. Eso evita la pregunta "¿quién gana?"
cuando los dos se reinician distinto.

**El agente habla, el servidor escucha.** Todo el tráfico del enlace lo inicia el agente
por HTTPS saliente. Es lo que permite sacar VSCode Ports, no tocar NAT ni puertos en la
sucursal, y que agregar una sucursal en Fase 2 sea instalar un agente y emitir una
credencial.

**Long-poll y no MQTT.** Un componente menos que operar en el Linux. Con latencia de
segundos alcanza: el cuello de botella es la maniobra física, que tarda decenas de
segundos. Si alguna vez no alcanza, se cambia la implementación de `OrderSource` sin tocar
el orquestador.

**Degradación explícita, no silenciosa.** Sin enlace el robot sigue trabajando y el
operario sigue pudiendo pedir y devolver cajones desde la tablet. Lo único que se pierde es
el ingreso de pedidos nuevos de picking, y eso se ve en pantalla.

**Deadlines en todos los niveles.** Cada paso y cada orden llevan presupuesto de tiempo.
Al agotarse, la orden va a `ERROR` con causa explícita en vez de quedar colgada.

### Trade-offs considerados

- **Refactor incremental en vez de reescritura**: descartado para el shell (topología y
  modelo de datos distintos), adoptado para el núcleo empírico (protocolo, traducción,
  handshake) que se porta con sus tests.
- **SQLite y no Postgres en el agente**: el agente es de una sola sucursal y debe
  funcionar con internet caído. SQLite no agrega operación.
- **SQLite también en el servidor, por ahora**: una sucursal, un agente, escrituras
  serializadas. Postgres se justifica cuando haya varias sucursales concurrentes (Fase 2);
  los repositorios se escriben contra una interfaz para que el cambio no toque la lógica.
- **Sin Redis/SQS**: la cola durable la resuelve la tabla de órdenes del servidor con
  leases. Un broker agrega un servicio más que operar para un volumen que no lo necesita.
- **El agente conserva cola propia** en vez de leer del servidor en cada paso: es lo que le
  permite sobrevivir sin red, que es la razón por la que existe como proceso aparte.
- **El front se rehace en paralelo**, con su propia spec y su propio cutover
  (`docs/specs/2026-09-21-frontend-vite-react.md`). Se mantienen las rutas y el contrato
  `{ ok, data }` de la API local justamente para que los dos cutovers no caigan el mismo día.

## Cambios de API/DB

### API local del agente — diferencias contra el servidor actual

| Cambio | Detalle |
|---|---|
| Ingreso de picking | Sale de la API local. La app de picking apunta al servidor Linux (RF26). Acá quedan solo las órdenes manuales de la tablet. |
| Auth | Sin login de operario: la API bindea a la IP de LAN y ese es el control. Solo el comando directo a PLC pide token de mantenimiento (RF22). La auth de cliente y el HMAC se mueven al servidor. |
| `siteId` | Se valida en el servidor contra la credencial. El agente lo lleva en su modelo y lo toma de su configuración, no del request de la tablet. |
| `GET /api/slots` | Agrega `side` (`LEFT`/`RIGHT`) y `robotId` por slot, que el front nuevo ya consume. |
| `targetLocation` en PUT | Obligatorio **solo** si el slot está vacío en libros; ignorado si el slot tiene cajón. Antes: opcional y, si faltaba, devolvía el cajón al mismo slot. |
| `priority` | Se elimina del modelo. Lo reemplaza la regla PICK-antes-que-PUT de RF09. |
| `HTTP_PORT` / `HTTP_BIND` | Se respeta la variable de entorno (hoy `3000` está hardcodeado) y se agrega la interfaz de escucha, que por defecto **no** es `0.0.0.0`. |
| `/health` | Pasa a health profundo (RF25). |
| `/api/devices/robots` | Se corrige: hoy devuelve `{}` en `queue` con driver externo (Promise sin `await`). |
| `/api/orders/simulate` | Deja de exponer campos que nunca se calculan (`address`, `responseAddress`, `verifyAddress`, `expectedValue`). |
| `SIMULATE_PLC` | Default pasa a `false`. |

Se mantienen las rutas y el contrato de respuesta `{ ok, data }` / `{ ok, error }` para
no romper el front.

### API del servidor Linux — nueva

| Endpoint | Para quién | Detalle |
|---|---|---|
| `POST /api/v1/orders` | App de picking | HMAC del body + timestamp, `siteId` validado contra la credencial, dedupe por `(siteId, externalOrderId)`. Reenvío → `200` con la orden existente (RF26). |
| `GET /api/v1/orders/:externalOrderId` | App de picking | Estado de la orden (RF30). |
| `GET /api/v1/agent/work` | Agente | Long-poll: devuelve órdenes con lease, o vacío al vencer el timeout (RF28). |
| `POST /api/v1/agent/report` | Agente | Transiciones de estado, idempotentes y por secuencia (RF29). |
| `POST /api/v1/agent/heartbeat` | Agente | Presencia y estado resumido de la sucursal (RF31). |
| `GET /health` | Operación | Estado del servidor y presencia de cada sucursal. |

### DB — esquema nuevo (SQLite de los dos lados, con migraciones)

**Agente** — libro de la ejecución:

- `robots(id, site_id, estanteria_code, enabled, status, current_order_id)` — único por `(site_id, estanteria_code)`
- `devices(id, robot_id, type, host, port, unit_id, register_map_json, status, last_seen)`
- `slots(id, robot_id, location_code, side, status, reserved_by_order_id, current_box_json, pending_returns, updated_at)`
- `orders(id, site_id, robot_id, external_order_id, type, origin, status, location_code, target_location, slot_location_code, current_step_index, waiting_for_slot, error_reason, created_at, started_at, finished_at, lease_expires_at, synced)`
  — índice único `(site_id, external_order_id)`; índice `(robot_id, status, created_at)` para la cola FIFO
- `order_steps(id, order_id, seq, type, device_type, status, retries, started_at, finished_at)`
- `order_history(id, order_id, ts, event, metadata_json)`
- `outbox(id, order_id, seq, payload_json, created_at, attempts, last_error)` — transiciones pendientes de reportar (RF34)
- `events(id, ts, entity_type, entity_id, event, metadata_json)` — con purga por retención
- `order_metrics(...)` — se mantiene el esquema actual más `site_id`

**Servidor** — libro de la admisión:

- `sites(id, name, created_at)`
- `agent_credentials(id, site_id, key_id, secret_hash, revoked_at, last_seen)`
- `orders(id, site_id, robot_id, external_order_id, type, payload_json, status, created_at, delivered_at, finished_at)`
  — índice único `(site_id, external_order_id)`; índice `(site_id, status, created_at)` para la entrega
- `order_leases(order_id, agent_id, granted_at, expires_at)`
- `order_transitions(id, order_id, seq, status, reported_at, metadata_json)` — único `(order_id, seq)`, base de la idempotencia de RF29

Migración desde la base actual: script de importación de `slots` y órdenes abiertas al
agente (el histórico de métricas se conserva agregando `site_id` con valor por defecto).
El servidor arranca vacío: las órdenes abiertas al momento del cutover las termina el
agente desde su propia cola.

## UI / Tarea principal

El front del operario tiene spec propia (`docs/specs/2026-09-21-frontend-vite-react.md`) y
avanza en paralelo: esta spec no lo diseña, solo le garantiza el contrato. Lo que le debe:
mantener las rutas y el formato `{ ok, data }` / `{ ok, error }` de la API local, exponer
`side` y `robotId` en `GET /api/slots`, y publicar el estado del enlace con el servidor en
`/health` para que la pantalla pueda avisar "sin conexión con el servidor de pedidos" sin
que eso parezca que el robot está caído.

Tareas del operario, en orden de frecuencia: ver el estado de la zona de pickeo (qué cajón
hay en cada slot), devolver un cajón, destrabar una orden en error.

## Tasks

### Andamiaje y dominio

- [x] **T01** Andamiaje: monorepo (`packages/domain`, `packages/agent`, `packages/server`), TS estricto, ESLint, Prettier, CI con type-check + tests.
- [ ] **T02** Portar los 55 tests actuales como suite de aceptación (rojos al inicio; son el contrato).
- [ ] **T03** `domain`: tipos y uniones discriminadas (slot, orden, paso, respuesta PLC).
- [ ] **T04** `domain`: `locationCode` — parseo, lado por paridad, nivel, posición (RF01).
- [ ] **T05** `domain`: traducción a comandos de carro y elevador (RF02).
- [ ] **T06** `domain`: protocolo y decodificación de respuestas PLC, errores fatales (RF03).
- [ ] **T07** `domain`: selección de slot por lado y cercanía (RF05).
- [ ] **T08** `domain`: máquina de estados de slot + `pendingReturns` (RF06, RF07).
- [ ] **T09** `domain`: máquina de estados de orden y secuencia de pasos (RF04).
- [ ] **T10** `domain`: orden de servicio de cola — FIFO, PICK-antes-que-PUT, inversión por zona llena (RF09).
### Agente (notebook de la sucursal)

- [ ] **T11** `agent`: esquema SQLite, migraciones y repositorios por entidad (RF23).
- [ ] **T12** `agent`: cola persistente + espera por slot por evento, FIFO por `(robot, lado)` (RF08, RF10).
- [ ] **T13** `agent`: `ModbusClient` + `DeviceMutex` + clasificación de errores de conectividad (RF16, RF19).
- [ ] **T14** `agent`: handshake de paso con verificación de reset (RF12, RF17).
- [ ] **T15** `agent`: monitor de conectividad con backoff, recreación y cesión de socket (RF18).
- [ ] **T16** `agent`: orquestador — loop por robot, retry, deadlines por paso y orden (RF13).
- [ ] **T17** `agent`: resolución de destino de PUT y devolución manual fuera-de-libros (RF11).
- [ ] **T18** `agent`: dedupe idempotente por `(siteId, externalOrderId)` (RF14) y rehidratación (RF15).
- [ ] **T19** `agent`: API HTTP local con validación zod, bind a la interfaz de LAN y token de mantenimiento para el comando directo a PLC (RF21, RF22).
- [ ] **T20** `agent`: métricas y `/health` profundo, incluido el estado del enlace (RF24, RF25).
- [ ] **T21** `agent`: logs estructurados, retención y purga de eventos.
- [ ] **T28** `agent`: `OrderSource` por long-poll — reclamo con lease, backoff con jitter, reconexión (RF28, RF33, RF37).
- [ ] **T29** `agent`: outbox de transiciones y drenado ordenado e idempotente al reconectar (RF34).
- [ ] **T30** `agent`: órdenes manuales sin enlace con push diferido al servidor (RF35).
- [ ] **T31** `agent`: degradación explícita — estado del enlace visible, sin modo silencioso (RF36).

### Servidor de pedidos (Linux propio)

- [ ] **T32** `server`: andamiaje, esquema SQLite, migraciones y repositorios por entidad.
- [ ] **T33** `server`: ingreso de pedidos con HMAC + timestamp, validación de `siteId` y dedupe idempotente (RF26).
- [ ] **T34** `server`: cola durable, entrega por long-poll con lease y re-entrega por vencimiento (RF27, RF28).
- [ ] **T35** `server`: reporte de transiciones idempotente por secuencia (RF29) y consulta de estado para picking (RF30).
- [ ] **T36** `server`: credenciales por sucursal, heartbeat, presencia y `/health` (RF31, RF32).
- [ ] **T37** `server`: despliegue en el Linux — TLS, servicio, logs, retención y purga.

### Integración, pruebas y cutover

- [ ] **T22** Garantizar el contrato que consume el front nuevo: rutas, `{ ok, data }`, `side` y `robotId` en `GET /api/slots`, estado del enlace en `/health`. El rediseño va por su propia spec.
- [ ] **T23** Script de migración de datos desde la base actual.
- [ ] **T24** Tests unitarios (cobertura completa de `domain`).
- [ ] **T25** Tests funcionales: e2e con PLC simulado y servidor de prueba, incluidos los caminos de error y recuperación, pérdida de enlace, re-entrega por lease vencido y drenado de outbox.
- [ ] **T26** Plan de cutover en dos tiempos: (1) agente nuevo en paralelo contra el robot real, con cola local, validado una jornada completa; (2) recién ahí se enciende el enlace con el servidor. Nunca los dos el mismo día.
- [ ] **T38** Repuntar la app de picking al servidor Linux y dar de baja VSCode Ports.
- [ ] **T27** Descripción de PR.

## Fuera de alcance (Fase 2)

Varias sucursales y varios agentes contra el mismo servidor, Postgres en reemplazo de
SQLite del lado del servidor, dashboard multi-sucursal, alta de sucursales y rotación de
credenciales autogestionada, y métricas agregadas entre sucursales.

Lo que la Fase 1 deja listo para eso: `domain` compartido, `siteId` en todo el modelo,
enlace saliente por credencial de sucursal, y repositorios del servidor detrás de una
interfaz.

> **Nota de riesgo**: hay un robot en producción. Nada de big-bang — ver T26.
