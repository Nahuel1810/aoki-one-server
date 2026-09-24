# Despliegue del servidor de pedidos

El servidor de pedidos corre en un Linux propio y es el **unico componente de
Aoki One expuesto a internet**. Recibe los pedidos de la app de picking firmados
con HMAC, mantiene la cola durable y se la entrega al agente de cada sucursal por
long-poll saliente. El agente **nunca** recibe conexiones entrantes: todo lo
inicia el.

Esta guia alcanza para levantarlo de cero.

---

## 0. Antes de empezar: las tres cosas que se olvidan

1. **La clave de cifrado de credenciales no se puede recuperar.**
   `AOKI_SERVER_CLAVE_DE_CREDENCIALES` es la clave maestra con la que se cifran
   los secretos de TODAS las sucursales. Si se pierde (se reinstala el server, se
   borra `/etc/aoki-one/servidor.env`, se genera una nueva "por las dudas"), los
   secretos guardados quedan ilegibles: hay que **reemitir la credencial de cada
   sucursal y reconfigurar cada agente**. Guardarla en el gestor de secretos
   **antes** del primer arranque.
2. **El puerto del servidor no va abierto al mundo.** El proceso escucha en
   `127.0.0.1` por defecto y **no termina TLS**. Quien publica el servicio es el
   reverse proxy (paso 5). Un firewall que abra 8080 hacia afuera publica HTTP
   plano: los pedidos y las firmas viajarian en claro.
3. **Un backup de la base sin la clave no sirve para autenticar, y la clave sin
   la base tampoco.** Estan separadas a proposito: filtrar una sola no alcanza
   para hacerse pasar por una sucursal. Las dos hay que respaldarlas, y **no en
   el mismo lugar**.

---

## 1. Sistema

Probado sobre Debian/Ubuntu con systemd.

```bash
# Node 22 LTS o superior (el proyecto compila a ES2023 y usa ESM nodenext).
node --version

# better-sqlite3 trae binarios precompilados, pero si el sistema no coincide se
# compila en el momento y hace falta el toolchain.
sudo apt install -y build-essential python3
```

Usuario y directorios:

```bash
sudo useradd --system --home /opt/aoki-one --shell /usr/sbin/nologin aoki
sudo install -d -o aoki -g aoki /opt/aoki-one
sudo install -d -o aoki -g aoki -m 0750 /var/lib/aoki-one
```

`/var/lib/aoki-one` es el unico directorio donde la unidad puede escribir
(`ReadWritePaths` en el `.service`). La base tiene que vivir ahi.

---

## 2. Codigo y build

```bash
sudo -u aoki git clone <repo> /opt/aoki-one
cd /opt/aoki-one
sudo -u aoki npm ci --ignore-scripts
sudo -u aoki npm rebuild better-sqlite3
sudo -u aoki npm run build
```

`--ignore-scripts` no es opcional: el `postinstall` del repo raiz entra a
`packages/web` e instala el front, que en este Linux no corre. Por eso despues
hace falta el `npm rebuild better-sqlite3` explicito, que es el unico paquete que
si necesita su script de instalacion.

El build deja el entry point en `packages/server/dist/index.js`, que es lo que
ejecuta la unidad.

> Alternativa recomendada para produccion: compilar en CI y copiar al servidor
> `packages/{domain,server}/dist`, los `package.json` y el `node_modules` de
> produccion. Asi el Linux expuesto no necesita toolchain ni el codigo fuente.

---

## 3. Configuracion

```bash
sudo install -d -m 0750 -o root -g aoki /etc/aoki-one
sudo install -m 0640 -o root -g aoki \
  /opt/aoki-one/deploy/servidor.env.example /etc/aoki-one/servidor.env

# Clave maestra, UNA sola vez en la vida del servidor:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
sudo nano /etc/aoki-one/servidor.env   # pegarla en AOKI_SERVER_CLAVE_DE_CREDENCIALES
```

Variables, con sus defaults:

| Variable                            | Default     | Que pasa si falta                                                                              |
| ----------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| `AOKI_SERVER_CLAVE_DE_CREDENCIALES` | —           | **No arranca.** Sin ella no puede verificar ninguna firma.                                       |
| `AOKI_SERVER_RUTA_DE_BASE`          | —           | **No arranca.** No hay default: la base va en el disco de este servidor y nadie mas sabe cual es. |
| `AOKI_SERVER_PUERTO`                | `8080`      | —                                                                                                |
| `AOKI_SERVER_BIND`                  | `127.0.0.1` | —                                                                                                |
| `AOKI_SERVER_RETENCION_DIAS`        | `90`        | —                                                                                                |
| `AOKI_SERVER_PURGA_CADA_MINUTOS`    | `360`       | —                                                                                                |
| `AOKI_SERVER_NIVEL_DE_LOG`          | `INFO`      | —                                                                                                |

El arranque valida **todo** antes de abrir la base o el puerto, y lista de una
sola vez todo lo que hay que corregir. Con la configuracion mal, el proceso sale
con codigo 1 y systemd deja la unidad en `failed` en vez de reintentar para
siempre (`RestartPreventExitStatus=1`).

---

## 4. Servicio

```bash
sudo install -m 0644 /opt/aoki-one/deploy/aoki-one-server.service \
  /etc/systemd/system/aoki-one-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now aoki-one-server
sudo systemctl status aoki-one-server
```

Logs: una linea JSON por evento a stdout, que journald captura. No hay archivo de
log propio ni `logrotate` que configurar.

```bash
journalctl -u aoki-one-server -f
journalctl -u aoki-one-server -o cat | jq 'select(.evento == "PURGE_DONE")'
```

Eventos del ciclo de vida: `SERVER_LISTENING`, `PURGE_DONE`, `PURGE_FAILED`,
`SIGNAL_RECEIVED`, `SERVER_STOPPED`, `CONFIG_INVALID`, `STARTUP_FAILED`. Cada
linea lleva `componente: "servidor"`.

**Eventos por pedido**, cada uno con `correlacion.ordenId` —el id del libro de
este servidor— y `correlacion.externalOrderId`, que es el numero que dice el
operario:

| Evento                | Cuando                                           |
| --------------------- | ------------------------------------------------ |
| `ORDER_INGESTED`      | Alta de la app de picking. `creado: false` = reenvio (RF26). |
| `WORK_LEASED`         | El pedido se entrego a un agente, con su lease.  |
| `TRANSITION_APPLIED`  | La sucursal reporto un cambio de estado y se aplico. |
| `TRANSITION_DISCARDED`| Se descarto: seq repetida, vieja, u orden inexistente. |
| `AUTH_REJECTED`       | Firma, credencial o timestamp que no cierran.    |
| `REQUEST_FAILED`      | Fallo no controlado de un handler.               |

**Seguir un pedido de punta a punta** es filtrar los dos logs por el mismo campo,
que es todo el punto de que las dos mitades escriban con la misma forma:

```bash
journalctl -u aoki-one-server -o cat | jq 'select(.correlacion.externalOrderId == "47")'
```

Y del lado de la sucursal, sobre el log del agente (ver `deploy/README-agente.md`).
Las lineas del agente llevan ademas `correlacion.ordenIdLocal`, el id de su propio
libro, que aca no existe y por eso sale en `null`.

Para mirar el estado guardado, en vez del rastro:

```bash
sqlite3 /var/lib/aoki-one/servidor.db \
  "SELECT id, estado, creada_en, finalizada_en FROM orders WHERE external_order_id = '47'"
```

**Cuando una sucursal deja de reportar**, lo primero es `AUTH_REJECTED`: sin esa
linea, un secreto desactualizado despues de una rotacion se ve exactamente igual
que una notebook apagada.

```bash
journalctl -u aoki-one-server -o cat | jq 'select(.evento == "AUTH_REJECTED")'
```

**Retencion y purga.** El servidor conserva los pedidos **terminados** durante
`AOKI_SERVER_RETENCION_DIAS` y despues los borra junto con sus transiciones y su
lease. Lo que sigue abierto **no se purga nunca**, por viejo que sea: borrarlo
seria perder trabajo pendiente. Las metricas del negocio no viven aca (son del
agente), asi que la purga no borra numeros de nadie. Corre una vez al arrancar y
despues cada `AOKI_SERVER_PURGA_CADA_MINUTOS`.

---

## 5. TLS: va en un reverse proxy, no en el servidor

**El servidor no termina TLS y no deberia.** Las razones:

- El proceso corre como usuario sin privilegios y no puede abrir el 443 ni leer
  `/etc/letsencrypt/live/*/privkey.pem`. Para terminar TLS el mismo habria que
  darle una de las dos cosas, y las dos empeoran la postura del unico componente
  expuesto.
- La renovacion de certificados, el reload sin cortar conexiones, HSTS, los
  limites de cuerpo y el rate limiting ya son problemas resueltos en nginx o
  Caddy. Reimplementarlos adentro del servidor es superficie nueva que hay que
  sostener.
- El dia que haya un segundo servidor (Fase 2), el punto donde termina TLS ya
  esta afuera y no hay que mover nada.

Con nginx:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo install -m 0644 /opt/aoki-one/deploy/nginx/aoki-one-server.conf \
  /etc/nginx/sites-available/aoki-one-server
sudo sed -i 's/pedidos.EJEMPLO.com/pedidos.midominio.com/g' \
  /etc/nginx/sites-available/aoki-one-server
sudo ln -s /etc/nginx/sites-available/aoki-one-server /etc/nginx/sites-enabled/
sudo certbot --nginx -d pedidos.midominio.com
sudo nginx -t && sudo systemctl reload nginx
```

El archivo de ejemplo ya deja resuelto lo que el long-poll necesita:
`proxy_read_timeout` por encima de los 25 s que el servidor retiene la conexion, y
`proxy_buffering off` para que la respuesta salga en el momento en que aparece
trabajo.

Firewall: **solo** 80 y 443 hacia afuera. El 8080 no se abre nunca.

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
```

---

## 6. Emitir la credencial de una sucursal

Cada sucursal firma sus requests con HMAC usando un `keyId` y un secreto. El
secreto se guarda **cifrado** en la base y se muestra **una sola vez**: el
servidor lo necesita para recomputar la firma, pero no hay forma de volver a
mostrarlo sin descifrarlo a mano.

```bash
sudo systemd-run --uid=aoki --pipe --quiet \
  --property=EnvironmentFile=/etc/aoki-one/servidor.env \
  /usr/bin/node /opt/aoki-one/packages/server/dist/herramientas/emitirCredencial.js \
  --site-id SUC-CENTRO
```

`systemd-run` y no `sudo -u aoki` para no tener que exportar la clave a mano ni
dejarla en el historial del shell: toma el mismo `EnvironmentFile` que usa el
servicio.

Imprime:

```
Credencial emitida. El secreto se muestra UNA sola vez:
  AOKI_AGENT_SITE_ID=SUC-CENTRO
  AOKI_AGENT_KEY_ID=6f1c...
  AOKI_AGENT_SECRETO=9a2b...
```

Esas tres lineas son la credencial de esa sucursal. No es un endpoint a
proposito: un endpoint que emite credenciales entrega el material con el que se
firma, y no existe ninguna credencial previa con la que autenticarlo. Quien tiene
shell en este Linux ya tiene la base y la clave.

> **Donde se pegan.** Esas tres lineas van tal cual en el archivo de entorno del
> agente de esa sucursal. El procedimiento completo —con el cutover, que arranca
> con el enlace apagado— esta en `deploy/README-agente.md`, punto 7. El secreto
> se muestra una sola vez: si se pierde antes de pegarlo, hay que rotarlo.

**Rotar** el secreto de una sucursal: el mismo comando con
`--key-id <el existente>`. Reemplaza el secreto, y el agente deja de poder firmar
hasta que se le actualice el entorno, asi que se hace con la sucursal avisada.

---

## 7. Verificacion

```bash
curl -s https://pedidos.midominio.com/health | jq
```

Tiene que responder el estado del servidor y la presencia de cada sucursal. Si
responde por HTTP plano al 8080 desde otra maquina, el bind o el firewall estan
mal.

---

## 8. Backups

```bash
sudo -u aoki sqlite3 /var/lib/aoki-one/servidor.db ".backup '/var/backups/aoki-one/servidor.db'"
```

`.backup` y no `cp`: la base corre en modo WAL y copiar el archivo suelto, sin su
`-wal`, produce un backup a medias.

Y, por separado del backup de la base, el respaldo de
`AOKI_SERVER_CLAVE_DE_CREDENCIALES` en el gestor de secretos. Ver el punto 0.

---

## 9. Actualizar

```bash
cd /opt/aoki-one
sudo -u aoki git pull
sudo -u aoki npm ci --ignore-scripts
sudo -u aoki npm rebuild better-sqlite3
sudo -u aoki npm run build
sudo systemctl restart aoki-one-server
```

El reinicio corta los long-polls abiertos. No se pierde nada: el agente reconecta
con backoff (RF37) y el lease vencido devuelve las ordenes a la cola (RF28). Aun
asi conviene hacerlo fuera del horario de picking.

**Si la base viene de una version anterior a que las credenciales se cifraran**
(tenia `secreto_hash`), el servidor **no arranca** y lo dice: un hash no se puede
convertir en el material del secreto. Hay que reemitir la credencial de cada
sucursal.
