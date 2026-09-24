# Plan de cutover — Fase 1

Este documento se sigue de punta a punta, en planta y con el robot parado. No
describe el cutover: lo ejecuta. Cada etapa tiene precondiciones, pasos
numerados, un criterio de exito **medible**, un procedimiento de rollback
**probado** y un momento a partir del cual ese rollback deja de estar
disponible.

Hay un robot en produccion. Nada de big-bang.

---

## 0. Las dos reglas que ordenan todo lo demas

1. **Son dos tiempos y no pueden caer el mismo dia.**
   - **Etapa 1**: el agente nuevo corre contra el robot real, con su cola local
     y el **enlace APAGADO**. Una jornada completa de operacion.
   - **Etapa 2**: recien al dia siguiente —o mas tarde— se enciende el enlace
     con el servidor y se repunta la app de picking.

   El motivo es de diagnostico, no de prolijidad: si el primer dia se enciende
   todo junto y una orden no llega al robot, no hay forma de saber si el
   problema es el lazo Modbus nuevo, la cola nueva, el enlace o el contrato con
   picking. Separadas, cada sintoma tiene un solo sospechoso.

2. **El sistema viejo no se desinstala hasta mucho despues de cerrar la etapa
   2.** Es el rollback. Se detiene y se le saca el arranque automatico, pero
   queda en el disco, con su base intacta.

### Que se esta reemplazando

|                       | Hoy (legacy)                                        | Etapa 1                                        | Etapa 2                              |
| --------------------- | --------------------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| Proceso               | `src/server.js` en la PC de la sucursal             | `packages/agent` en la notebook                | igual que etapa 1                    |
| Escucha               | `0.0.0.0:3000`, **expuesto por VSCode Ports**       | IP de LAN, sin puertos hacia afuera            | igual                                |
| Base                  | `data/persistence.db` (snapshot completo por paso)  | `C:\aoki-one\datos\agente.db`                  | igual                                |
| Pedidos de picking    | `POST /api/orders/pick`, **sin autenticacion**      | **no entran**: se cargan a mano desde la tablet | `POST /api/v1/orders` al Linux, firmados |
| Libro de los pedidos  | solo la sucursal                                    | solo la sucursal                               | servidor (admision) + agente (ejecucion) |

---

## 1. Quien decide, y con que dato

| Rol                         | Quien                                          | Que decide                                                                                     |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Responsable de cutover**  | una sola persona, **presente en la sucursal**  | es el **unico** que aborta. Decide con la tabla de criterios de cada etapa, no con impresiones   |
| Operario de referencia      | el que opera la tablet ese dia                 | reporta lo que ve. No aborta, y tampoco "aguanta" un problema para no frenar el dia              |
| Operacion del Linux         | quien administra el servidor de pedidos        | ejecuta la etapa 2 del lado del servidor. No toca la sucursal                                    |

**Regla de aborto**: si un criterio de exito no se cumple, se aborta. No se
extiende la ventana, no se "mira un rato mas" y no se decide por telefono con
quien no esta viendo el robot. Un criterio que no se puede medir con los
comandos de este documento no es un criterio: es una opinion.

---

## 2. Etapa 0 — Ensayo, dias antes, sin tocar produccion

Se hace con el sistema viejo corriendo normalmente. No hay ventana ni riesgo:
nada de lo que sigue escribe en produccion.

1. **Servidor Linux desplegado y verificado** siguiendo `deploy/README.md`
   (puntos 1 a 5, y el 8 de backups). Queda andando y **vacio**: el agente
   todavia no lo conoce.

   ```bash
   curl -s https://pedidos.midominio.com/health | jq
   ```

   Responde `{"ok":true,"data":{"startedAt":...,"sites":[]}}`. La lista de
   sucursales vacia es lo correcto en esta etapa.

2. **Notebook de la sucursal preparada** siguiendo `deploy/README-agente.md`,
   puntos 1 a 3, con **las tres variables del enlace vacias**:

   ```ini
   AOKI_AGENT_SERVIDOR_URL=
   AOKI_AGENT_KEY_ID=
   AOKI_AGENT_SECRETO=
   ```

   `AOKI_AGENT_SIMULAR_PLC` queda en `false`, que es el default. Que el agente
   este instalado no significa que este corriendo: el servicio todavia no se
   arranca.

3. **Copia de la base de produccion y ensayo de la migracion sobre la copia.**

   ```powershell
   sqlite3 C:\ruta\al\legacy\data\persistence.db ".backup 'C:\aoki-one\ensayo\persistence.db'"

   node C:\aoki-one\app\packages\agent\dist\migracion\cli.js `
     --origen C:\aoki-one\ensayo\persistence.db `
     --destino C:\aoki-one\ensayo\agente.db `
     --site-id SUC-CENTRO
   ```

   Sin `--aplicar` el script **simula**: no escribe una sola fila y el reporte
   dice exactamente lo mismo que diria la corrida real. Despues se repite con
   `--aplicar` sobre la copia, para tener la base de ensayo.

4. **Arrancar el agente contra la base de ensayo** —nunca contra la de
   produccion— y comparar la zona de pickeo con la realidad fisica:

   ```powershell
   Invoke-RestMethod http://<ip-de-lan>:3000/api/slots | ConvertTo-Json -Depth 5
   ```

5. **Ensayar el rollback** (3.5) sobre esa misma base: parar el agente, arrancar
   el sistema viejo contra su base y liberar un slot. Un rollback que nunca se
   corrio no es un rollback.

**Criterio de exito de la etapa 0**

| Que se mide                     | Como                                                          | Umbral                                                             |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| La migracion no pierde filas    | reporte del CLI                                                | `0 sin migrar`, o cada omitido explicado y aceptado por el responsable |
| La zona de pickeo queda igual   | `GET /api/slots` contra lo que el operario ve en la estanteria | los 12 slots coinciden en estado y cajon, uno por uno               |
| El historico de metricas viajo  | `GET /api/orders/metrics/report` sobre las dos semanas previas | `total` igual al del reporte del sistema viejo para el mismo rango  |
| El servidor Linux esta sano     | `GET /health`                                                  | 200 con `sites: []`                                                 |
| El rollback funciona            | el ensayo del punto 5                                          | el sistema viejo vuelve a mover el robot                            |

**Rollback de la etapa 0**: no hace falta ninguno. La base origen se abre en
**solo lectura** —lo impone SQLite, no la disciplina de quien corre el script— y
todo el ensayo ocurre sobre copias. Si algo sale mal se borra
`C:\aoki-one\ensayo` y se vuelve a empezar.

> **Salida de la etapa 0**: el reporte de migracion guardado y la base de ensayo
> borrada. La etapa 1 vuelve a migrar desde cero, desde la base real.

---

## 3. Etapa 1 — El agente solo, una jornada completa

**Objetivo**: demostrar que el agente nuevo mueve el robot igual o mejor que el
sistema viejo, sin que el enlace ni el servidor participen de nada.

**Ventana**: antes del primer turno, con el robot parado.

### 3.1 Precondiciones (no se avanza sin las cuatro)

- [ ] La etapa 0 cerro en verde y su reporte esta a mano.
- [ ] La zona de pickeo esta **vacia**: ningun cajon apoyado.
- [ ] La cola del sistema viejo esta en cero y **no hay ninguna orden
      IN_PROGRESS**: `curl -s http://<ip-vieja>:3000/api/orders/queue/status | jq`
- [ ] El responsable de cutover esta en la sucursal, no conectado remoto.

### 3.2 Que se hace con las ordenes en vuelo

Una orden a mitad de maniobra **no se migra**: el cajon esta fisicamente entre
dos lugares y ninguna base sabe donde. El procedimiento es el mismo que el de
cualquier fallo de paso, que es el unico que el operario ya conoce:

1. Se pausa la cola del sistema viejo para que no tome mas trabajo:

   ```bash
   curl -s -X POST http://<ip-vieja>:3000/api/orders/queue/1/pause
   ```

   Pausar **no** aborta la orden en curso: solo impide que empiece la siguiente.

2. Se deja **terminar** la orden que esta corriendo. Si termina en `ERROR`, el
   operario devuelve el cajon al punto de origen del paso que fallo y se
   reintenta desde el sistema viejo, hasta dejarla `DONE` o `CANCELED`.
3. Se devuelven todos los cajones de la zona de pickeo a su ubicacion de
   guardado, hasta que `GET /api/slots` del sistema viejo muestre los 12 `LIBRE`.
   Este paso no es cosmetico: es lo que despues hace barato el rollback (3.5).
4. Los pedidos de picking que hayan quedado sin atender **se anotan** —numero y
   ubicacion— y se vuelven a cargar a mano durante la etapa 1: el agente nuevo
   arranca sin ellos.

### 3.3 Pasos

1. **Detener el sistema viejo** y sacarle el arranque automatico. **No se
   desinstala**: es el rollback.
2. **Backup de la base de produccion**, con `.backup` y no con `Copy-Item`: la
   base corre en WAL y el archivo suelto sin su `-wal` es un backup a medias.

   ```powershell
   sqlite3 C:\ruta\al\legacy\data\persistence.db ".backup 'C:\aoki-one\backups\persistence-precutover.db'"
   ```

3. **Migrar, primero simulando**:

   ```powershell
   node C:\aoki-one\app\packages\agent\dist\migracion\cli.js `
     --origen C:\ruta\al\legacy\data\persistence.db `
     --destino C:\aoki-one\datos\agente.db `
     --site-id SUC-CENTRO
   ```

   Se lee el reporte entero. Si aparece un omitido que no estaba en el ensayo,
   **se para aca**: todavia no se escribio nada.

4. **Aplicar**: el mismo comando con `--aplicar`. Correrlo dos veces es seguro,
   lo ya migrado no se duplica ni se pisa.
5. **Arrancar el agente** como servicio (`nssm start AokiOneAgente`), con las
   tres variables del enlace **vacias**.
6. **Verificar el arranque en el log**, antes de tocar la tablet:

   ```powershell
   Get-Content C:\aoki-one\logs\agente.log -Tail 30
   ```

   Tienen que estar `AGENT_STARTED`, `AGENT_LISTENING` y **`LINK_DISABLED`**.
   **No** puede estar `PLC_SIMULATED`: esa linea significa que el robot no se va
   a mover y que la API va a contestar OK igual.

7. **Verificar el estado profundo**, desde la notebook y **tambien desde la
   tablet**. Si contesta en una y no en la otra, el problema es el bind o el
   firewall de Windows:

   ```powershell
   Invoke-RestMethod http://<ip-de-lan>:3000/health | ConvertTo-Json -Depth 5
   ```

   Se miran cuatro cosas: `mode: "live"`, `link.status: "DISABLED"`,
   `devices[].connected: true` para el carro y el elevador, y
   `robots[].queueDepth: 0`.

8. **Maniobra de prueba con el robot real**, antes de abrir el turno: un PICK de
   un cajon conocido desde la tablet, verificar que llega al slot, y su PUT de
   vuelta. Con eso se prueba el lazo completo —cola, slot, los cinco pasos,
   devolucion— sobre hardware real.
9. **Se abre el turno.** Los pedidos del dia se cargan **a mano desde la
   tablet**: durante la etapa 1 la app de picking no le manda pedidos a nadie.
   Es el costo conocido de partir el cutover en dos, y la razon por la que la
   etapa 1 dura **una jornada y no una semana**.

### 3.4 Criterio de exito de la etapa 1

Se evalua **al cierre de la jornada**, con la zona de pickeo vacia. El reporte
del dia sale del propio agente, y la linea base sale del **mismo endpoint**
—sobre el historico que trajo la migracion— para las dos semanas previas:

```powershell
# El dia del cutover (epoch ms)
Invoke-RestMethod "http://<ip-de-lan>:3000/api/orders/metrics/report?startDate=<inicio>&endDate=<fin>"
# Linea base: las dos semanas previas, que vienen del sistema viejo por la migracion
Invoke-RestMethod "http://<ip-de-lan>:3000/api/orders/metrics/report?startDate=<hace14dias>&endDate=<ayer>"
```

| #   | Que se mide                         | Dato exacto                                    | Umbral                                                                                  |
| --- | ----------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Pedidos terminados                  | `summary.failedOrders` del dia                  | `0` fallidos **que no hayan quedado resueltos** con un retry del operario                 |
| 2   | Maniobras por pedido                | `summary.manoeuvresPerOrder`                    | `2.0` (traer y guardar). Se acepta hasta `2.2`, y cada exceso se explica uno por uno      |
| 3   | Tiempo hasta el slot                | `summary.avgTimeToSlotMs` del dia vs. linea base | no mas de **+20%** sobre la linea base                                                    |
| 4   | Peor caso                           | `summary.maxTimeToSlotMs`                       | ningun pedido por encima de **3x** el promedio del dia sin causa identificada             |
| 5   | Estabilidad del proceso             | `AGENT_STARTED` en el log del dia               | aparece **exactamente una vez**: ni un reinicio no planificado                            |
| 6   | Conectividad al cierre              | `/health` → `devices[].connected`               | `true` en todos                                                                           |
| 7   | Cola vacia al cierre                | `/health` → `robots[].queueDepth`               | `0`, y `activeOrderId: null`                                                              |
| 8   | Los libros coinciden con la realidad | `GET /api/slots` contra lo que el operario ve  | los 12 slots iguales, uno por uno                                                         |
| 9   | Nada roto en silencio               | lineas `ERROR` del log del dia                  | ninguna fuera de las de ordenes que el operario ya resolvio                               |
| 10  | Volumen comparable                  | `summary.totalOrders` del dia                   | al menos el **70%** del promedio diario de la linea base: media jornada floja no valida nada |

**Los diez se cumplen o se aborta.** No hay criterio "casi".

### 3.5 Rollback de la etapa 1

**Hasta cuando esta disponible**: durante toda la etapa 1 y, en la practica,
hasta que la etapa 2 admite el primer pedido firmado. Despues de eso el libro de
la admision vive en el servidor y volver atras deja de ser gratis (4.4).

**Por que es barato**: la base vieja nunca se escribio —el migrador la abre en
solo lectura— y el sistema viejo sigue instalado con el estado del momento del
corte. Lo unico que cambio en el medio es **donde estan los cajones**, y eso se
resuelve vaciando la zona antes de volver.

Procedimiento, en orden:

1. **Que no quede nada a mitad de camino.** Si hay una orden en curso
   (`/health` → `robots[].activeOrderId` distinto de `null`) se la deja
   terminar. Si queda en `ERROR`, el operario devuelve el cajon al punto de
   origen del paso que fallo y se usa `POST /api/orders/<id>/retry` hasta
   cerrarla. **Cancelar no aborta una maniobra**: solo saca de la cola un pedido
   que todavia no arranco, y por eso responde `409` sobre una orden en curso.
2. **Vaciar la zona de pickeo**: un PUT por cada slot ocupado, desde la tablet,
   hasta que los 12 queden `LIBRE`. Este paso es el que hace innecesaria
   cualquier reconciliacion a mano.
3. **Detener el agente**: `nssm stop AokiOneAgente`, y sacarle el arranque
   automatico.
4. **Arrancar el sistema viejo** con su base original, la de
   `C:\ruta\al\legacy\data\persistence.db`, que no fue tocada.
5. **Reconciliar la zona en el sistema viejo**: cree que la zona esta como al
   momento del corte. Con la zona ya vacia en la realidad, alcanza con liberar
   los slots que el viejo muestre ocupados:

   ```bash
   curl -s -X POST http://<ip-vieja>:3000/api/slots/<locationCode>/release
   ```

6. **Reanudar la cola** del sistema viejo (`POST /api/orders/queue/1/resume`) y
   volver a apuntar la app de picking a `POST /api/orders/pick`, como estaba.
7. **Cargar a mano los pedidos que el agente atendio y picking no vio**, si el
   negocio los necesita en el libro viejo.

**Si el rollback se hace con la zona llena** —una emergencia a mitad de
jornada— el paso 5 se invierte: el operario devuelve los cajones a mano y
despues se liberan los slots. Es mas lento y mas propenso a error, y por eso la
decision de abortar se toma, siempre que se pueda, **con la zona vacia**: al
cierre de la jornada o en un corte del turno.

---

## 4. Etapa 2 — Encender el enlace y repuntar picking

**No antes del dia siguiente.** Precondicion dura: la etapa 1 cerro con sus diez
criterios en verde.

**Objetivo**: que los pedidos de picking entren por el servidor Linux y lleguen
al agente por el enlace, y que el estado vuelva por el mismo camino.

### 4.1 Precondiciones

- [ ] Etapa 1 cerrada en verde, con los numeros guardados.
- [ ] Zona de pickeo vacia y cola del agente en cero.
- [ ] `GET /health` del servidor Linux responde 200.
- [ ] Quien mantiene la app de picking leyo `docs/contrato-app-de-picking.md` y
      **ya tiene la implementacion lista y probada** contra una credencial de
      prueba. El dia del cutover no se escribe codigo de integracion.

### 4.2 Pasos

1. **Emitir la credencial de la sucursal** en el Linux (`deploy/README.md`,
   punto 6). El secreto se imprime **una sola vez**.

   ```bash
   sudo systemd-run --uid=aoki --pipe --quiet \
     --property=EnvironmentFile=/etc/aoki-one/servidor.env \
     /usr/bin/node /opt/aoki-one/packages/server/dist/herramientas/emitirCredencial.js \
     --site-id SUC-CENTRO
   ```

2. **Pegar las tres lineas** en `C:\aoki-one\agente.env`, mas la URL publica:

   ```ini
   AOKI_AGENT_SITE_ID=SUC-CENTRO
   AOKI_AGENT_KEY_ID=6f1c...
   AOKI_AGENT_SECRETO=9a2b...
   AOKI_AGENT_SERVIDOR_URL=https://pedidos.midominio.com
   ```

   Van juntas. **Una URL sin secreto no arranca**, a proposito: un despliegue a
   medio terminar que degradara a "enlace apagado" dejaria una sucursal que
   parece andar y no reporta nada.

3. **Verificar la hora de la notebook.** La firma lleva timestamp y la ventana
   anti-replay es de **5 minutos**: un reloj corrido se ve como `401` en todas
   las requests y no se parece en nada a un problema de reloj.
4. **Reiniciar el agente**: `nssm restart AokiOneAgente`. En el log ya **no**
   tiene que aparecer `LINK_DISABLED`.
5. **Verificar el enlace de los dos lados**, con el robot todavia sin pedidos de
   picking:

   ```powershell
   Invoke-RestMethod http://<ip-de-lan>:3000/health | ConvertTo-Json -Depth 5
   ```

   `link.status` tiene que decir `CONNECTED`, `link.outboxSize` `0` y
   `link.lastContactAt` un instante de hace segundos.

   ```bash
   curl -s https://pedidos.midominio.com/health | jq '.data.sites'
   ```

   La sucursal tiene que aparecer con `caida: false`.

6. **Un pedido de prueba, firmado, desde la app de picking**, con un
   `externalOrderId` reservado para la prueba. Se verifica el recorrido con el
   **mismo id a los dos lados**:

   ```bash
   journalctl -u aoki-one-server -o cat | jq 'select(.correlacion.externalOrderId == "PRUEBA-1")'
   ```

   ```powershell
   Select-String -Path C:\aoki-one\logs\agente.log -Pattern '"externalOrderId":"PRUEBA-1"'
   ```

   Tiene que verse `ORDER_INGESTED` → `WORK_LEASED` en el servidor,
   `ORDER_STARTED` → `ORDER_DONE` en el agente, y despues `TRANSITION_APPLIED`
   de vuelta en el servidor.

7. **Repetir el mismo pedido tal cual** (mismo `externalOrderId`): tiene que
   responder **200 con `created: false`** y **no** generar una segunda maniobra.
   Es la prueba de que el dedupe esta vivo, y se hace antes de abrir el turno.
8. **Se abre el turno** con picking apuntando al servidor Linux.

### 4.3 Criterio de exito de la etapa 2

| #   | Que se mide                  | Dato exacto                                             | Umbral                                                                          |
| --- | ---------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Los pedidos llegan           | `ORDER_INGESTED` vs. `WORK_LEASED` vs. `TRANSITION_APPLIED` terminal | **100%**: por cada alta hay una entrega y una transicion terminal      |
| 2   | Nada queda sin reportar      | `/health` del agente → `link.outboxSize`                  | `0` al cierre, y nunca por encima de `20` durante el dia                         |
| 3   | El enlace no se cae          | `link.status` muestreado a lo largo del dia               | `CONNECTED`. Cada `DEGRADED` se anota con su duracion y la suma no pasa de 5 min |
| 4   | La presencia se ve           | `/health` del servidor → `sites[].caida`                  | `false` en todo el turno                                                         |
| 5   | Sin rechazos de firma        | `AUTH_REJECTED` en el log del servidor                    | **ninguno** despues del primer pedido bueno                                      |
| 6   | Sin re-entregas por lease    | `WORK_LEASED` repetido para el mismo `ordenId`            | ninguno sin causa identificada                                                   |
| 7   | Sin transiciones perdidas    | `TRANSITION_DISCARDED` con motivo distinto de `SEQ_REPETIDA` | ninguno                                                                       |
| 8   | La operacion no empeoro      | `summary.avgTimeToSlotMs` vs. el dia de la etapa 1        | no mas de **+10%**                                                               |

### 4.4 Rollback de la etapa 2

Tiene una propiedad que conviene entender antes de necesitarla: **apagar el
enlace devuelve a la etapa 1, no al sistema viejo**, y la etapa 1 es una
posicion estable donde el robot sigue trabajando.

1. **Anotar lo que queda del lado del servidor antes de apagar**:

   ```bash
   curl -s https://pedidos.midominio.com/health | jq '.data.sites[].pendientes'
   ```

2. **Apagar el enlace**: vaciar `AOKI_AGENT_SERVIDOR_URL`, `AOKI_AGENT_KEY_ID` y
   `AOKI_AGENT_SECRETO` en `C:\aoki-one\agente.env` y `nssm restart
   AokiOneAgente`. El log vuelve a decir `LINK_DISABLED`.
3. **Volver a apuntar picking** a la carga manual desde la tablet.
4. **Las ordenes en vuelo no se pierden**: las que el agente ya reclamo estan
   espejadas en su SQLite y se ejecutan igual, con el enlace caido o apagado. Lo
   que **si** queda sin llegar es su estado final: el servidor conserva esos
   pedidos con el lease vencido y la app de picking los ve `PENDING` para
   siempre. Por eso se anotan en el paso 1 y se cierran a mano del lado de
   picking.
5. **Los pedidos admitidos que el agente nunca reclamo** quedan en la cola del
   servidor. Salen de la misma consulta y se cargan a mano en la tablet.

**Hasta cuando**: el rollback a la etapa 1 esta disponible **siempre**, incluso
meses despues. Lo que no vuelve gratis es lo de mas atras: una vez que picking
admitio pedidos contra el servidor, el libro de la admision de esos pedidos vive
ahi, y volver al sistema viejo es el procedimiento de 3.5 **mas** cargar a mano
los pedidos que ya entraron por el Linux.

### 4.5 Punto de no retorno

Hay uno solo y es explicito: **cuando se desinstala el sistema viejo de la PC de
la sucursal**. No se hace el dia del cutover ni la semana del cutover. Se hace
cuando pasaron al menos **dos semanas** de etapa 2 en verde, y con el backup
`persistence-precutover.db` guardado fuera de esa maquina.

---

## 5. Cierre: dar de baja VSCode Ports

Se hace **despues** de que la etapa 2 cierre en verde y picking este entrando
por el Linux. Antes no: mientras picking apunte al tunel, apagarlo corta los
pedidos.

1. Confirmar que la app de picking ya **no** tiene ninguna URL del tunel
   configurada (ver `docs/contrato-app-de-picking.md`, seccion 7).
2. Cerrar el port forwarding en VSCode y cerrar la sesion que lo sostiene.
3. Verificar **desde fuera de la LAN** que la notebook ya no contesta:

   ```bash
   curl -sS --max-time 5 https://<la-url-vieja-del-tunel>/health
   ```

   Tiene que fallar por conexion, no responder.

4. Verificar que **desde la LAN** sigue contestando: la tablet opera
   normalmente.
5. Confirmar que nadie configuro un port forwarding en el router "por las
   dudas". El agente no necesita ninguno: todo el trafico del enlace lo inicia
   el.

Desde aca la sucursal no expone ningun puerto a internet y el unico componente
expuesto es el servidor Linux, con TLS y sin endpoints anonimos.

---

## 6. Anexo: verificaciones de un vistazo

```powershell
# Agente: estado profundo (mode, link, devices, robots, lastCompletedOrder)
Invoke-RestMethod http://<ip-de-lan>:3000/health | ConvertTo-Json -Depth 5

# Agente: zona de pickeo, para comparar con la estanteria real
Invoke-RestMethod http://<ip-de-lan>:3000/api/slots | ConvertTo-Json -Depth 5

# Agente: el log del ciclo de vida y de cada orden
Get-Content C:\aoki-one\logs\agente.log -Wait -Tail 20
```

```bash
# Servidor: estado y presencia de cada sucursal
curl -s https://pedidos.midominio.com/health | jq

# Servidor: seguir UN pedido de punta a punta
journalctl -u aoki-one-server -o cat | jq 'select(.correlacion.externalOrderId == "47")'

# Servidor: lo primero que se mira cuando una sucursal deja de reportar
journalctl -u aoki-one-server -o cat | jq 'select(.evento == "AUTH_REJECTED")'
```

| Sintoma                                        | Primero se mira                           | Suele ser                                                                    |
| ---------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| La tablet no responde                          | `/health` desde la notebook               | el bind (`AOKI_AGENT_HTTP_BIND`) o el firewall de Windows                     |
| El robot no se mueve pero la API contesta OK   | `PLC_SIMULATED` en el log                 | `AOKI_AGENT_SIMULAR_PLC` quedo en `true`                                      |
| La sucursal deja de reportar                   | `AUTH_REJECTED` en el servidor            | secreto desactualizado tras una rotacion, o el reloj de la notebook corrido   |
| `/health` dice `DEGRADED` y el outbox crece    | la URL del servidor en el log del agente  | DNS, proxy o el Linux caido. **El robot sigue trabajando**: no es urgencia de planta |
| Picking recibe 401                             | `AUTH_REJECTED` con su `keyId`            | firma sobre el body reserializado, o timestamp fuera de la ventana de 5 min   |

---

## 7. Referencias

- `deploy/README.md` — despliegue del servidor de pedidos y emision de credenciales.
- `deploy/README-agente.md` — despliegue del agente en la notebook de la sucursal.
- `docs/contrato-app-de-picking.md` — lo que tiene que implementar la app de picking.
- `packages/agent/src/migracion/` — el script de migracion y sus motivos de omision.
- `docs/specs/2026-09-17-rewrite-ts-domain-agent.md` — la spec de Fase 1.
