# feat(server): servidor de pedidos — cola durable, HMAC y despliegue (T32–T37)

**Rama**: `rewrite/06-servidor-de-pedidos` → `rewrite/05-agente-orquestacion`

## Qué hace

Levanta el segundo proceso de la topología: el **servidor de pedidos**, que corre en un Linux propio y es el **único componente expuesto a internet**. Recibe los pedidos de la app de picking, los guarda en una cola durable y se los entrega al agente de cada sucursal.

Hasta este PR el sistema tenía un solo plano: el agente en la notebook de la sucursal, que era también el punto de entrada de los pedidos y estaba publicado a internet con un túnel de VSCode Ports. Ese es el problema que este PR resuelve, y no es de código: es de topología. La notebook no puede ser el punto de entrada de internet, y el estado de los pedidos no puede vivir solo en una máquina que se apaga.

## Por qué existe como proceso aparte

Dos libros, no uno:

- El **servidor** es fuente de verdad de **qué pedidos existen**: admisión, idempotencia, histórico.
- El **agente** es fuente de verdad de **qué está pasando físicamente**: slots, cajones, pasos.

Ninguno reescribe el libro del otro. El agente reporta transiciones, el servidor entrega órdenes. Eso evita la pregunta "¿quién gana?" cuando los dos se reinician distinto, que es la que no tiene respuesta cuando hay un solo libro repartido en dos máquinas.

## Ingreso de pedidos (RF26)

`POST /api/v1/orders`, autenticado con HMAC-SHA256. Cuatro decisiones que parecen detalle y no lo son:

- **La firma es sobre el body CRUDO**, no sobre el JSON reparseado. Dos JSON equivalentes tienen bytes distintos y firmarían distinto: verificar sobre el reparseado es firmar otra cosa.
- **La comparación es en tiempo constante.** Un `===` sobre el digest filtra, byte a byte, cuánto acertó el atacante.
- **La ventana anti-replay es simétrica.** Una request del futuro también se rechaza: si el timestamp viene adelantado, algún reloj está mal y la ventana dejó de proteger.
- **El `siteId` del body se valida contra la credencial.** Autenticar no es autorizar: una sucursal no puede crear órdenes de otra.

El **dedupe por `(siteId, externalOrderId)` lo rechaza un índice único**, no un `SELECT` previo. El legacy consultaba y después insertaba, con dos lecturas del mismo índice —una para calcular `created` y otra en el alta—, y entre las dos quedaba la ventana en la que dos altas simultáneas devolvían las dos `created: true`. Acá el alta se intenta, la base rechaza la clave duplicada y el caso de uso lo traduce a "ya existía". El reenvío devuelve **200 con el pedido que ya estaba**; el alta nueva, **202**.

`externalOrderId` deja de estar restringido a entero: el servidor no interpreta su contenido, solo lo usa como clave.

## Cola durable y entrega (RF27, RF28)

- **El reclamo corre en UNA transacción**: entre elegir las órdenes y tomarlas no puede colarse otro agente.
- **El lease es lo que permite re-entregar sin duplicar.** Si el agente se muere con la orden en la mano, el lease vence y la orden vuelve a estar disponible **con el mismo `externalOrderId`**, así que el dedupe del agente la absorbe sin que el robot repita la maniobra.
- **El long-poll contesta vacío con 200 al vencer el timeout, no con un error.** Un 4xx mandaría al agente al backoff sin motivo. Los 25 s por defecto quedan por debajo del timeout típico de un proxy.
- **No arrienda órdenes a un socket muerto.** El bucle del long-poll mira si la conexión sigue viva **antes** de cada reclamo: reclamar para un cliente que ya no está saca el lote de la cola con lease vigente, escribe la respuesta en un socket cerrado y deja ese trabajo sin hacer hasta que el lease vence. La señal es el `close` de la **respuesta** sin haberla terminado de escribir; el `close` del request no sirve, porque Node lo emite apenas termina de leer el body —o sea en toda request— y el bucle cortaría siempre en la primera vuelta.

## Reporte de transiciones (RF29) y consulta (RF30)

- **La clave `(order_id, seq)` es la idempotencia.** Con outbox y reintentos del otro lado, un reporte repetido o fuera de orden es el caso normal, no el excepcional.
- **Un reporte viejo se descarta.** Si se aplicara, la app de picking vería la orden **retroceder** de estado.
- **Una transición descartada responde 200, no 4xx**, y lo mismo una orden que el servidor no tiene. El outbox del agente reintenta hasta tener confirmación: un error lo dejaría reintentando para siempre algo que ya se aplicó. El caso terminal se dice por el cuerpo (`ORDEN_INEXISTENTE`) y el 404 queda reservado para "esta ruta no existe" — que es lo único que el agente no puede distinguir de un proxy mal configurado.
- **La consulta de estado también va firmada**, y como en un GET no hay body, se firma la **ruta completa**. Sin eso la firma no queda atada al recurso: una consulta legítima serviría para leer cualquier otro pedido de la sucursal.

## Credenciales y presencia (RF31, RF32)

- Credencial por sucursal, con `keyId` público y secreto. **El secreto nunca viaja**: se guarda cifrado con AES-256-GCM bajo una clave del entorno y el servidor lo resuelve por `keyId` desde su propio almacén. (Por qué está cifrado y no hasheado se cuenta en el PR del enlace, que es donde se descubrió el problema.)
- **El servidor no arranca sin esa clave.** Uno que acepta tráfico que no puede autenticar es peor que uno que no está.
- **Heartbeat y presencia**: `/health` dice si cada sucursal está caída, **siempre**, no solo cuando falla.
- **Todo el tráfico lo inicia el agente.** El servidor nunca abre una conexión hacia la sucursal. Es lo que permite retirar VSCode Ports y que agregar una sucursal (Fase 2) sea instalar un agente y emitir una credencial.

## Despliegue (T37)

`deploy/` y `deploy/README.md` alcanzan para levantarlo de cero. Lo que se decidió ahí:

- **TLS va en un reverse proxy, no en el proceso.** El servidor corre sin privilegios y no puede abrir el 443 ni leer una clave privada; darle cualquiera de las dos cosas empeora la postura del único componente expuesto. Renovación, reload sin cortar conexiones, HSTS y rate limiting ya están resueltos en nginx. El `.conf` de ejemplo deja `proxy_read_timeout` por encima de los 25 s del long-poll y `proxy_buffering off`, que es lo que el long-poll necesita para que la respuesta salga en el momento.
- **El proceso escucha en `127.0.0.1` por defecto y no termina TLS.** Un firewall que abra el 8080 al mundo publica HTTP plano: los pedidos y las firmas viajarían en claro.
- **La configuración se valida entera antes de abrir la base o el puerto**, y se listan de una sola vez todos los errores. Con la configuración mal el proceso sale con código 1 y `RestartPreventExitStatus=1` deja la unidad en `failed` en vez de reintentar para siempre llenando el journal.
- **Una línea JSON por evento a stdout y nada más.** journald se encarga del resto: sin archivo propio no hay dos rotaciones peleando por el mismo log. Cada línea lleva `componente: "servidor"` y, las de pedido, `correlacion.ordenId` y `correlacion.externalOrderId` — que es **el mismo campo que escribe el agente**, y por eso un pedido se sigue de punta a punta con un solo filtro.
- **Retención y purga**: los pedidos **terminados** se conservan `AOKI_SERVER_RETENCION_DIAS` y después se borran con sus transiciones y su lease. **Lo que sigue abierto no se purga nunca**, por viejo que sea: borrarlo sería perder trabajo pendiente. Las métricas del negocio no viven acá, así que la purga no borra números de nadie.
- **Emitir una credencial es un comando, no un endpoint.** Un endpoint que emite credenciales entrega el material con el que se firma, y no existe ninguna credencial previa con la que autenticarlo. Quien tiene shell en ese Linux ya tiene la base y la clave.
- **Un throw del repositorio ya no baja el proceso.** Express 4 no mira la promesa que devuelve un handler, así que un rechazo era un unhandled rejection y Node bajaba el proceso entero: un `SQLITE_BUSY` o un disco lleno en **una** request dejaba sin servidor a **todas** las sucursales.

## Testing

27 tests nuevos en este PR (cola, HMAC y e2e por HTTP real), sobre la infraestructura de despliegue que se agrega después. El e2e recorre alta firmada, reclamo por long-poll, reporte, consulta y heartbeat, y verifica que una sucursal no pueda crear órdenes de otra ni reclamar sin credencial.

Gates en verde en el tope del stack:

| gate | resultado |
|---|---|
| `build` · `typecheck` · `lint` · `format:check` | exit 0 |
| `test:packages` | 363 tests |
| `npm test` (legacy, `node --test`) | 60 tests |

## Fuera de alcance

El agente todavía no habla con este servidor: el enlace por long-poll, el outbox y la degradación son el PR siguiente. Hasta que se mergee, el servidor acepta pedidos y nadie los reclama.
