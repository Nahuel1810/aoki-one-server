# Despliegue del agente de sucursal

El agente corre en **una notebook dentro de la LAN de la sucursal**, no en un
servidor y no en la nube. Es dueño del lazo de control Modbus contra los PLCs,
expone una API HTTP **solo hacia la LAN** para la tablet del operario, y habla
con el servidor de pedidos por long-poll **saliente**.

Esta guia alcanza para poner una sucursal en marcha de cero.

---

## 0. Antes de empezar: las cuatro cosas que se olvidan

1. **El agente NO expone ningun puerto a internet.** Todo el trafico del enlace
   lo inicia el: el servidor nunca abre una conexion hacia la sucursal. No hay
   que abrir puertos en el router, no hay que pedir una IP fija y no hay que
   publicar nada. Si alguien esta configurando un port forwarding hacia esta
   notebook, esta resolviendo un problema que no existe y abriendo uno que si.
2. **El bind no va en `0.0.0.0`.** Toda la autorizacion del operario se apoya en
   estar en la LAN (RF22): no hay login, y estar en la red de la sucursal
   equivale a estar parado frente a la tablet. Con `0.0.0.0` ese razonamiento se
   cae, porque cualquier otra interfaz de la notebook —el wifi de invitados, una
   VPN, un telefono compartiendo datos— pasa a ser tambien "estar frente a la
   tablet". Se escribe **la IP de LAN**, esa y nada mas.
3. **La notebook no se apaga y no se suspende.** Es el unico proceso que puede
   mover el robot. Suspension, hibernacion y apagado automatico de la placa de
   red: todo desactivado.
4. **El enlace con el servidor arranca APAGADO.** En el cutover la sucursal
   corre primero **sola**, una jornada completa contra el robot real, con su cola
   local. El enlace se enciende despues. Nunca las dos cosas el mismo dia.

---

## 1. La notebook

- Windows 10/11, cuenta local con permiso para instalar un servicio.
- Node 22 LTS o superior (el proyecto compila a ES2023 y usa ESM nodenext).
- IP **fija dentro de la LAN** (reserva por DHCP o estatica). La tablet apunta a
  esa direccion: si cambia, el operario se queda sin API.
- Cableada al switch si se puede. El lazo Modbus contra el PLC por wifi suma
  latencia justo donde se siente.

Directorios:

```powershell
New-Item -ItemType Directory -Force C:\aoki-one\datos
New-Item -ItemType Directory -Force C:\aoki-one\logs
```

---

## 2. Codigo y build

```powershell
git clone <repo> C:\aoki-one\app
cd C:\aoki-one\app
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run build
```

`--ignore-scripts` no es opcional: el `postinstall` del repo raiz entra a
`packages/web` e instala el front. Por eso despues hace falta el
`npm rebuild better-sqlite3` explicito, que es el unico paquete que si necesita
su script de instalacion.

El build deja el entry point en `packages\agent\dist\index.js`.

---

## 3. Configuracion

```powershell
Copy-Item C:\aoki-one\app\deploy\agente.env.example C:\aoki-one\agente.env
notepad C:\aoki-one\agente.env
```

Variables, con sus defaults:

| Variable                            | Default     | Que pasa si falta                                                                                     |
| ----------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `AOKI_AGENT_SITE_ID`                | —           | **No arranca.** Es la sucursal que firma. La emite el servidor con la credencial.                     |
| `AOKI_AGENT_ID`                     | —           | **No arranca.** Identifica a ESTA notebook. Dos agentes con el mismo valor chocan ids en el servidor. |
| `AOKI_AGENT_RUTA_DE_BASE`           | —           | **No arranca.** Sin default: un default relativo crea una base nueva cada vez y pierde la historia.   |
| `AOKI_AGENT_ZONA_DE_PICKEO`         | —           | **No arranca.** Sin slots no se puede ejecutar un solo PICK.                                          |
| `AOKI_AGENT_HTTP_PUERTO`            | `3000`      | —                                                                                                     |
| `AOKI_AGENT_HTTP_BIND`              | `127.0.0.1` | Loopback: la tablet **no** llega. Se escribe la IP de LAN (ver punto 0.2).                            |
| `AOKI_AGENT_MONTAR_API`             | `true`      | —                                                                                                     |
| `AOKI_AGENT_SIMULAR_PLC`            | `false`     | El robot **no** se mueve pero la API contesta OK. En produccion queda en false (RF20).                |
| `AOKI_AGENT_TOKEN_DE_MANTENIMIENTO` | vacio       | Comando directo a PLC **deshabilitado** (RF22). Falla cerrado a proposito.                            |
| `AOKI_AGENT_SERVIDOR_URL`           | vacio       | Enlace **apagado**: cola local y nada mas (T26).                                                      |
| `AOKI_AGENT_KEY_ID`                 | vacio       | idem.                                                                                                 |
| `AOKI_AGENT_SECRETO`                | vacio       | idem.                                                                                                 |
| `AOKI_AGENT_RETENCION_EVENTOS_DIAS` | `30`        | —                                                                                                     |
| `AOKI_AGENT_RETENCION_PASOS_DIAS`   | `14`        | —                                                                                                     |
| `AOKI_AGENT_PURGA_CADA_MINUTOS`     | `60`        | —                                                                                                     |
| `AOKI_AGENT_NIVEL_DE_LOG`           | `INFO`      | —                                                                                                     |

El arranque valida **todo** antes de abrir la base o el puerto, y lista de una
sola vez todo lo que hay que corregir: quien esta poniendo la notebook en marcha
esta parado en la sucursal y no puede descubrir la siguiente variable rota recien
en el proximo reinicio. Con la configuracion mal, el proceso escribe una linea
`CONFIG_INVALID` por variable y sale con codigo 1.

**Los tres defaults que fallan cerrados** —simulacion apagada, comando directo
deshabilitado, enlace apagado— dejan constancia en el log al arrancar
(`PLC_SIMULATED`, `MAINTENANCE_COMMAND_DISABLED`, `LINK_DISABLED`). Es a
proposito: un default que falla cerrado sin decirlo se ve en planta como "no anda
y no se por que".

---

## 4. Migrar la base del robot viejo

Solo la primera vez, y **antes** de arrancar el agente nuevo. Por defecto
**simula**: escribir exige `--aplicar` escrito a mano.

```powershell
node C:\aoki-one\app\packages\agent\dist\migracion\cli.js `
  --origen C:\ruta\a\persistence.db `
  --destino C:\aoki-one\datos\agente.db `
  --site-id SUC-CENTRO

# Si el reporte de la simulacion cierra, recien ahi:
node ... --aplicar
```

Correr dos veces es seguro: lo ya migrado no se duplica ni se pisa. Si la base
vieja esta en uso y tiene `-wal`, conviene migrar desde una copia.

---

## 5. Servicio de Windows

El agente tiene que arrancar solo al prender la maquina, sin que nadie inicie
sesion. Con [nssm](https://nssm.cc):

```powershell
nssm install AokiOneAgente "C:\Program Files\nodejs\node.exe" "C:\aoki-one\app\packages\agent\dist\index.js"
nssm set AokiOneAgente AppDirectory C:\aoki-one\app
nssm set AokiOneAgente AppStdout C:\aoki-one\logs\agente.log
nssm set AokiOneAgente AppStderr C:\aoki-one\logs\agente.log
nssm set AokiOneAgente AppRotateFiles 1
nssm set AokiOneAgente AppEnvironmentExtra (Get-Content C:\aoki-one\agente.env | Where-Object { $_ -and $_ -notmatch '^#' })
nssm start AokiOneAgente
```

El agente **no** escribe un archivo de log propio: emite una linea JSON por
evento a stdout y quien corre el proceso decide donde va esa salida. Asi no hay
dos mecanismos de rotacion peleando por el mismo archivo.

```powershell
Get-Content C:\aoki-one\logs\agente.log -Wait -Tail 20
```

Eventos del ciclo de vida: `AGENT_STARTED`, `AGENT_LISTENING`,
`AGENT_API_DISABLED`, `LINK_DISABLED`, `PLC_SIMULATED`,
`MAINTENANCE_COMMAND_DISABLED`, `SIGNAL_RECEIVED`, `AGENT_STOPPED`,
`CONFIG_INVALID`, `STARTUP_FAILED`. Cada linea lleva `componente: "agente"`.

**El secreto del enlace nunca sale en el log.** La URL del servidor si: es lo que
se mira cuando la sucursal deja de reportar y hay un proxy o un DNS de por medio.

---

## 6. Verificacion, con el enlace todavia apagado

```powershell
Invoke-RestMethod http://<ip-de-lan>:3000/health | ConvertTo-Json -Depth 5
```

Y desde la tablet, la misma URL. Si contesta en la notebook y no en la tablet, el
que esta mal es el bind (punto 0.2) o el firewall de Windows.

Esta es la jornada del cutover: la sucursal opera **sola**, contra el robot real,
con su cola local. El enlace se enciende recien al dia siguiente.

---

## 7. Encender el enlace con el servidor

Del lado del servidor se emite la credencial de esta sucursal (ver
`deploy/README.md`, punto 6):

```bash
sudo systemd-run --uid=aoki --pipe --quiet \
  --property=EnvironmentFile=/etc/aoki-one/servidor.env \
  /usr/bin/node /opt/aoki-one/packages/server/dist/herramientas/emitirCredencial.js \
  --site-id SUC-CENTRO
```

Imprime, **una sola vez**:

```
Credencial emitida. El secreto se muestra UNA sola vez:
  AOKI_AGENT_SITE_ID=SUC-CENTRO
  AOKI_AGENT_KEY_ID=6f1c...
  AOKI_AGENT_SECRETO=9a2b...
```

Esas tres lineas se pegan **tal cual** en `C:\aoki-one\agente.env`, y se le suma
la URL publica del servidor:

```ini
AOKI_AGENT_SITE_ID=SUC-CENTRO
AOKI_AGENT_KEY_ID=6f1c...
AOKI_AGENT_SECRETO=9a2b...
AOKI_AGENT_SERVIDOR_URL=https://pedidos.midominio.com
```

Despues, reiniciar el servicio:

```powershell
nssm restart AokiOneAgente
```

Cosas a saber:

- **Las tres variables del enlace van juntas o no va ninguna.** Una URL sin
  secreto **no arranca**: es un despliegue a medio terminar, y degradarlo a
  "enlace apagado" dejaria una sucursal que parece andar y no reporta nada.
- El secreto **no viaja** en ninguna request: el agente manda `keyId`, timestamp
  y una firma HMAC, y el servidor recomputa la firma con el secreto que tiene
  guardado.
- **El reloj de la notebook tiene que estar en hora.** La firma lleva timestamp y
  la ventana anti-replay es de 5 minutos: un reloj corrido se ve como `401` en
  todas las requests. Dejar activada la sincronizacion horaria de Windows.
- Si se **rota** el secreto en el servidor, el agente deja de poder firmar hasta
  que se le actualice el entorno. Se hace con la sucursal avisada.

Para verificar el cruce, con el mismo `externalOrderId` a los dos lados:

```powershell
Select-String -Path C:\aoki-one\logs\agente.log -Pattern '"externalOrderId":"47"'
```

```bash
journalctl -u aoki-one-server -o cat | jq 'select(.correlacion.externalOrderId == "47")'
```

Las dos mitades llevan el mismo `correlacion.ordenId`, que es el id del libro del
servidor. Es con eso que se sigue un pedido desde el alta hasta el comando que
salio al PLC.

---

## 8. Backups

```powershell
sqlite3 C:\aoki-one\datos\agente.db ".backup 'C:\aoki-one\backups\agente.db'"
```

`.backup` y no `Copy-Item`: la base corre en modo WAL y copiar el archivo suelto,
sin su `-wal`, produce un backup a medias.

La base del agente tiene las metricas del negocio, que **no** viven en el
servidor. Conviene sacarla a un disco que no sea el de la notebook.

---

## 9. Actualizar

```powershell
cd C:\aoki-one\app
git pull
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run build
nssm restart AokiOneAgente
```

El reinicio corta la maniobra en curso. Al volver, el agente **reconcilia antes
de pedir trabajo nuevo** (RF15): una orden que quedo en IN_PROGRESS se resuelve
primero, porque el ciclo del robot solo toma PENDING y si no quedaria huerfana
con el robot ocupado para siempre. Aun asi conviene actualizar fuera del horario
de picking.
