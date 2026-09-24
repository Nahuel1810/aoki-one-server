# Imagen del SERVIDOR DE PEDIDOS (packages/server).
#
# El agente NO va acá: corre en la notebook de la sucursal porque es el único
# lugar desde donde se llega a los PLC por Modbus TCP. Esta imagen no lleva
# `packages/agent` ni `packages/web`.
#
# Dos etapas: la de build necesita el toolchain de C para `better-sqlite3`; la de
# runtime no, y no lo lleva.

# ---------------------------------------------------------------- build
# La MISMA imagen base en las dos etapas, y no una Alpine para runtime: el
# binario nativo de better-sqlite3 se compila contra la libc de la etapa de
# build. glibc (bookworm) y musl (alpine) no son intercambiables, y el síntoma
# es un "invalid ELF header" al arrancar, no un error de build.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# El toolchain sólo por si el prebuild de better-sqlite3 no coincide con la
# plataforma. Cuando coincide, no se usa; cuando no, sin esto el build falla acá
# —que es donde hay que enterarse— y no en producción.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

# Primero SOLO los manifiestos, para que la capa de dependencias se cachee y no
# se reinstale con cada cambio de código. Van los tres package.json de los
# workspaces aunque el agente no se despliegue: sin su manifiesto `npm ci` no
# puede resolver el workspace y falla.
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/agent/package.json packages/agent/
COPY packages/server/package.json packages/server/

# --ignore-scripts: el `postinstall` de la raíz instala el frontend
# (`cd packages/web && npm install`), que en esta imagen no existe ni hace falta.
# Como ese flag también saltea el script de instalación de better-sqlite3, el
# rebuild explícito es obligatorio: es el único paquete que lo necesita.
RUN npm ci --ignore-scripts \
  && npm rebuild better-sqlite3

COPY tsconfig.base.json tsconfig.json ./
COPY packages/domain packages/domain
COPY packages/server packages/server

# Sólo el proyecto del servidor. `tsc -b` arrastra `domain` por las project
# references, y así no hace falta compilar el agente —que no va en esta imagen—
# ni tener sus fuentes.
RUN npx tsc -b packages/server

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Sin toolchain: en runtime no se compila nada. Lo que viaja es el binario ya
# construido arriba.
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/domain/package.json packages/domain/package.json
COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/packages/server/package.json packages/server/package.json
COPY --from=build /app/packages/server/dist packages/server/dist

# La base vive en un volumen, no en la imagen. El directorio se crea acá y se le
# da al usuario `node` para poder correr sin root.
RUN mkdir -p /datos && chown -R node:node /datos
VOLUME ["/datos"]

USER node

# 0.0.0.0 DENTRO del contenedor, y no es una contradicción con el default de
# 127.0.0.1 del servidor.
#
# Ese default protege a un proceso que corre suelto en una máquina: ahí escuchar
# en todas las interfaces expone el puerto a la red. Dentro de un contenedor la
# frontera es otra: la red del contenedor está aislada, y quién llega desde
# afuera lo decide el `ports:` del compose y el proxy que tengas adelante. Con
# 127.0.0.1 el proceso sólo se escucharía a sí mismo y ni siquiera el healthcheck
# llegaría.
ENV AOKI_SERVER_BIND=0.0.0.0
ENV AOKI_SERVER_PUERTO=8080
ENV AOKI_SERVER_RUTA_DE_BASE=/datos/pedidos.db

EXPOSE 8080

# Sin shell de por medio: node queda como PID 1 y recibe el SIGTERM de
# `docker stop` directo. Con la forma shell lo recibiría /bin/sh, el proceso no
# se enteraría y Docker lo mataría a los 10 s con la base a medio cerrar.
CMD ["node", "packages/server/dist/index.js"]
