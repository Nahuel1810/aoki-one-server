# feat(agent): enlace con el servidor — long-poll, outbox y degradación (T28–T31)

**Rama**: `rewrite/07-sync-agente` → `rewrite/06-servidor-de-pedidos`

## Qué hace

Une las dos mitades. El agente de la sucursal reclama trabajo del servidor de pedidos por **long-poll saliente**, reporta cada cambio de estado y **sigue operando con el enlace caído**. Con este PR la topología de Fase 1 está completa: la app de picking le habla al servidor, el servidor le entrega a la sucursal, y la sucursal no expone ningún puerto.

Todo el tráfico lo **inicia el agente**. El servidor nunca abre una conexión hacia la sucursal: por eso acá hay un cliente y del otro lado no hay ninguno.

## Lo más importante de este PR: la firma HMAC no autenticaba nada

Se encontró revisando el lado del cliente, y era un defecto real del PR anterior, no una mejora.

**Qué pasaba.** El servidor verificaba la firma HMAC del ingreso de pedidos (RF26) tomando el secreto **del propio request**: el cliente mandaba `x-aoki-agent-secret` y el servidor lo usaba para recomputar la firma. Con eso la firma no probaba **nada** que el header no probara ya. Peor: el secreto de la sucursal viajaba en claro en cada llamada, así que interceptar **una sola** request alcanzaba para hacerse pasar por esa sucursal para siempre. Toda la protección que la spec pide en el único componente expuesto a internet era decorativa.

**Por qué estaba así, que es lo que vale entender.** La causa raíz no era del handler sino de la persistencia: el secreto se guardaba **hasheado**. Un hash sirve para comparar una password —el cliente la manda y se compara— pero **no sirve para recomputar una firma**, porque para eso hace falta el material original. Con el secreto hasheado, el servidor no tenía otra forma de verificar la firma que pedirle el secreto al cliente. La decisión "guardar hasheado" parecía la conservadora y era la que rompía el esquema entero.

**Cómo quedó.** El secreto se guarda **cifrado con AES-256-GCM** bajo una clave maestra del entorno, y el servidor lo resuelve por `keyId` desde su propio almacén. El secreto **nunca viaja**: el cliente dice **quién** es (`keyId`, que es un identificador) y lo **prueba** con la firma. Consecuencias que se asumen a propósito:

- **El servidor no arranca sin la clave maestra.** Uno que acepta tráfico que no puede autenticar es peor que uno que no está.
- **Si la clave se pierde, hay que reemitir la credencial de cada sucursal.** Está documentado como lo primero del README de despliegue, y es el precio de poder verificar sin que el secreto circule.
- **La consulta de estado también va firmada.** Un `keyId` no es un secreto: sin firma, cualquiera que lo conociera leía el estado de todos los pedidos de la sucursal. Como en un GET no hay body, se firma la **ruta completa**, y así la firma queda atada al recurso.
- **Una base anterior al cambio (con `secreto_hash`) no arranca y lo dice.** Un hash no se puede convertir en el material del secreto: no hay migración posible, hay reemisión.

## Espejo local (RF33)

Toda orden reclamada se persiste en SQLite **antes** de empezar a ejecutarse. La ejecución nunca depende de que el enlace esté vivo, y esa es la razón por la que el agente existe como proceso aparte: si el robot dependiera del enlace, no haría falta partir el sistema en dos.

## Outbox (RF34)

Cada cambio de estado se encola y se drena en orden al reconectar. Tres decisiones que se pagan si se toman al revés:

- **La `seq` por orden vive en su propia tabla y NO se deriva de `MAX(seq)` sobre lo pendiente.** La fila se borra al confirmarse, así que derivarla reiniciaría la numeración en 1 y el servidor descartaría transiciones buenas por `SEQ_VIEJA`.
- **El drenado corta en el primer fallo, a propósito.** Saltear una transición le haría llegar al servidor una `seq` mayor, y después la que quedó atrás se descartaría por vieja.
- **Una fila mala no puede dejar a la sucursal sin trabajo.** Un fallo del drenado **no corta el ciclo**: si lo cortara, una sola transición que el servidor rechaza por su contenido dejaría a la sucursal sin reclamar y sin latir, y para el servidor esa sucursal estaría muerta. La fila que el servidor rechaza **por su contenido** termina en una cola muerta después de N intentos; un enlace caído no archiva nada, porque eso lo sufren todas las filas por igual y vaciar la cola por eso sería perder cada cambio de estado de la sucursal.

El estado local y su reporte se escriben en **una sola transacción**: quedan las dos escrituras o no queda ninguna. Estaban separadas, y ahí es donde se pierde un cambio de estado sin que nada falle.

## Órdenes locales (RF35) y degradación (RF36, RF37)

- Las órdenes que nacen en la tablet se admiten y ejecutan **sin enlace**, y se empujan al servidor al reconectar. Su `externalOrderId` lleva **prefijo por agente**: una colisión con un id de picking no falla ruidosamente, deduplica dos órdenes distintas en una sola y deja un pedido sin atender.
- **No hay modo silencioso.** `/health` publica `link.status` (`DISABLED` / `CONNECTED` / `DEGRADED`), el último contacto y el tamaño del outbox, para que la pantalla del operario pueda avisar "sin conexión con el servidor de pedidos" sin que parezca que el robot está caído. No hay cuarto estado: o está sincronizado o lo dice.
- **Backoff exponencial con jitter y techo**, y el azar **se inyecta**: un backoff con jitter que no se puede testear es un backoff que nadie verifica.
- **Piso de frecuencia entre ciclos buenos.** El long-poll debería retener la conexión del lado del servidor, pero eso es configuración del **otro** proceso: si contesta al instante, el ciclo vuelve a salir enseguida y la sucursal se convierte en un generador de tráfico. Una protección que depende de cómo esté configurado el otro extremo no es una protección.

## Otros defectos encontrados, todos confirmados con un test

- **Ninguna request del enlace tenía timeout.** Contra un servidor que acepta la conexión TCP y **no contesta** —proceso congelado, firewall en DROP, NAT que descarta el flujo, que son las caídas típicas de un enlace de sucursal— la request no volvía nunca: el bucle quedaba clavado, nunca fallaba así que nunca hacía backoff, `/health` seguía diciendo `CONNECTED` con el outbox creciendo, y `detener()` no terminaba, o sea que el apagado del agente colgaba.
- **Una orden ya terminada localmente cuyo `DONE` se perdió se re-entregaba para siempre.** El dedupe del agente la absorbía en silencio y nadie volvía a reportar, así que quedaba `PENDING` eterna en la app de picking, ocupando cupo del reclamo. Ahora se re-encola la transición terminal.
- **`/report` no validaba la credencial contra el `siteId` de la orden.** Cualquier credencial válida podía mover el estado de órdenes de otra sucursal.
- **`rehidratar()` estaba implementado pero sin cablear.** Una orden `IN_PROGRESS` tras un reinicio quedaba huérfana: el ciclo del robot solo toma `PENDING`, así que el robot quedaba ocupado para siempre.
- **Un throw del repositorio bajaba el proceso**, en el agente y en el servidor: handlers async sueltos que Express 4 no puede atrapar.

## Testing

94 tests nuevos (de 171 a 265 en `test:packages` al momento de este PR). Los que más valen no son los del camino feliz:

- el enlace **contra el servidor real por HTTP**, no contra un doble: re-entrega por lease vencido sin repetir la maniobra, outbox que acumula con el cable cortado y drena en orden, drenado que se corta a la mitad, transición descartada por vieja y por repetida;
- el servidor que acepta la conexión y no contesta;
- la excepción dentro del ciclo que sale como `DEGRADED` y no mata el bucle;
- la suite de autenticación por firma, que afirma lo del principio: sin firma no se escribe nada aunque el `keyId` sea el correcto, **mandar el secreto en claro ya no autentica nada**, una firma de otra credencial se rechaza, una firma vieja se rechaza por la ventana, y una firma que no cubre el body que se mandó se rechaza.

Gates en verde en el tope del stack:

| gate | resultado |
|---|---|
| `build` · `typecheck` · `lint` · `format:check` | exit 0 |
| `test:packages` | 363 tests |
| `npm test` (legacy, `node --test`) | 60 tests |

## Fuera de alcance

El agente arranca con el **enlace apagado por default**, y así se despliega: en el cutover la sucursal corre primero sola, una jornada completa con su cola local, y el enlace se enciende después (ver `docs/cutover-fase-1.md`).
