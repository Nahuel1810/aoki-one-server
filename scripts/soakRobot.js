/**
 * Soak test / keep-alive del robot.
 *
 * Mantiene el robot en movimiento cuando no hay pedidos reales, para poder
 * validar la parte mecanica durante horas sin depender del volumen de picking.
 *
 * Reglas:
 *  - Los pedidos reales tienen prioridad absoluta. El script SOLO inyecta
 *    cuando el robot esta IDLE, la cola vacia y sin orden activa, y ademas
 *    lleva IDLE_MS quieto.
 *  - Cada ciclo es PICK + PUT: trae un cajon a la zona de pickeo y lo devuelve
 *    a su ubicacion original. Si solo hiciera PICK llenaria los slots y
 *    bloquearia los pedidos reales.
 *  - La devolucion espera a que el robot vuelva a estar libre, asi un pedido
 *    real que llego en el medio pasa antes.
 *  - Ante un error NO reintenta: hace falta que una persona saque el cajon.
 *    Avisa y queda esperando; cuando el robot vuelve a IDLE retoma.
 *
 * Uso:
 *   node scripts/soakRobot.js                  # corre indefinidamente
 *   node scripts/soakRobot.js --dry-run        # muestra el pool y sale
 *   node scripts/soakRobot.js --once           # un solo ciclo y sale
 *
 * Config por variables de entorno (defaults entre parentesis):
 *   SOAK_BASE_URL       (http://127.0.0.1:3000)  API del servidor
 *   SOAK_ROBOT_ID       (1)                      robot a ejercitar
 *   SOAK_IDLE_MS        (60000)                  quieto tanto tiempo -> inyecta
 *   SOAK_POLL_MS        (3000)                   cada cuanto consulta estado
 *   SOAK_ESTANTERIA     (3X)                     prefijo de estanteria
 *   SOAK_MODULES        (03-10)                  rango de modulos de origen
 *   SOAK_LEVELS         (A-H)                    rango de niveles (tope duro: H)
 *   SOAK_POSITIONS      (1-3)                    rango de posiciones
 *   SOAK_EXCLUDE        ()                       ubicaciones a excluir (coma)
 *   SOAK_ORDER_TIMEOUT_MS (600000)               techo de espera por orden
 */

const { parseLocationCode } = require("../src/core/orchestrator/locationTranslator");
const { resolvePickSlotsConfig } = require("../src/config/pickSlots");

// El pedido fue explicito: por ahora no subir mas alto que el nivel I.
// El tope se aplica aunque SOAK_LEVELS pida mas.
const MAX_LEVEL_LETTER = "H";

const config = {
  baseUrl: (process.env.SOAK_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, ""),
  robotId: String(process.env.SOAK_ROBOT_ID || "1"),
  idleMs: Number(process.env.SOAK_IDLE_MS || 60000),
  pollMs: Number(process.env.SOAK_POLL_MS || 3000),
  estanteria: String(process.env.SOAK_ESTANTERIA || "3X").toUpperCase(),
  modules: process.env.SOAK_MODULES || "03-10",
  levels: process.env.SOAK_LEVELS || "A-H",
  positions: process.env.SOAK_POSITIONS || "1-3",
  exclude: String(process.env.SOAK_EXCLUDE || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean),
  orderTimeoutMs: Number(process.env.SOAK_ORDER_TIMEOUT_MS || 600000),
};

const flags = {
  dryRun: process.argv.includes("--dry-run"),
  once: process.argv.includes("--once"),
};

const stats = {
  startedAt: Date.now(),
  cyclesOk: 0,
  cyclesFailed: 0,
  logicalPicks: 0,
  blacklisted: [],
};

let stopping = false;

// ── Utilidades ────────────────────────────────────────────────────

function log(level, message, meta) {
  const ts = new Date().toISOString();
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${ts}] [soak] [${level}] ${message}${suffix}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumericRange(spec, label) {
  const match = String(spec).match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    const single = Number(spec);
    if (Number.isInteger(single)) {
      return [single];
    }
    throw new Error(`${label} invalido: "${spec}". Usar "N" o "N-M"`);
  }

  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from > to) {
    throw new Error(`${label} invalido: "${spec}". El inicio es mayor que el fin`);
  }

  const values = [];
  for (let value = from; value <= to; value += 1) {
    values.push(value);
  }
  return values;
}

function parseLetterRange(spec, label) {
  const normalized = String(spec).toUpperCase().replace(/\s/g, "");
  const match = normalized.match(/^([A-Z])(?:-([A-Z]))?$/);
  if (!match) {
    throw new Error(`${label} invalido: "${spec}". Usar "A" o "A-H"`);
  }

  const from = match[1].charCodeAt(0);
  const to = (match[2] || match[1]).charCodeAt(0);
  if (from > to) {
    throw new Error(`${label} invalido: "${spec}". El inicio es mayor que el fin`);
  }

  const letters = [];
  for (let code = from; code <= to; code += 1) {
    letters.push(String.fromCharCode(code));
  }
  return letters;
}

// ── Pool de ubicaciones ───────────────────────────────────────────

function buildLocationPool() {
  const modules = parseNumericRange(config.modules, "SOAK_MODULES");
  const positions = parseNumericRange(config.positions, "SOAK_POSITIONS");
  const requestedLevels = parseLetterRange(config.levels, "SOAK_LEVELS");

  const cap = MAX_LEVEL_LETTER.charCodeAt(0);
  const levels = requestedLevels.filter((letter) => letter.charCodeAt(0) <= cap);
  const dropped = requestedLevels.filter((letter) => letter.charCodeAt(0) > cap);
  if (dropped.length > 0) {
    log("warn", `niveles por encima del tope ${MAX_LEVEL_LETTER} descartados`, { dropped });
  }

  if (levels.length === 0) {
    throw new Error(`SOAK_LEVELS no dejo ningun nivel valido (tope ${MAX_LEVEL_LETTER})`);
  }

  // Los slots de pickeo son destino, nunca origen.
  const pickSlots = new Set(resolvePickSlotsConfig({}));
  const excluded = new Set(config.exclude);
  const pool = [];

  for (const moduleNumber of modules) {
    for (const level of levels) {
      for (const position of positions) {
        const code = `${config.estanteria}${String(moduleNumber).padStart(2, "0")}A${level}${position}`;

        if (pickSlots.has(code) || excluded.has(code)) {
          continue;
        }

        try {
          // Valida contra la misma gramatica que usa el servidor.
          parseLocationCode(code);
        } catch (error) {
          log("warn", "ubicacion generada invalida, se omite", { code, error: error.message });
          continue;
        }

        pool.push(code);
      }
    }
  }

  if (pool.length === 0) {
    throw new Error("El pool de ubicaciones quedo vacio. Revisar SOAK_MODULES/LEVELS/POSITIONS");
  }

  return pool;
}

function pickRandom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Cliente HTTP ──────────────────────────────────────────────────

async function request(method, path, body) {
  const url = `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    throw new Error(`${method} ${path} -> ${payload.error || `HTTP ${res.status}`}`);
  }

  return payload.data;
}

async function getQueueState() {
  const snapshot = await request("GET", "/api/orders/queue/status");
  const entry = (snapshot || []).find((item) => String(item.robotId) === config.robotId);

  return {
    activeOrderId: entry?.activeOrderId || null,
    queueLength: Number(entry?.queueLength || 0),
    paused: entry?.paused === true,
  };
}

async function getRobotStatus() {
  const robots = await request("GET", "/api/devices/robots");
  const robot = (robots || []).find((item) => String(item.id) === config.robotId);
  if (!robot) {
    return { status: "UNKNOWN", enabled: false, found: false };
  }

  return { status: robot.status, enabled: robot.enabled !== false, found: true };
}

/** El robot esta libre para trabajo inyectado (sin pedidos reales en juego). */
async function readIdleState() {
  const [queue, robot] = await Promise.all([getQueueState(), getRobotStatus()]);

  return {
    idle:
      robot.found &&
      robot.enabled &&
      robot.status === "IDLE" &&
      !queue.activeOrderId &&
      queue.queueLength === 0 &&
      !queue.paused,
    queue,
    robot,
  };
}

async function submitOrder(payload) {
  // Sin `id`: el externalOrderId es el espacio de la app de picking y no hay
  // que pisarlo desde aca.
  return request("POST", "/api/orders", { ...payload, origin: "MANUAL" });
}

async function waitForOrder(orderId) {
  const deadline = Date.now() + config.orderTimeoutMs;

  while (Date.now() < deadline) {
    if (stopping) {
      return { status: "ABORTED" };
    }

    const order = await request("GET", `/api/orders/${orderId}`);
    if (["DONE", "ERROR", "CANCELED"].includes(order.status)) {
      return order;
    }

    await sleep(config.pollMs);
  }

  throw new Error(`Timeout esperando la orden ${orderId} (${config.orderTimeoutMs} ms)`);
}

/** Espera a que el robot quede libre. Devuelve false si hay que abortar. */
async function waitUntilIdle({ requireDwell }) {
  let idleSince = null;

  while (!stopping) {
    const state = await readIdleState();

    if (state.robot.status === "ERROR") {
      return { ok: false, reason: "ROBOT_ERROR" };
    }

    if (!state.idle) {
      if (idleSince !== null) {
        log("info", "llego trabajo real, cediendo el robot");
      }
      idleSince = null;
      await sleep(config.pollMs);
      continue;
    }

    if (!requireDwell) {
      return { ok: true };
    }

    if (idleSince === null) {
      idleSince = Date.now();
    }

    if (Date.now() - idleSince >= config.idleMs) {
      return { ok: true };
    }

    await sleep(config.pollMs);
  }

  return { ok: false, reason: "STOPPING" };
}

// ── Ciclo PICK + PUT ──────────────────────────────────────────────

function isMissingBoxError(order) {
  return /no hay cajon/i.test(String(order?.errorReason || ""));
}

async function runCycle(pool) {
  const sourceLocation = pickRandom(pool);
  log("info", "inyectando PICK manual", { locationCode: sourceLocation });

  const pickOrder = await submitOrder({ type: "PICK", locationCode: sourceLocation });
  const pickResult = await waitForOrder(pickOrder.id);

  if (pickResult.status === "ABORTED") {
    return { ok: false, reason: "STOPPING" };
  }

  if (pickResult.status !== "DONE") {
    log("error", "el PICK no termino bien", {
      orderId: pickOrder.id,
      status: pickResult.status,
      error: pickResult.errorReason,
    });

    if (isMissingBoxError(pickResult)) {
      const index = pool.indexOf(sourceLocation);
      if (index >= 0) {
        pool.splice(index, 1);
        stats.blacklisted.push(sourceLocation);
        log("warn", "ubicacion sin cajon, se saca del pool", {
          locationCode: sourceLocation,
          poolRestante: pool.length,
        });
      }
    }

    return { ok: false, reason: "PICK_FAILED", order: pickResult };
  }

  const slot = pickResult.slotLocationCode;
  if (!slot) {
    log("error", "el PICK termino sin slot asignado, no se puede devolver", {
      orderId: pickOrder.id,
    });
    return { ok: false, reason: "NO_SLOT" };
  }

  if (pickResult.logicalPickOnly) {
    stats.logicalPicks += 1;
    log("info", "PICK logico (el cajon ya estaba en zona); se devuelve igual para no desbalancear", {
      locationCode: sourceLocation,
      slot,
    });
  }

  // La devolucion no es urgente: si entro trabajo real, primero pasa el.
  const ready = await waitUntilIdle({ requireDwell: false });
  if (!ready.ok) {
    log("warn", "no se pudo devolver el cajon ahora", {
      reason: ready.reason,
      slot,
      targetLocation: sourceLocation,
    });
    return { ok: false, reason: ready.reason, pendingReturn: { slot, target: sourceLocation } };
  }

  log("info", "devolviendo cajon", { slot, targetLocation: sourceLocation });

  // targetLocation explicito: hoy el servidor, si no lo recibe, deja el cajon
  // en el mismo slot del que lo levanto.
  const putOrder = await submitOrder({
    type: "PUT",
    locationCode: slot,
    targetLocation: sourceLocation,
  });
  const putResult = await waitForOrder(putOrder.id);

  if (putResult.status === "ABORTED") {
    return { ok: false, reason: "STOPPING" };
  }

  if (putResult.status !== "DONE") {
    log("error", "el PUT no termino bien", {
      orderId: putOrder.id,
      status: putResult.status,
      error: putResult.errorReason,
    });
    return { ok: false, reason: "PUT_FAILED", order: putResult };
  }

  return { ok: true, sourceLocation, slot };
}

// ── Loop principal ────────────────────────────────────────────────

function printStats() {
  const upMs = Date.now() - stats.startedAt;
  log("info", "resumen", {
    uptimeMin: Math.round(upMs / 60000),
    ciclosOk: stats.cyclesOk,
    ciclosFallidos: stats.cyclesFailed,
    picksLogicos: stats.logicalPicks,
    ubicacionesDescartadas: stats.blacklisted,
  });
}

async function main() {
  const pool = buildLocationPool();

  log("info", "configuracion", {
    baseUrl: config.baseUrl,
    robotId: config.robotId,
    idleMs: config.idleMs,
    pollMs: config.pollMs,
    topeNivel: MAX_LEVEL_LETTER,
    ubicaciones: pool.length,
  });

  if (flags.dryRun) {
    log("info", "dry-run: pool de ubicaciones", { pool });
    return;
  }

  while (!stopping) {
    const ready = await waitUntilIdle({ requireDwell: true });

    if (!ready.ok) {
      if (ready.reason === "STOPPING") {
        break;
      }

      if (ready.reason === "ROBOT_ERROR") {
        log(
          "error",
          "robot en ERROR: hace falta que una persona saque el cajon y reintente la orden. " +
            "El script no reintenta solo. Espera a que vuelva a IDLE."
        );
        await sleep(Math.max(config.pollMs, 10000));
      }

      continue;
    }

    log("info", `robot quieto ${Math.round(config.idleMs / 1000)}s, arranca ciclo manual`);

    let result;
    try {
      result = await runCycle(pool);
    } catch (error) {
      stats.cyclesFailed += 1;
      log("error", "ciclo abortado por excepcion", { error: error.message });
      await sleep(Math.max(config.pollMs, 5000));
      continue;
    }

    if (result.ok) {
      stats.cyclesOk += 1;
      log("info", "ciclo completo", {
        origen: result.sourceLocation,
        slot: result.slot,
        total: stats.cyclesOk,
      });
    } else if (result.reason !== "STOPPING") {
      stats.cyclesFailed += 1;

      if (result.pendingReturn) {
        log("warn", "queda un cajon en zona de pickeo sin devolver", result.pendingReturn);
      }

      await sleep(Math.max(config.pollMs, 5000));
    }

    if (flags.once) {
      break;
    }
  }

  printStats();
}

function shutdown(signal) {
  if (stopping) {
    return;
  }

  stopping = true;
  log("info", `${signal} recibido, terminando despues de la operacion en curso`);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log("error", "fallo fatal", { error: error.message });
    printStats();
    process.exit(1);
  });
