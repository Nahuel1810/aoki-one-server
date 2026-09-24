# feat(agent): transporte Modbus y persistencia SQLite (T11, T13–T15)

**Rama**: `rewrite/04-agente-infra` → `rewrite/03-dominio`

## Qué hace

La infraestructura del agente: cómo le habla a los PLCs y dónde guarda el estado. Es lo que reemplaza al `ConnectionService` y al `StateManager` del sistema actual.

## Transporte

- **`DeviceMutex`**: una cadena de promesas **por dispositivo**. `modbus-serial` usa un socket half-duplex y dos requests intercalados corrompen frames, así que buena parte de los `ECONNRESET` históricos eran autoinfligidos. Dos dispositivos distintos siguen corriendo en paralelo.
- **Handshake (RF17)**: escribe `messageIn`, pollea `messageOut` hasta el código esperado, resetea y **verifica** que vuelva a 0. El paso no cierra por envío sino por confirmación. El comando del carro va partido en dos registros con **split decimal a 5 dígitos** (41000 → alto 4, bajo 1000), que no es el `>> 16` / `& 0xffff` que uno escribiría de memoria, y el reset escribe los dos.
- **Monitor (RF18)**: backoff exponencial con techo, recreación de cliente por **módulo** de N fallos (5, 10, 15…) y no por umbral, y hard reset que además libera el mutex. Cede el socket por robot cuando el orquestador está ejecutando.
- **Clasificación (RF19)**: se invierte la regla. El legacy reintentaba por defecto y fallaba solo con opt-in; ahora solo el transporte se reintenta.

## Un defecto real que se arregla

Con `socket` y `tcp` entre las frases de conectividad, un `TypeError` como `Cannot read properties of undefined (reading 'socket')` se clasificaba como error de red y entraba al loop de reintentos: 11 rondas × 3 intentos × 2 s por un bug de programación. Es lo contrario de lo que RF19 pide. Un error de programación es de programación aunque hable de sockets.

## Persistencia

- El dedupe por `(site_id, external_order_id)` lo rechaza un **índice único**, no un `SELECT` previo: así no queda ventana entre la consulta y la inserción.
- La cola FIFO por robot sale por índice, no por scan del histórico.
- `sembrarZonaDePickeo` normaliza a `baseCode` y deduplica, y usa `INSERT OR IGNORE` porque sembrar la zona al arrancar **no puede pisar lo que el robot dejó apoyado** (RF15).
- `buscarPorEstanteria` reemplaza al mapa hardcodeado `{ '3X': '1' }`. Una estantería que no está dada de alta no existe: cae el fallback identidad del legacy, que devolvía el código como si fuera un `robotId`.
- El estado del robot deriva de si tiene orden activa, no es un campo suelto que alguien pueda dejar desincronizado.

## Testing

- Transporte: 10/10 de la suite de aceptación.
- Suite de aceptación total: 56 de 90.
- `typecheck`, `lint`, `format:check` en verde. Suite legacy (60) intacta.
