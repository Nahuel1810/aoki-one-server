# feat: endurecer la API local y cerrar los puntos de esquema

## Qué hace

Cierra los cinco puntos de seguridad aprobados de la revisión, agrega el padrón
de clientes con baneo, y resuelve los cuatro puntos de esquema que salieron del
repaso de arquitectura. Nada de esto puede frenar el robot: es el criterio con
el que se eligió cada medida.

## Seguridad

**El alta de dispositivo exige el token de mantenimiento.** `POST
/api/devices/register` era el único endpoint abierto que decide por qué host,
puerto y unitId se le habla al PLC. Escribe una fila, pero decide todos los
registros que se escriben después: quien llegue al puerto del agente reapunta el
Modbus del robot a una máquina suya. Ahora comparte credencial con el comando
directo al PLC.

*Consecuencia operativa*: el token pasa a ser necesario **antes** del alta del
primer dispositivo. Documentado en `deploy/agente.env.example`. Sin token el alta
responde 503 —no 401— porque no falta la credencial: la capacidad no está
habilitada.

**El bind se valida, y no aborta el arranque.** `AOKI_AGENT_HTTP_BIND` era la
única variable sin validar y es la que sostiene todo RF22: no hay login, estar en
la LAN equivale a estar frente a la tablet. `clasificarBind` reparte en
LOOPBACK / LAN_PRIVADA / EXPUESTO, y lo que no reconoce cae en EXPUESTO. Con el
bind abierto grita `API_BIND_EXPUESTO` y **sigue sirviendo**: abortar dejaría al
robot sin trabajar por un dato de configuración, que es peor que la exposición.

**`/health` publica `network: {bind, scope}`**, porque nadie mira la consola de
la notebook.

**El token se compara en tiempo constante.** El `===` cortaba en el primer byte
distinto. El servidor ya usaba `timingSafeEqual`.

**Los eventos que mutan guardan la IP de origen** (liberación manual de slot,
pausa/reanudación de cola).

## El padrón de clientes

Reemplaza el allowlist estático que se había propuesto y descartado.

- **Default permitido.** Cada cliente se anota solo y pasa. Un padrón que exija
  habilitar antes deja al robot parado la primera vez que la tablet cambia de IP,
  y con el robot parado nadie lee documentación.
- **El baneo exige credencial, el listado no.** No es simetría: sin credencial,
  quien quiera parar la planta solo tiene que banear la IP de la tablet.
- **No se puede banear loopback**: sería quedarse afuera de la propia notebook,
  incluido el endpoint de desbaneo.
- **La identidad sale del socket, nunca de `X-Forwarded-For`.** Ese header lo
  escribe quien llama; leerlo volvería el padrón decorativo.
- **Falla abierto.** Si SQLite se cae se loguea y se deja pasar. Va con try/catch
  propio porque better-sqlite3 lanza síncrono: sin eso, el throw se escapaba del
  middleware y la tablet recibía una página HTML de Express con el detalle
  adentro.

Endpoints: `GET /api/clients`, `POST /api/clients/:ip/ban`,
`POST /api/clients/:ip/unban`.

## Esquema

1. **El estado del slot se valida al leer.** Era el único JSON que entraba con un
   cast, y es el dato del accidente. Aterriza en `ERROR`, no en `LIBRE`: un slot
   que no se entiende puede tener un cajón encima.
2. **`robots.orden_activa_id` se suelta en un `finally`.** Resultó más grave que
   "puntero desnormalizado": el ciclo lo mira primero y da al robot por ocupado.
   Sin `finally`, una excepción entre la toma y la suelta dejaba al robot sin
   trabajar hasta el próximo reinicio.
3. **La pragma de foreign keys queda documentada.** Estaba encendida sin ningún
   `REFERENCES`, así que no exigía nada y sugería una integridad inexistente.
4. **Las dos tablas `orders` se documentan en vez de renombrarse** — ver abajo.

## Una propuesta que cambió al implementarla

Había propuesto renombrar las dos tablas `orders`. Al mirarlo de cerca no
conviene: las rutas que las exponen (`/api/orders`, `/api/v1/orders`) son
contrato con la tablet y con la app de picking y no se pueden tocar, así que
renombrar sólo la tabla cambia una confusión por otra. Cada tabla ahora nombra a
su contraparte y la distinción —admisión contra ejecución— donde se lee. Si aun
así se prefiere el renombre, es un cambio contenido: 20 referencias SQL en 7
archivos.

## Testing

468 tests (+24), `tsc -b`, `typecheck` y `eslint` verdes.

Cobertura nueva: los cuatro rangos de bind y el borde 172.15/172.32; el arranque
con bind abierto que avisa **y sigue sirviendo**; el alta de dispositivo sin
token que no deja el dispositivo en la base; las nueve reglas del padrón,
incluida la de `X-Forwarded-For`; el estado de slot ilegible que cae en ERROR; y
la suelta del robot ante una excepción del transporte.

Verificado que muerden: neutralizar la aplicación del baneo, el `finally` y la
validación hace fallar sus tests y ninguno más.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
