# docs: plan de cutover, contrato de la app de picking y baja de VSCode Ports (T26, T38, T27)

**Rama**: `rewrite/09-cierre` → `rewrite/08-operacion-e-integracion`

## Qué hace

Cierra la Fase 1 con lo único que falta y no es código: **cómo se pone esto en producción sin romper el robot que ya está trabajando**, y **qué tiene que implementar la app de picking** para dejar de apuntarle a la notebook de la sucursal.

No toca `packages/`. Tres documentos:

- `docs/cutover-fase-1.md` — el plan de cutover (T26).
- `docs/contrato-app-de-picking.md` — el contrato del ingreso de pedidos y la baja de VSCode Ports (T38).
- `docs/prs/` — las descripciones de este stack de PRs (T27).

## El plan de cutover (T26)

Está escrito para que alguien lo siga **de madrugada, con un robot de producción parado**. Por eso no describe el cutover: lo ejecuta. Cada etapa tiene precondiciones, pasos numerados con los comandos reales —los del script de migración y los de los README de despliegue, no inventados—, criterio de éxito, rollback y un momento a partir del cual ese rollback deja de estar disponible.

**Son dos tiempos y no pueden caer el mismo día**, que es lo que la spec fija y lo que el plan hace cumplible:

1. El agente nuevo corre contra el robot real **con el enlace apagado**, una jornada completa, con su cola local.
2. Recién al día siguiente se enciende el enlace y se repunta picking.

El motivo es de diagnóstico, no de prolijidad: si se enciende todo junto y una orden no llega al robot, no hay forma de saber si el sospechoso es el lazo Modbus nuevo, la cola nueva, el enlace o el contrato con picking. Separadas, cada síntoma tiene un solo sospechoso.

Lo que un plan de cutover casi nunca trae y este sí:

- **Criterios de éxito medibles, no "que ande bien".** Diez para la etapa 1 y ocho para la etapa 2, cada uno con el dato exacto de dónde sale y su umbral. La línea base no se estima: sale del **mismo endpoint de métricas** sobre el histórico que trajo la migración, así que el día del cutover se compara contra las dos semanas previas del sistema viejo con la misma fórmula.
- **Rollback por etapa, probado.** El de la etapa 1 se **ensaya en la etapa 0** sobre una copia: un rollback que nunca se corrió no es un rollback. Es barato por una razón concreta —el migrador abre la base vieja en **solo lectura**, así que el sistema viejo conserva su estado intacto— y hay un truco que lo hace casi gratis: **volver atrás con la zona de pickeo vacía**. Si todos los cajones están guardados, no hay nada que reconciliar a mano.
- **Qué se hace con las órdenes en vuelo.** Una orden a mitad de maniobra no se migra: el cajón está físicamente entre dos lugares y ninguna base sabe dónde. Se pausa la cola —pausar no aborta lo que ya arrancó—, se deja terminar lo que hay, y lo que quedó en `ERROR` se resuelve con el procedimiento que el operario ya conoce.
- **Quién aborta y con qué dato.** Una sola persona, presente en la sucursal, decidiendo con la tabla de criterios. No se extiende la ventana, no se "mira un rato más" y no se decide por teléfono con quien no está viendo el robot.
- **El punto de no retorno, explícito**: desinstalar el sistema viejo, que no se hace el día del cutover ni esa semana.

Un detalle operativo que conviene saber antes de que haga falta: **apagar el enlace devuelve a la etapa 1, no al sistema viejo**, y la etapa 1 es una posición estable donde el robot sigue trabajando.

## El contrato de la app de picking (T38)

La app de picking **no vive en este repositorio**, así que lo que corresponde acá es dejar escrito el contrato con precisión suficiente para que quien la mantiene lo implemente sin preguntar: el sobre de headers, el esquema de firma, la ventana anti-replay, el dedupe y los códigos de respuesta, con un ejemplo completo que se puede copiar.

Lo que más se equivoca en una integración así, y está señalado como tal:

- **Firmar bytes distintos de los que se mandan.** El servidor verifica sobre el body **crudo**: serializar el JSON dos veces —una para firmar y otra para enviar— es la forma segura de que la firma nunca cierre. Se serializa una vez.
- **Los GET también van firmados**, sobre la **ruta**, porque no hay body. Sin eso la firma no queda atada al recurso.
- **El reloj.** La ventana anti-replay es de 5 minutos y es simétrica: un reloj corrido se ve como `401` en el 100% de las requests y no se parece en nada a un problema de reloj.
- **Un reenvío devuelve `200` con `created: false` y el pedido original, no crea una orden nueva.** Eso es lo que hace **seguro reintentar** ante un timeout. El error que sí duele es el inverso: leer ese `200` como fallo y reenviar con otro `externalOrderId`, que ahí sí genera una segunda maniobra.
- **El `202` no significa que el pedido se vaya a poder ejecutar.** El servidor no interpreta el `locationCode`: la gramática la valida el agente, así que un código mal formado se admite y después termina en `ERROR`. El estado se consulta.

### Por qué se retira VSCode Ports

Queda escrito en el documento, para que nadie lo vuelva a levantar "por un ratito":

- **El agente deja de ser el punto de entrada de los pedidos**, así que el túnel no tiene ya nada que atender.
- **Todo el tráfico del enlace lo inicia el agente.** Habla con el servidor por HTTPS saliente y el servidor nunca abre una conexión hacia la sucursal: nada de afuera necesita alcanzar a la notebook.
- **La autorización del operario se apoya en estar en la LAN.** La API de la tablet no tiene login: estar en la red de la sucursal equivale a estar parado frente a la tablet. Un túnel a internet rompe exactamente ese razonamiento.
- **El túnel no autenticaba nada.** La API que publicaba —alta de órdenes, comando directo al PLC, liberación de slots— no pedía credencial: quien conociera la URL podía mover el robot.
- **Es una dependencia operativa invisible**, que vive mientras alguien mantenga abierta una sesión de VSCode en esa máquina.

## Las descripciones de PR (T27)

Se completan las que faltaban del stack —enlace, servidor, operación e integración, y esta— siguiendo el formato de las cinco anteriores, y se actualiza `docs/prs/README.md` con las ramas nuevas. El criterio: **lo que más valor tiene es lo que se descubrió**, y eso va en la descripción, no escondido en un commit. Los dos hallazgos que cambian cómo se lee este trabajo:

- **la firma HMAC no autenticaba nada** (PR del enlace), porque el secreto se guardaba hasheado y eso forzaba al servidor a pedírselo al cliente;
- **la devolución estándar de un cajón nunca funcionó** (PR de operación e integración), porque el destino resuelto contra el cajón en libros se tiraba antes de armar los pasos.

## Testing

Este PR es solo documentación: no agrega código ni tests. Los gates se corren igual, para verificar que no se rompió nada al mergear:

| gate | resultado |
|---|---|
| `build` · `typecheck` · `lint` · `format:check` | exit 0 |
| `test:packages` | 363 tests |
| `npm test` (legacy, `node --test`) | 60 tests |

## Fuera de alcance

**El repunte de picking en sí no se hace desde este repositorio**: es un paso operativo de la etapa 2 del cutover, del lado de la app, y depende de que quien la mantiene implemente el contrato. Lo mismo la baja del túnel, que es el último paso del plan. Acá quedan el contrato y el procedimiento; la ejecución tiene fecha, no commit.
