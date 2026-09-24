# test: portar los 55 tests legacy como contrato de aceptacion (T02)

**Rama**: `rewrite/02-contrato-de-aceptacion` → `rewrite/01-spec-y-andamiaje`

## Qué hace

Porta la suite del servidor actual como contrato de la reescritura. Los tests arrancan **rojos a propósito**: son lo que las tasks siguientes tienen que hacer pasar. No hay implementación en este PR.

## Por qué importa

Esos tests codifican conocimiento sacado de horas de planta con un robot real —gramática de `locationCode`, traducción a comandos de carro y elevador, tabla de códigos del PLC, handshake con el split high/low, mutex por dispositivo, clasificación de errores, ranking de slot por cercanía— y la spec dice que se porta, no se re-deriva. Portar mal un test es perder ese conocimiento.

## Cambios técnicos

- **Superficie de contratos** en `packages/{domain,agent,server}/src`: tipos y firmas reales, cada implementación tirando `NotImplemented`. Los tests compilan y fallan en runtime; un test verde acá sería un bug de la fase.
- **90 tests en 30 archivos** `*.aceptacion.test.ts`. Son más que 55 porque varios tests legacy cubrían dos cosas a la vez y se partieron, y porque se agregaron los casos borde que el mapeo detectó faltando.
- **Suite separada y no bloqueante** (`vitest.aceptacion.mts`, `continue-on-error` en CI) para que el contrato pueda estar rojo sin romper el pipeline durante las ~20 tasks que tarda en implementarse.
- `docs/mapeo-t02.md`: el registro de por qué cada test se porta como se porta, y de los 27 RF que la suite **no** cubre (déficit conocido de T24/T25).

## Cambios de contrato que se afirman nuevos

Portados literales, estos habrían pasado en verde tapando justo lo que cambia:

- **Clasificación de errores: la regla está invertida.** El legacy reintenta por defecto y falla solo con opt-in; RF19 reintenta solo transporte. El assert pasa de `true` a `false`.
- **PUT sobre slot vacío en libros**: ahora exige `targetLocation` y sin él es 400 (RF11). El test legacy no lo mandaba y pasaba.
- **Orden en espera por falta de slot**: conserva su lugar en la cola (RF10). El legacy hacía `clearActive` + `enqueue`, o sea la mandaba al final.
- **Slot tras fallo de paso**: conserva `RESERVADO` u `OCUPADO` (RF13). El legacy lo bloqueaba en `ERROR`.
- **Dedupe**: la clave pasa de id numérico a `(siteId, externalOrderId)`.
- **`SIMULATE_PLC` pasa a default `false`**, así que los fixtures lo pasan explícito.

## Defectos del propio test legacy que se arreglaron

- El test del parante nunca probaba un parante de dos dígitos naturales (módulos 19 y 20).
- El del elevador no tocaba los bordes A=1 y L=12.
- El de estantería→robot afirmaba una configurabilidad que producción no usaba.

## Testing

- `typecheck`, `lint` y `format:check` en verde: los tests compilan.
- `test:packages` sigue con los 8 smoke de T01: la suite de aceptación no entra al gate bloqueante todavía.
- `test:aceptacion`: 90 tests, 87 rojos. **Todos fallan por `NotImplemented`**, ninguno por estar mal escrito. Los 3 verdes son el test de arquitectura que afirma la pureza del dominio, que no depende de ninguna implementación.
- La suite legacy (60 tests) intacta.
