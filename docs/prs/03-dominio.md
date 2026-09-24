# feat(domain): implementar la logica pura del dominio (T03–T10)

**Rama**: `rewrite/03-dominio` → `rewrite/02-contrato-de-aceptacion`

## Qué hace

Implementa `packages/domain`: la lógica que decide qué tiene que hacer el robot, sin I/O, sin red y sin relojes. Es la mitad del contrato de aceptación que se pone en verde con este PR.

## Cambios técnicos

- **`locationCode`**: la gramática viva `/^([A-Z0-9]+)(\d{2})A([A-L])(\d)([TDL])?$/`, con la `A` como separador literal y el prefijo de estantería codicioso. Normaliza `trim` + mayúsculas. Deriva el lado por **paridad del módulo** (par = derecho, impar = izquierdo), el nivel por `charCodeAt - A + 1` acotado a doce, y normaliza el sufijo `L` a `D`.
- **`plcProtocol`**: comando de carro `<posicion><parante:2><ladoBit><accionBit>` con `parante = ceil(modulo / 2)`, y elevador `100 + nivel` sin clamp.
- **`decodificarRespuesta`**: 100 OK, 101–199 error con código `valor - 100`, 200–299 nivel, 300/301 presencia de carro, resto desconocido. El 99 es fatal.
- **`slotStateMachine` y `order`**: transiciones como funciones totales. Una transición inválida es error tipado, no `null` silencioso ni merge que acepta cualquier salto (RF06). `PENDING → DONE` directo ahora se rechaza.
- **`pendingReturns`**: el contador arranca en 1 al ocupar y no baja de 1 mientras el cajón esté apoyado (RF07).
- **`slotSelection`**: el lado es **exclusión**, no penalización de orden — el carro no cruza de lado. Desempate por mismo nivel, distancia de nivel, distancia de módulo y posición.

## Un bug de planta que se corrige de paso

`decodificarRespuesta` recibe el dispositivo y resuelve el texto contra **su** tabla. El legacy usa `CARRO[c] || ELEVADOR[c]` sin saber quién respondió, y los códigos 1, 2, 17, 18 y 99 existen en las dos con significados distintos ("Carro trabado avanzando" vs "Elev trabado subiendo"), así que hoy un error del elevador se le muestra al operario con el texto del carro.

## Testing

- Suite de aceptación: de 87 rojos a 50. El dominio queda completo.
- `typecheck`, `lint`, `format:check` en verde. Suite legacy (60) intacta.
