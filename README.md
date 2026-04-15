# Aoki One Server - MVP Modbus TCP

Servidor Node.js para orquestar pedidos PICK/PUT sobre robots PLC (carro + elevador) usando Modbus TCP.

## Estado actual del MVP

- Sin MQTT ni Node-RED en el flujo principal.
- Cola por robot (1 orden activa por robot).
- Orquestador con secuencia fija de pasos:
  - HOMING -> ELEVADOR -> CARRO_BUSCA -> ELEVADOR -> CARRO_DEJA/CARRO_DEVUELVE -> HOMING
- Retry con backoff por paso.
- Monitor de conexion por heartbeat/polling y reconexion automatica.
- Persistencia liviana en archivos:
  - `data/events.ndjson`
  - `data/snapshot.json`
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
SIMULATE_PLC=true
ORCHESTRATOR_TICK_MS=300
HEARTBEAT_INTERVAL_MS=1000
HEARTBEAT_TIMEOUT_MS=3000
MAX_RETRIES_PER_STEP=3
BASE_BACKOFF_MS=500
COMMAND_ACK_TIMEOUT_MS=2000
MODBUS_RETRY_ATTEMPTS=3
MODBUS_RETRY_BACKOFF_MS=300
MODBUS_COMMAND_REGISTER=0
MODBUS_VERIFY_REGISTER=1
MODBUS_RESPONSE_REGISTER=2
```

Notas:
- `SIMULATE_PLC=true` permite probar el orquestador sin PLC real.
- Para planta real, usar `SIMULATE_PLC=false` y registrar dispositivos con IP/puerto/unitId correctos.

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
  "unitId": 1,
  "heartbeatRegister": 0,
  "timeoutMs": 2000
}
```

### Ordenes

- `POST /api/orders`
- `GET /api/orders`
- `GET /api/orders/:id`
- `POST /api/orders/:id/retry`
- `POST /api/orders/:id/cancel`

Alta de orden:

```json
{
  "type": "PICK",
  "locationCode": "30501",
  "targetLocation": "90001",
  "robotId": "3",
  "priority": 0
}
```

## Consideraciones de red

- Se asume latencia variable y microcortes en bridges WiFi.
- Nunca avanzar de paso solo por enviar comando.
- En cada paso: enviar -> esperar/timeout -> leer estado PLC -> validar esperado -> avanzar.
- Al iniciar, el servidor intenta rehidratar estado desde `data/snapshot.json`.

## Proximo trabajo sugerido

1. Cerrar mapa Modbus exacto (registros por paso, ACK, error y bloqueo).
2. Reemplazar `resolveStepCommand` por codificacion real por robot/dispositivo.
3. Rehidratacion completa desde `snapshot.json` al arrancar servidor.
