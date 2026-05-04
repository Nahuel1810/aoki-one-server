# Logica de negocio y decisiones

Este documento explica decisiones operativas clave del backend para evitar dudas al integrarlo con PLCs reales.

## 1) Como funciona la conectividad

### 1.1 Modo simulacion vs modo Modbus
- `SIMULATE_PLC=true`: no se abre socket Modbus real; la API responde en modo simulado.
- `SIMULATE_PLC=false`: se usa Modbus TCP real por dispositivo registrado.

### 1.2 Monitoreo de conexion
- `ConnectionService` ejecuta chequeos periodicos de conectividad (`startMonitoring`).
- Si hay fallos consecutivos, aplica backoff exponencial antes de reintentar.
- Cada N fallos (`CONNECTION_RECREATE_CLIENT_AFTER_FAILURES`) recrea el cliente Modbus.
- Si se alcanza un umbral severo de recreaciones, puede ejecutar hard reset de transporte Modbus.

### 1.3 Prioridad del orquestador sobre el monitor
- Cuando un robot esta procesando una orden, el monitor evita competir por el mismo socket.
- Se usa mutex por dispositivo para serializar operaciones Modbus y evitar intercalado de frames.

## 2) De que se componen los robots

Un robot logico se compone de:
- Un dispositivo `CARRO`.
- Un dispositivo `ELEVADOR`.
- Una cola propia de ordenes (`QueueManager`) con 1 activa por robot.

Estado agregado visible en API:
- Robot (`IDLE`, `BUSY`, `ERROR`, etc.).
- Dispositivos asociados y su estado (`CONNECTED`, `DISCONNECTED`).
- Cola del robot (`activeOrderId`, `queuedOrderIds`, `paused`).

## 3) Flujo de ordenes (PICK/PUT)

Secuencia base de pasos (fisica):
1. `HOMING` (CARRO)
2. `ELEVADOR` (ir nivel origen)
3. `CARRO_BUSCA` (traer desde origen)
4. `ELEVADOR` (ir nivel destino)
5. `CARRO_DEJA` (PICK) o `CARRO_DEVUELVE` (PUT)

Regla de avance:
- No se avanza solo por enviar comando.
- Se avanza cuando el estado/respuesta PLC valida la maniobra esperada.

## 4) Slots de pickeo

Estados de slot:
- `LIBRE`
- `RESERVADO`
- `BUSCANDO`
- `OCUPADO`
- `DEVOLVIENDO`
- `ERROR`

### 4.1 PICK
- Si no tiene slot asignado, se reserva uno libre segun distancia.
- Si no hay slot libre, la orden vuelve a `PENDING` con `waitingForSlot=true`.

### 4.2 PUT
- Debe apuntar a un slot configurado y `OCUPADO`.
- Si el slot no tiene cajon disponible, se rechaza.

## 5) Por que una orden puede saltar a DONE

Hay dos caminos de finalizacion:

### 5.1 Finalizacion fisica
- La orden ejecuta todos los pasos y no queda `currentStep`.
- Entonces se actualiza slot (ocupar/liberar), orden `DONE`, robot `IDLE`.

### 5.2 Finalizacion logica (sin mover PLC)
Casos de optimizacion que pueden "saltar" a `DONE`:
- `logicalPickOnly`: se detecta que el cajon ya estaba en un slot de pickeo para el mismo origen; se incrementa contador logico y no se repite maniobra fisica.
- `logicalReturnOnly`: en PUT, si hay multiples PICKs logicos sobre el mismo cajon (`logicalPickStackDepth > 1`), se decrementa contador logico y no se hace devolucion fisica todavia.

Esto evita movimientos redundantes cuando varias ordenes referencian el mismo cajon ya presente en zona de pickeo.

## 6) Errores, retries y recuperacion

- Cada paso se ejecuta con retry y backoff.
- Si falla y no es recuperable, la orden pasa a `ERROR` y puede bloquear el slot.
- `POST /api/orders/:id/retry` reinicia pasos y reencola la orden.
- Al reiniciar el servidor, se rehidrata snapshot:
  - Ordenes `IN_PROGRESS` pasan a `PENDING`.
  - Se reconstruyen colas por robot.

## 7) Contratos importantes de API

- `locationCode` de alta de orden/simulacion no debe incluir sufijo final `T/D/L`.
- `type` define la accion (`PICK` o `PUT`).
- `id` externo numerico permite deduplicacion idempotente.

## 8) Convencion de respuestas

- Exito: `{ ok: true, data: ... }`
- Error de validacion/regla: `{ ok: false, error: "..." }`
