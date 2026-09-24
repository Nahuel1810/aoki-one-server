# fix: cerrar las otras tres puertas al accidente de la zona de pickeo

## Qué hace

El accidente que motivó el invariante de RF11 no tenía una sola puerta. El PUT
sin destino ya está bloqueado; esta rama cierra los otros tres caminos que
llevan al mismo estado —los libros diciendo que el slot está LIBRE con el cajón
todavía apoyado—, que es el que hace que el próximo PICK traiga otro cajón y
empuje al viejo.

## El estado peligroso

No es "el destino del PUT estaba mal". Es **un slot que en libros figura sin
cajón y físicamente tiene uno**. El daño lo produce el PICK siguiente, que elige
ese slot porque los libros dicen que está disponible. Cualquier camino que
produzca esa mentira produce el choque.

## Cambios técnicos

**1. `POST /api/slots/:code/release` sobre un slot con cajón** — reproducía el
choque de punta a punta, y estaba fijado por un test verde.

- `LIBERAR_MANUAL` pasa a llevar `slotVacioConfirmado: boolean`.
- Si el slot tiene cajón **en libros**, rechaza con `SLOT_CON_CAJON_EN_LIBROS`,
  que incluye de dónde salió el cajón. El 409 dice qué hay apoyado y qué hacer.
- Sin cajón en libros libera igual que antes: es la salida que existe para
  destrabar un PICK fallido que dejó el slot en RESERVADO o BUSCANDO, y
  bloquearla dejaría el slot muerto hasta editar SQLite a mano.
- `cajonEnLibros(estado)` en el dominio: OCUPADO siempre; RESERVADO y
  DEVOLVIENDO según RF11; el resto nunca. Es función y no un `in` suelto para
  que un estado nuevo con contenido tenga que pasar por ahí.

**2. El 409 de la cancelación recomendaba ese camino.** Decía "liberá el slot a
mano con POST …/release y cancelá después", sin condición. Ahora lo condiciona a
que el slot ya no tenga el cajón encima.

**3. La migración salteaba el `OCUPADO` intraducible.** Un slot que el legacy da
por ocupado pero sin decir qué cajón tiene no se puede traducir —inventar el
cajón sería decidir que hay algo apoyado que quizá no está—, así que se omitía.
Sin fila propia, `sembrarZonaDePickeo` del arranque siguiente lo creaba **LIBRE**.
Ahora aterriza en `ERROR` con el motivo adentro: se sigue reportando como fila a
mirar, pero queda fuera de juego en vez de disponible.

## Testing

- **Dominio**: liberación declarada desde los seis estados; sin declarar, libera
  los que no tienen cajón y rechaza los que sí; y el rechazo alcanza a RESERVADO
  y DEVOLVIENDO con cajón conservado, que es el estado exacto en que RF11 y RF13
  dejan un slot.
- **API**: el release a ciegas sobre un slot OCUPADO da 409, el mensaje nombra el
  origen del cajón y el slot **sigue OCUPADO**; con la declaración da 200 y deja
  el evento.
- **Migración**: el `OCUPADO` sin cajón se reporta **y** queda escrito en ERROR.
  La segunda corrida no lo pisa.
- **Sembrado**: `INSERT OR IGNORE` no pisa el slot con cajón al reiniciar. No
  tenía ninguna cobertura: las 18 llamadas de la suite sembraban zonas vacías,
  así que nada sostenía que un reinicio no dejara los doce slots en LIBRE.

Verificado que muerden: neutralizar cada barrera por separado hace fallar sus
tests y ninguno más.

442 tests, `tsc -b` y `eslint` verdes.

## Nota sobre la paridad con el legacy

En estos cuatro puntos el legacy **no es la referencia**: su comportamiento es el
bug. El `releaseSlot` del legacy pisa `status`, `reservedByOrderId` y `currentBox`
sin condición, que es exactamente la mentira que produjo el accidente. Se trata
como corrección deliberada, no como divergencia a revertir.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
