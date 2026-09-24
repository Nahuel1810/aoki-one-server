# feat(agent): orquestador, API local y metricas — fase 1 funcional (T12, T16–T20, T24)

**Rama**: `rewrite/05-agente-orquestacion` → `rewrite/04-agente-infra`

## Qué hace

Cierra el agente: el loop que ejecuta las órdenes, la API que consume la tablet y las métricas. Con este PR **el flujo completo de un PICK corre de punta a punta** y la suite de aceptación pasa a verde y a bloquear.

## Cambios de contrato frente al legacy

Son el motivo de la reescritura, no efectos secundarios:

- **RF13 — un paso que falla NO manda el slot a ERROR.** Conserva `RESERVADO` si falló un PICK u `OCUPADO` si falló un PUT, y queda utilizable para el retry. El legacy llama `blockSlot` y lo deja inutilizable para siempre, porque el retry nunca lo desbloquea.
- **RF10 — la orden que espera conserva su lugar.** El legacy hace `clearActive` + `enqueue` y la manda al final cada vez que espera, así que un PICK podía quedar postergado indefinidamente.
- **RF11 — el destino de un PUT sale del cajón en libros.** El legacy hace `target || source`, y para un PUT `source` es el propio slot: sin destino devolvía el cajón al lugar donde ya estaba.
- **Un slot tomado no es una orden inválida.** Un PUT sobre un slot `RESERVADO`, `BUSCANDO`, `DEVOLVIENDO` o en `ERROR` sale por la rama ok como espera: es un estado transitorio, no un defecto del pedido.
- **RF19 — el 99 del PLC corta en el primer intento.** "No logró recuperarse" significa que el PLC ya agotó su recuperación; reintentar solo demora el aviso al operario.
- **El retry resetea `messageIn` antes de reencolar**: sin eso el PLC arranca el reintento con el comando anterior colgado y repite la maniobra que falló.

## API local

- Alta de órdenes manuales, listado, consulta, retry, cola, simulate, slots con liberación manual, dispositivos y comando directo a PLC.
- **`/health` profundo (RF25)**: conectividad por dispositivo, profundidad de cola, última orden completada, timestamp de arranque y estado del enlace. Los campos van en la raíz **y** bajo `data`: el front consume el envelope `{ ok, data }` y el chequeo de infraestructura lee la raíz sin saber de él.
- **Validación por esquema (zod) en el borde.** Lo que se gana no es rechazar basura: es que el motivo llegue al operario. Antes un `locationCode` vacío reventaba adentro del orquestador con un mensaje que hablaba de internals.
- **El comando directo a PLC exige token de mantenimiento y falla CERRADO** (RF22): sin token configurado responde 503 y no hay forma de habilitarlo, ni acertándole al header. Es el único endpoint que escribe registros salteándose el orquestador y las máquinas de estado.
- `/api/orders/simulate` deja de exponer `address`, `responseAddress`, `verifyAddress` y `expectedValue`: nunca se calculaban y siempre salían en `null`.
- `/api/devices/robots` devuelve la cola resuelta. El legacy devolvía `{}` porque armaba la promesa y no la esperaba.

## Loop del robot

Avanza **por evento** —el alta despierta el ciclo— con un tick de seguridad de 250 ms para lo que ningún evento despierta, como una orden que espera slot y el slot se liberó por otra vía. El RNF prohíbe el busy-loop de 300 ms del legacy.

## Métricas (RF24)

Las reglas se portan literales porque son los números que el negocio ya viene mirando, y no tenían un solo test:

```
safeStartedAt = startedAt finito y > 0 ? startedAt : finishedAt
waitingMs     = max(0, safeStartedAt - createdAt)
durationMs    = max(0, finishedAt - safeStartedAt)
```

El fallback importa: una orden que termina sin haber arrancado —se resolvió sin maniobra, RF07— es espera pura, no duración negativa. Se registran también las órdenes que fallan: medir solo los éxitos esconde justamente el número que hay que mirar.

## Cobertura (T24)

100% de sentencias, ramas y funciones en `domain`, **con umbral en CI**. Verificado que el umbral muerde: con una función sin cubrir el pipeline rompe.

Lo que faltaba eran las ramas de **rechazo**: la tabla completa de códigos del PLC por dispositivo, la matriz entera de transiciones inválidas de slot y de orden, y los bordes de `pendingReturns`. Las dos únicas ramas sin cubrir son guards que existen solo porque `noUncheckedIndexedAccess` tipa los grupos de la regex como `string | undefined`: inalcanzables con la gramática, excluidas con `v8 ignore` y la razón escrita al lado.

## Testing

Gates en verde desde limpio:

| gate | resultado |
|---|---|
| `build` · `typecheck` · `lint` · `format:check` | exit 0 |
| `test:packages` | 144 tests |
| cobertura con umbral de `domain` | 100% |
| `test:aceptacion` | 90 tests |
| `npm test` (legacy, `node --test`) | 60 tests |

El e2e levanta el agente real, da de alta una orden por HTTP, deja que el orquestador la ejecute sola, y verifica los 5 pasos físicos en orden, el slot ganador, el cajón apoyado con `pendingReturns` en 1 y el health profundo.

La suite de aceptación **pasa a bloquear**: entra en `test:packages` y se le saca el `continue-on-error` del CI. Desde acá una regresión sobre el contrato portado rompe el pipeline.

## Fuera de alcance

`packages/server` tiene solo el ingreso idempotente. La cola durable, el long-poll con lease, el outbox y el heartbeat (T28–T37) no están: el mapeo mostró que los 55 tests legacy no los cubren, y escribir esa superficie sin un test que la juzgue es el error que veníamos corrigiendo.
