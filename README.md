# Aoki One Server - MVP Modbus TCP

Servidor Node.js para orquestar pedidos PICK/PUT sobre robots PLC (carro + elevador) usando Modbus TCP.

## Estado actual del MVP

- Sin MQTT ni Node-RED en el flujo principal.
- Cola por robot (1 orden activa por robot).
- Orquestador con secuencia fija de pasos:
  - HOMING -> ELEVADOR -> CARRO_BUSCA -> ELEVADOR -> CARRO_DEJA/CARRO_DEVUELVE -> HOMING
- Retry con backoff por paso.
- Persistencia por defecto en SQLite (`data/persistence.db`) con fallback a archivos si SQLite no esta disponible.
- Frontend basico en `/` para registrar dispositivos y crear pedidos.

## Requisitos

- Node.js 18+
- PLCs accesibles por red en Modbus TCP (puerto 502 por defecto)

## Instalacion

```bash
npm install
```

## Configuracion

Crear `.env` desde `.env.example`:

```bash
HTTP_PORT=3000
PERSISTENCE_DRIVER=sqlite
SQLITE_DB_PATH=data/persistence.db
SIMULATE_PLC=true
ORCHESTRATOR_TICK_MS=300
MAX_RETRIES_PER_STEP=3
BASE_BACKOFF_MS=500
COMMAND_ACK_TIMEOUT_MS=2000
MODBUS_COMMAND_REGISTER=0
MODBUS_VERIFY_REGISTER=1
```

Notas:
- `SIMULATE_PLC=true` permite probar el orquestador sin PLC real.
- Para planta real, usar `SIMULATE_PLC=false` y registrar dispositivos con IP/puerto/unitId correctos.
- Persistencia:
  - `PERSISTENCE_DRIVER=sqlite` usa base SQLite para eventos y snapshot.
  - `PERSISTENCE_DRIVER=file` mantiene el modo legacy (`data/events.ndjson` y `data/snapshot.json`).

## Ejecucion

```bash
npm start
```

## API

### Salud

- `GET /health`

### Dispositivos PLC

- `POST /api/devices/register`
- `GET /api/devices`
- `GET /api/devices/robots`

Registro de dispositivo:

```json
{
  "robotId": "3",
  "type": "CARRO",
  "host": "192.168.1.50",
  "port": 502,
  "unitId": 255,
  "registerMap": {
    "messageIn": 0,
    "messageOut": 1
  },
  "timeoutMs": 2000
}
```

Registro de elevador con mapeo Modbus dedicado:

```json
{
  "robotId": "3",
  "type": "ELEVADOR",
  "host": "192.168.0.50",
  "port": 502,
  "unitId": 255,
  "registerMap": {
    "messageIn": 0,
    "messageOut": 1
  },
  "timeoutMs": 2000
}
```

Regla de mapeo de registros:
- El backend toma primero el override del comando (si existe).
- Si no hay override, usa `registerMap` del dispositivo.
- Si falta en `registerMap`, usa el mapa por defecto por tipo (`CARRO`/`ELEVADOR`).

### Ordenes

- `POST /api/orders/simulate`
- `POST /api/orders`
- `GET /api/orders`
- `GET /api/orders/:id`
- `POST /api/orders/:id/retry`
- `POST /api/orders/:id/cancel`

Alta de orden:

```json
{
  "type": "PICK",
  "locationCode": "3X04A3",
  "targetLocation": "90001",
  "robotId": "3",
  "priority": 0
}
```

Regla de contrato MVP:

- `type` define la accion (`PICK` o `PUT`).
- `locationCode` debe venir sin letra final de accion.
- Si llega con sufijo `T`, `D` o `L`, la API responde 400.

## Consideraciones de red

- Se asume latencia variable y microcortes en bridges WiFi.
- Nunca avanzar de paso solo por enviar comando.
- En cada paso: enviar -> esperar/timeout -> leer estado PLC -> validar esperado -> avanzar.

## Proximo trabajo sugerido

1. Cerrar mapa Modbus exacto (registros por paso, ACK, error y bloqueo).
2. Reemplazar `resolveStepCommand` por codificacion real por robot/dispositivo.
3. Rehidratacion completa desde `snapshot.json` al arrancar servidor.
