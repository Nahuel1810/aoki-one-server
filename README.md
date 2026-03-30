# Aoki One Server - PLC MQTT Module

Modulo Node.js para levantar un broker MQTT (puerto 1883 por defecto) y una API HTTP para publicar comandos a PLC en topicos estandarizados.

## Topicos soportados

Todos los dispositivos deben usar:

- `plc/{tipo}/{id}/cmd`
- `plc/{tipo}/{id}/state`

Ejemplos:

- `plc/elevador/1/cmd`
- `plc/carro/2/state`

## Payloads

Comando hacia PLC:

```json
{
  "cmd": 12345,
  "ts": 1710000000
}
```

State enviado por PLC:

```json
{
  "status": "idle",
  "version": "1.0.0",
  "ts": 1710000000,
  "error": null
}
```

## Instalacion

```bash
npm install
```

## Ejecucion

```bash
npm start
```

## Frontend simple

Con el servidor levantado, abrir:

- http://localhost:3000/

La pagina permite completar:

- Topico
- Comando (campo cmd)
- Timestamp (ts)

Al enviar, hace POST a:

- /api/plc/publish

Variables:

- `HTTP_PORT` (default `3000`)
- `MQTT_PORT` (default `1883`)
- `MQTT_HOST` (default `0.0.0.0`)

## Endpoints

### POST /api/plc/:tipo/:id/cmd

Publica un comando en `plc/{tipo}/{id}/cmd`.

Body:

```json
{
  "cmd": 12345,
  "ts": 1710000000
}
```

Ejemplo:

```bash
curl -X POST http://localhost:3000/api/plc/elevador/1/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":12345,"ts":1710000000}'
```

### POST /api/plc/publish

Publica payload arbitrario en un topico valido `plc/{tipo}/{id}/cmd|state`.

Body:

```json
{
  "topic": "plc/elevador/1/cmd",
  "payload": {
    "cmd": 12345,
    "ts": 1710000000
  },
  "qos": 0,
  "retain": false
}
```

### GET /api/plc/:tipo/:id/state

Devuelve el ultimo state recibido para `plc/{tipo}/{id}/state`.

## Acople en otro servidor

El modulo esta en `src/modules/plcMqttModule.js` y exporta `createPlcMqttModule(options)`.

Uso base:

```js
const express = require("express");
const { createPlcMqttModule } = require("./src/modules/plcMqttModule");

async function main() {
  const app = express();
  app.use(express.json());

  const plcMqtt = await createPlcMqttModule({ mqttPort: 1883 });
  plcMqtt.attachHttpRoutes(app);
  await plcMqtt.start();

  app.listen(3000);
}

main();
```
