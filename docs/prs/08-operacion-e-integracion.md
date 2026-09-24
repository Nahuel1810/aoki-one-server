# feat: contrato del front, observabilidad, migración y e2e (T21, T22, T23, T25)

**Rama**: `rewrite/08-operacion-e-integracion` → `rewrite/07-sync-agente`

## Qué hace

Todo lo que hace falta para poder **poner esto en una sucursal** y no solo para que compile: el contrato que el front nuevo consume, los logs con los que se diagnostica una orden trabada, la retención que evita que el disco de la notebook se llene, el script que importa la base del robot viejo y la suite e2e que ejercita los caminos de error de punta a punta.

## Lo más importante de este PR: la devolución estándar de un cajón nunca funcionó

Lo encontró la suite del contrato del front (T22), ejercitando el flujo que el operario hace **decenas de veces por día**: devolver un cajón desde un slot de pickeo.

**Qué pasaba.** RF11 dice que en un PUT sobre un slot **con cajón en libros** el destino sale del cajón (`currentBox.sourceLocationCode`) y se ignora cualquier `targetLocation` recibido. La resolución lo calculaba bien. Y ahí se perdía: el destino resuelto **no se persistía en la orden ni viajaba en el resultado**, y el ciclo del robot armaba los cinco pasos con la orden que ya tenía en la mano —la que había leído de la cola—, cuyo `targetLocation` es el del pedido. En la devolución estándar el pedido no trae destino, porque justamente RF11 dice que no hace falta. O sea: `null`.

**Cómo se veía en planta.** La orden moría armando los pasos, con "destino inválido", y **el cajón no volvía nunca a su ubicación de guardado**. No es un caso de borde: es el camino principal del PUT. La única devolución que funcionaba era la manual fuera-de-libros, que es la que sí manda `targetLocation`.

**Cómo quedó.** El destino resuelto se **persiste** en la orden y además **viaja en la resolución**, y el ciclo ejecuta la orden de la resolución, no la que leyó de la cola. Las dos cosas: persistirlo es lo que hace que el retry y la rehidratación lo encuentren; devolverlo es lo que hace que esta pasada no tenga que releer.

### Y al lado, el que se comía la zona de pickeo

Mientras se cubría ese camino apareció el hermano: la orden que vuelve a `PENDING` **con su slot todavía tomado** —lo que pasa después de un retry (RF13) y después de una rehidratación (RF15)— volvía a resolver slot desde cero.

- En un **PICK** eso abandonaba el slot anterior: el suyo ya no está `LIBRE`, así que el ranking lo excluye, elige otro, y el viejo queda en `BUSCANDO` para siempre —el único evento que sale de ahí es el `OCUPAR` de la maniobra que acaba de fallar—. **Cada retry se comía un slot de la zona de pickeo, en silencio.**
- En un **PUT** era peor: su slot está en `DEVOLVIENDO`, la resolución contesta `ESPERAR_SLOT`, y la orden queda esperando **el slot que ella misma retiene**. Ni avanza ni falla nunca.

Ahora el slot que la orden ya tiene en la mano se reusa en vez de re-elegirse, y la definición de "qué estado retiene un slot" quedó en **una sola función**, que usan la resolución y la cancelación. Dos criterios distintos para lo mismo es como se pierde un slot.

## El contrato del front (T22)

El front vive en `packages/web` y tiene su propia spec: este PR no lo rediseña, le **garantiza el contrato**, que es lo único que los dos cutovers comparten.

- Rutas y envoltorio `{ ok, data }` / `{ ok, error }` en todas las respuestas.
- `side` y `robotId` por slot en `GET /api/slots` —más `level` y `position`—, que es lo que el tablero necesita para armar la grilla sin reimplementar la gramática de `locationCode`.
- El estado del enlace en `/health`, para que la pantalla pueda decir "sin conexión con el servidor de pedidos" sin que parezca que el robot murió.

**Los esquemas del front se copian en el test en vez de importarse**, y la copia está señalada como tal. `packages/web` no es un workspace de este `tsconfig`: tiene su propio build, su propio zod y un alias que acá no existe, así que importarlo rompería el typecheck del monorepo. La copia cuesta mantenerla sincronizada y paga ese costo con lo que da: **la suite falla cuando el agente se desvía**, que es cuando nadie lo está mirando. El front valida cada respuesta con esos mismos esquemas en runtime y descarta la pantalla entera si no pasan, así que un campo de menos acá no es un campo de menos allá: es una pantalla vacía.

También entra el botón **cancelar** de la tablet (RF21), con dos cortes que protegen lo mismo: solo se cancela una orden `PENDING` —cancelar es sacar de la cola, **no** abortar una maniobra—, y no se cancela una orden que todavía retiene su slot, porque eso lo abandonaría para siempre. Para esas el operario tiene retry. Y **pausar la cola** no aborta la orden en curso: deja de tomar trabajo nuevo, y nada más.

## Logs, retención y purga (T21)

**El valor entero de los logs es la correlación.** Cuando una orden se traba, el operario dice "el pedido 47 se trabó", y alguien tiene que poder seguir ese pedido desde el alta en el servidor hasta el comando que salió al PLC. Con `console.log` suelto de los dos lados eso no se puede hacer: no hay ningún campo común con el que cruzar las dos mitades.

- La correlación es un **campo tipado**, no texto libre dentro del mensaje, y lleva los dos identificadores que existen de los dos lados: el `ordenId` del libro del servidor y el `externalOrderId` que dice el operario.
- Los campos son **nullables y no opcionales**: "no lo sé" es un dato. Un campo ausente se lee como olvido; un `null` explícito se lee como "todavía no hay vínculo", que es exactamente lo que pasa con una orden local antes de empujarla al servidor.
- El logger vive en `domain` porque las dos mitades lo necesitan igual, y sigue siendo puro: el reloj y el destino de la línea se inyectan.
- Una línea JSON por evento a **stdout**, y quien corre el proceso decide dónde va. Así no hay dos mecanismos de rotación peleando por el mismo archivo.
- **Lo que queda apagado deja constancia al arrancar**: `PLC_SIMULATED`, `LINK_DISABLED`, `MAINTENANCE_COMMAND_DISABLED`. Los defaults del agente fallan cerrados a propósito, y un default que falla cerrado sin decirlo se ve en planta como "no anda y no sé por qué".

**La purga corre sola**, con el proceso: el agente vive en una notebook que nadie mantiene, y una purga que depende de que alguien se acuerde de ejecutarla es una purga que no existe. Qué se purga y qué no es la decisión de la task, y el error fácil es tratar todas las tablas que crecen como si fueran lo mismo:

| Tabla | ¿Se purga? | Por qué |
|---|---|---|
| `events` | **Sí**, por antigüedad | Es la traza de diagnóstico, y esa pregunta se hace en los días posteriores, no meses después |
| `order_steps` | **Sí**, pero solo las de órdenes **ya terminadas** | Es la que más rápido crece (cinco filas por maniobra). La guarda no es cosmética: los pasos de una orden en curso son lo que lee la rehidratación, y con un reloj corrido purgar por `ts` del paso se llevaría los de una maniobra viva |
| `order_metrics` | **No** | Es el histórico con el que el negocio mide, y su reporte filtra justamente por rango de fechas. Es una fila chica por orden: no es lo que llena el disco |
| `orders` | **No** | Es la clave del dedupe: borrar una orden vieja hace que una re-entrega se admita como nueva y el robot repita una maniobra que ya hizo |
| `outbox` / cola muerta | **No** | La primera es trabajo pendiente, no histórico. La segunda son cambios de estado que picking no vio nunca, y existen para que alguien pueda reconstruirlos |

Del lado del servidor, la misma idea con otra frontera: se purgan los pedidos **terminados**, y lo que sigue abierto no se purga nunca por viejo que sea.

## Migración desde la base actual (T23)

Se corre **una sola noche**, con poco descanso y sobre la base de un robot en producción. Las cuatro propiedades que lo hacen usable en ese contexto:

1. **La base origen se abre en SOLO LECTURA**, y lo impone SQLite, no la disciplina de quien corre el script. Es la única garantía real de poder volver atrás: ni un flag de "ya migrado", ni el `CREATE TABLE IF NOT EXISTS` que los stores viejos ejecutan al construirse. Por eso tampoco se reusa el store legacy para leer: su constructor escribe.
2. **Por defecto simula.** Escribir exige `--aplicar` escrito a mano, y el reporte de la simulación dice exactamente lo mismo que diría la corrida real.
3. **Es idempotente.** Correrlo dos veces no duplica ni pisa, y un slot que el agente nuevo ya modificó no se sobrescribe: se reporta. Sin esa regla, una segunda corrida "por las dudas" volvería el estado al del snapshot: una regresión silenciosa a medianoche.
4. **Todo lo que no se pudo migrar sale en el reporte con el motivo.** Una fila corrupta se saltea y se informa, y no corta la migración de las demás: la alternativa es descubrir a las 3 AM que faltan 200 métricas por un `location_code` en `null`.

Se migran las tres cosas que no se pueden reconstruir solas: los **slots con su estado** (describen qué hay apoyado físicamente **ahora**; arrancar con la zona vacía hace que el agente crea que puede reservar un slot con un cajón encima), las **órdenes abiertas** y el **histórico de métricas**, con `site_id` agregado. El servidor arranca vacío: las órdenes abiertas al momento del cutover las termina el agente desde su cola local.

## Tests funcionales (T25)

E2e con PLC simulado y servidor de prueba, con foco en los caminos que no son el feliz:

- el recorrido completo de un pedido de picking, del alta firmada al cajón apoyado;
- **el enlace se cae después de ejecutar**: la transición queda en el outbox y sale al reconectar;
- **el agente se reinicia a mitad de una orden**: rehidrata y la termina;
- **un paso del PLC falla**: el slot conserva su estado y el retry replaya la orden desde `HOMING`;
- **la orden manual de la tablet sin enlace**, y su push diferido;
- **el servidor re-entrega por lease vencido**: llega el mismo `externalOrderId` y el robot no repite la maniobra;
- **el operario cancela desde la tablet** y la cancelación llega al servidor.

## Testing

Gates en verde:

| gate | resultado |
|---|---|
| `build` · `typecheck` · `lint` · `format:check` | exit 0 |
| `test:packages` | 363 tests |
| `npm test` (legacy, `node --test`) | 60 tests |

## Fuera de alcance

El rediseño del front va por su propia spec (`docs/specs/2026-09-21-frontend-vite-react.md`): acá solo se le garantiza el contrato, para que los dos cutovers no caigan el mismo día.
