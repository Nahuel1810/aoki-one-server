# Contrato de la app de picking con el servidor de pedidos

La app de picking **no vive en este repositorio**. Este documento es el contrato
que tiene que implementar para dejar de apuntarle a la notebook de la sucursal y
pasar a mandarle los pedidos al servidor de pedidos (el Linux propio). Esta
escrito para que quien la mantiene lo implemente sin preguntar nada.

Todo lo que dice se puede verificar contra el codigo:
`packages/server/src/api/hmac.ts` (firma) y
`packages/server/src/api/httpServer.ts` (rutas, headers, validacion y codigos).

---

## 1. Que cambia

| | Antes | Ahora |
| --- | --- | --- |
| A quien se le manda | la notebook de la sucursal, por un tunel de **VSCode Ports** | el **servidor de pedidos**, por HTTPS, con su dominio propio |
| Endpoint | `POST /api/orders/pick` | `POST /api/v1/orders` |
| Autenticacion | **ninguna** | **obligatoria**: HMAC-SHA256 del cuerpo + timestamp |
| Identificador del pedido | `id`, entero | `externalOrderId`, texto libre |
| Sucursal | implicita (habia una sola) | `siteId` explicito, validado contra la credencial |
| Consulta de estado | `GET /api/orders/:id` sin firma | `GET /api/v1/orders/:externalOrderId`, **firmado** |

El cuerpo del contrato que **no** cambia: el reenvio del mismo pedido sigue
respondiendo `200` con `created: false`, el alta nueva sigue respondiendo `202`
con `created: true`, y las respuestas siguen viniendo en el envoltorio
`{ ok, data }` / `{ ok, error }`.

---

## 2. Credencial

La emite quien administra el servidor, por sucursal, y entrega tres valores:

```
AOKI_AGENT_SITE_ID=SUC-CENTRO     -> el siteId que va en el cuerpo
AOKI_AGENT_KEY_ID=6f1c...         -> identificador de la credencial
AOKI_AGENT_SECRETO=9a2b...        -> el secreto con el que se firma
```

Tres cosas que importan:

- **El secreto se muestra una sola vez.** No hay forma de volver a leerlo: si se
  pierde, se rota y hay que actualizar a todos los que firman con el.
- **El secreto NUNCA viaja en una request.** Se usa para calcular la firma y no
  sale de la app. Si aparece en un header, en la URL o en un log, la firma deja
  de probar nada: quien la intercepte puede emitir cualquier pedido.
- **El `keyId` no es un secreto**, es un identificador. Por eso tambien las
  consultas van firmadas: con el `keyId` solo no se puede hacer nada.

---

## 3. El sobre de cada request

Tres headers, en **toda** llamada, incluidas las de consulta:

| Header | Valor |
| --- | --- |
| `x-aoki-key-id` | el `keyId` de la credencial, tal cual |
| `x-aoki-timestamp` | el instante del envio en **epoch milisegundos**, como texto (`"1758658800000"`) |
| `x-aoki-signature` | HMAC-SHA256 en **hexadecimal minuscula** (ver abajo) |

Mas `content-type: application/json` en los POST.

### 3.1 Que se firma

```
firma = HMAC_SHA256( secreto, `${timestamp}.${contenido}` )   -> hex
```

El punto entre el timestamp y el contenido es parte de la cadena.

- En un **POST**, `contenido` son **los bytes exactos del cuerpo** que se van a
  enviar.
- En un **GET**, no hay cuerpo, asi que `contenido` es la **ruta completa tal
  como se pide**, incluida la query si la hubiera: `/api/v1/orders/47`. Esto
  ata la firma al recurso: sin eso, una firma valida para consultar un pedido
  serviria para leer cualquier otro de la sucursal.

**El error numero uno de esta integracion**: serializar el JSON dos veces, una
para firmar y otra para enviar. Dos JSON equivalentes tienen bytes distintos
—espacios, orden de claves, escapes— y el servidor verifica sobre el cuerpo
**crudo**, no sobre el reparseado. Se serializa **una sola vez** y esa misma
cadena se firma y se manda.

### 3.2 Ventana anti-replay

El servidor rechaza toda request cuyo `x-aoki-timestamp` este a mas de **5
minutos** del reloj del servidor, **en cualquiera de las dos direcciones**: una
request "del futuro" tambien se rechaza, porque significa que algun reloj esta
mal y la ventana deja de proteger.

Consecuencia practica: **la maquina que firma tiene que estar en hora**. Un
reloj corrido se ve como `401` en el 100% de las requests, y no se parece en
nada a un problema de reloj. Si la app corre en un servidor propio, NTP
activado.

### 3.3 Ejemplo completo (Node)

```js
import { createHmac } from 'node:crypto'

const BASE = 'https://pedidos.midominio.com'
const KEY_ID = process.env.AOKI_KEY_ID
const SECRETO = process.env.AOKI_SECRETO
const SITE_ID = 'SUC-CENTRO'

function cabeceras(contenido) {
  const timestamp = String(Date.now())
  return {
    'content-type': 'application/json',
    'x-aoki-key-id': KEY_ID,
    'x-aoki-timestamp': timestamp,
    'x-aoki-signature': createHmac('sha256', SECRETO)
      .update(`${timestamp}.${contenido}`)
      .digest('hex'),
  }
}

export async function pedirCajon(externalOrderId, locationCode) {
  // UNA sola serializacion: lo que se firma es lo que se manda.
  const cuerpo = JSON.stringify({
    siteId: SITE_ID,
    externalOrderId,
    tipo: 'PICK',
    locationCode,
  })

  const respuesta = await fetch(`${BASE}/api/v1/orders`, {
    method: 'POST',
    headers: cabeceras(cuerpo),
    body: cuerpo,
  })
  return { estado: respuesta.status, cuerpo: await respuesta.json() }
}

export async function consultarPedido(externalOrderId) {
  const ruta = `/api/v1/orders/${encodeURIComponent(externalOrderId)}`
  // En un GET se firma la RUTA, no un cuerpo vacio.
  const respuesta = await fetch(`${BASE}${ruta}`, { headers: cabeceras(ruta) })
  return { estado: respuesta.status, cuerpo: await respuesta.json() }
}
```

---

## 4. `POST /api/v1/orders` — dar de alta un pedido

### 4.1 Cuerpo

```json
{
  "siteId": "SUC-CENTRO",
  "externalOrderId": "47",
  "tipo": "PICK",
  "locationCode": "3X04AA3"
}
```

| Campo | Tipo | Reglas |
| --- | --- | --- |
| `siteId` | texto | requerido, no vacio. **Tiene que ser el de la credencial**: si no, `403` |
| `externalOrderId` | texto | requerido, no vacio. Es **la clave de dedupe** junto con `siteId` |
| `tipo` | `"PICK"` o `"PUT"` | requerido. Picking manda `PICK` |
| `locationCode` | texto | requerido, no vacio. La ubicacion del cajon, **sin sufijo de accion** (`T`/`D`/`L`) |

Los campos de mas se ignoran. Los textos se recortan (`trim`) antes de validar.

**`externalOrderId` es texto, ya no un entero.** Si la app venia mandando un
numero, se manda como cadena (`"47"`, no `47`): el servidor no interpreta su
contenido, solo lo usa como clave, pero `47` y `"47"` no son la misma clave.

**Sobre `PUT`**: existe en el contrato, pero la devolucion estandar de un cajon
la hace el operario desde la tablet de la sucursal, no picking. La accion fisica
(buscar o devolver) se deriva del `tipo`, nunca del sufijo del `locationCode`.

### 4.2 Respuestas

| Codigo | Cuando | Cuerpo |
| --- | --- | --- |
| `202` | alta nueva | `{ "ok": true, "data": { ... }, "created": true }` |
| `200` | **reenvio** del mismo `(siteId, externalOrderId)` | `{ "ok": true, "data": { ...el pedido que ya existia... }, "created": false }` |
| `400` | cuerpo invalido o JSON mal formado | `{ "ok": false, "error": "externalOrderId: externalOrderId es requerido" }` |
| `401` | falta el `keyId`, credencial invalida o revocada, o firma rechazada | `{ "ok": false, "error": "firma rechazada: FIRMA_INVALIDA" }` |
| `403` | el `siteId` del cuerpo no es el de la credencial | `{ "ok": false, "error": "el siteId del pedido no corresponde a la credencial" }` |
| `500` | problema del servidor | `{ "ok": false, "error": "error interno del servidor" }` |

`data` es el pedido tal como lo guardo el servidor:

```json
{
  "id": "3f0c...",
  "siteId": "SUC-CENTRO",
  "externalOrderId": "47",
  "tipo": "PICK",
  "locationCode": "3X04AA3",
  "estado": "PENDING",
  "creadaEn": 1758658800000
}
```

`id` es el identificador del libro del servidor y **no** es el
`externalOrderId`. Sirve para cruzar logs; para consultar se usa el
`externalOrderId`.

### 4.3 Dedupe: un reenvio no crea un pedido nuevo

La clave es `(siteId, externalOrderId)` y la garantiza un **indice unico** en la
base, no una consulta previa: dos altas simultaneas de la misma clave no pueden
devolver las dos `created: true`. Quien pierde la carrera relee y recibe el
pedido que ya existia.

Lo que esto le habilita a la app de picking, y es el punto de todo el mecanismo:

- **Reintentar es seguro.** Ante un timeout, un `5xx` o una red cortada, se
  reintenta la misma request tal cual. Si la primera habia llegado, la segunda
  responde `200 created:false` **con el pedido original**; el robot no hace la
  maniobra dos veces.
- **`created` es informacion, no un error.** Un `200` con `created: false` es la
  confirmacion de que el pedido ya esta tomado. Tratarlo como fallo y reenviar
  con otro `externalOrderId` **si** genera una segunda maniobra.

Regla de reintento sugerida: reintentar `5xx`, timeouts y errores de red con
backoff exponencial; **no** reintentar `400`, `401` ni `403`, que no se arreglan
solos.

### 4.4 Lo que el servidor NO valida

El servidor **no** interpreta el `locationCode`: solo exige que no este vacio. La
gramatica la valida el agente de la sucursal cuando recibe el pedido. Un codigo
mal formado, o de una estanteria que esa sucursal no tiene, se admite con `202`
y **despues** termina en `ERROR`.

Consecuencia para la app: **el `202` no significa que el pedido se vaya a poder
ejecutar**, significa que fue admitido. El estado final se ve por consulta (5).
El motivo del rechazo queda en el log del servidor y en el historico de
transiciones, no en la respuesta de la consulta; si la app necesita mostrarlo,
hoy hay que buscarlo con quien opera el servidor.

---

## 5. `GET /api/v1/orders/:externalOrderId` — estado de un pedido

Va **firmado** (seccion 3.1: se firma la ruta). La sucursal sale de la
credencial, no de la URL: cada credencial ve solamente sus propios pedidos.

| Codigo | Cuando |
| --- | --- |
| `200` | `{ "ok": true, "data": { ...el pedido... } }` |
| `401` | sin firma, firma invalida o fuera de la ventana |
| `404` | no hay ningun pedido con ese `externalOrderId` **en esta sucursal** |

Estados posibles en `data.estado`:

| Estado | Significa |
| --- | --- |
| `PENDING` | admitido, todavia no lo tomo la sucursal |
| `IN_PROGRESS` | el robot lo esta ejecutando |
| `DONE` | el cajon esta en el slot de pickeo (o la devolucion termino) |
| `ERROR` | no se pudo completar. Necesita intervencion en la sucursal |
| `CANCELED` | lo cancelo el operario desde la tablet |

**Conviene consultar por evento, no en bucle cerrado.** El cuello de botella es
la maniobra fisica, que tarda decenas de segundos: un sondeo cada 5 s alcanza de
sobra y no agrega nada por debajo de eso.

**Si la sucursal esta sin enlace**, el pedido queda `PENDING` hasta que la
notebook vuelva a conectarse. No es un error del alta y no se arregla
reenviando: el pedido ya esta admitido y se va a entregar cuando el enlace
vuelva.

---

## 6. Codigos de rechazo de firma

El `401` trae el motivo en el texto del error, y es lo que distingue un problema
de reloj de uno de credencial:

| Codigo | Que pasa |
| --- | --- |
| `FALTA_FIRMA` | no se mando `x-aoki-signature` |
| `FALTA_TIMESTAMP` | no se mando `x-aoki-timestamp` |
| `TIMESTAMP_INVALIDO` | el timestamp no es un numero (¿se mando en segundos o en ISO?) |
| `TIMESTAMP_FUERA_DE_VENTANA` | mas de 5 minutos de desvio: **reloj corrido** o replay |
| `FIRMA_INVALIDA` | el HMAC no cierra: secreto viejo, o se firmo algo distinto de lo que se mando |

Ademas, sin `x-aoki-key-id` el error es `falta el identificador de credencial`, y
con un `keyId` desconocido o revocado, `credencial invalida o revocada`.

Del lado del servidor cada rechazo deja una linea `AUTH_REJECTED` con el motivo
y el `keyId` —nunca la firma ni el secreto—. Es lo primero que se mira cuando la
integracion deja de funcionar.

---

## 7. Baja de VSCode Ports

Hoy la notebook de la sucursal esta publicada en internet con un tunel de VSCode
Ports, y la app de picking le pega ahi. Se retira, y estas son las razones,
escritas para que nadie lo vuelva a levantar "por un ratito":

1. **El agente deja de ser el punto de entrada de los pedidos.** Los pedidos
   entran por el servidor Linux. El tunel no tiene ya nada que atender.
2. **Todo el trafico del enlace lo INICIA el agente.** Habla con el servidor por
   HTTPS saliente —reclama trabajo, reporta estado, late— y el servidor **nunca**
   abre una conexion hacia la sucursal. Nada de afuera necesita alcanzar a la
   notebook: ni el servidor, ni picking, ni una consola de soporte.
3. **La autorizacion del operario se apoya en estar en la LAN.** La API de la
   tablet no tiene login: estar en la red de la sucursal equivale a estar parado
   frente a la tablet. Un tunel a internet rompe exactamente ese razonamiento,
   porque convierte a cualquiera en alguien "parado frente a la tablet".
4. **El tunel no autenticaba nada.** La API que publicaba —alta de ordenes,
   comando directo al PLC, liberacion de slots— no pedia credencial. Quien
   conociera la URL podia mover el robot.
5. **Un tunel es una dependencia operativa invisible.** Sobrevive mientras
   alguien mantenga abierta una sesion de VSCode en esa maquina. Cuando se cae,
   se cae el ingreso de pedidos, y no hay ningun tablero que lo diga.

Despues del cambio el unico componente expuesto a internet es el servidor
Linux: con TLS terminado en un reverse proxy, sin endpoints anonimos, con HMAC
en el ingreso y credencial por sucursal para el agente.

**Como se da de baja** (el procedimiento completo, con su orden respecto del
resto del cutover, esta en `docs/cutover-fase-1.md`, seccion 5): primero se
confirma que picking ya no tiene ninguna URL del tunel configurada, despues se
cierra el port forwarding, y recien despues se verifica **desde fuera de la
LAN** que la notebook ya no contesta y **desde la LAN** que la tablet si.

---

## 8. Checklist de la app de picking

- [ ] Credencial recibida y guardada fuera del codigo (variables de entorno o
      gestor de secretos). El secreto **no** entra al repositorio.
- [ ] Base de URL apuntando al servidor de pedidos por **HTTPS**. Ninguna URL
      del tunel viva en la configuracion.
- [ ] Una sola serializacion del cuerpo: se firma y se manda la misma cadena.
- [ ] Los tres headers en todas las requests, incluidas las consultas.
- [ ] GET firmado sobre la ruta, no sobre un cuerpo vacio.
- [ ] Reloj sincronizado (NTP) en la maquina que firma.
- [ ] `externalOrderId` enviado como **texto**, estable y unico por pedido. El
      mismo pedido se reintenta con el **mismo** id.
- [ ] `200 created:false` tratado como exito, no como error.
- [ ] Reintentos con backoff para `5xx`, timeouts y errores de red; sin
      reintentos para `400`, `401` y `403`.
- [ ] El `202` no se muestra como "el robot ya lo esta haciendo": el estado se
      consulta.
- [ ] Probado contra una credencial de prueba **antes** del dia del cutover.

---

## 9. Referencias

- `docs/cutover-fase-1.md` — cuando se hace este cambio y como se vuelve atras.
- `deploy/README.md` — despliegue del servidor y emision de credenciales.
- `packages/server/src/api/hmac.ts` — la verificacion de firma, tal cual.
- `packages/server/src/api/httpServer.ts` — rutas, headers, validacion y codigos.
