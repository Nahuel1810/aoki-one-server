const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yamljs");
const swaggerUi = require("swagger-ui-express");
const { QueueManager } = require("./core/queue/QueueManager");
const { ExternalQueueManager } = require("./core/queue/ExternalQueueManager");
const { StateManager } = require("./core/state/StateManager");
const { ErrorHandler } = require("./core/errors/ErrorHandler");
const { DeviceRegistry } = require("./core/connection/DeviceRegistry");
const { ConnectionService } = require("./core/connection/ConnectionService");
const { OrchestratorService } = require("./core/orchestrator/OrchestratorService");
const { FileEventStore } = require("./infra/persistence/FileEventStore");
const { SnapshotStore } = require("./infra/persistence/SnapshotStore");
const { SqliteEventStore } = require("./infra/persistence/SqliteEventStore");
const { SqliteSnapshotStore } = require("./infra/persistence/SqliteSnapshotStore");
const { resolvePickSlotsConfig } = require("./config/pickSlots");
const { createOrdersRoutes } = require("./interfaces/api/ordersRoutes");
const { createDevicesRoutes } = require("./interfaces/api/devicesRoutes");
const { createSlotsRoutes } = require("./interfaces/api/slotsRoutes");

function createApp(options = {}) {
  const app = express();
  let openApiDocument = null;

  try {
    const openApiPath = path.join(__dirname, "../docs/openapi.yaml");
    openApiDocument = YAML.load(openApiPath);
  } catch (error) {
    (options.logger || console).warn?.("[docs] openapi spec unavailable", {
      error: error.message,
    });
  }

  if (options.enableJson !== false) {
    app.use(express.json());
  }

  const webDir = path.join(__dirname, "../public-dist");
  const webIndex = path.join(webDir, "index.html");
  const hasWebBuild = options.enableStatic !== false && fs.existsSync(webIndex);

  if (options.enableStatic !== false) {
    // Front nuevo (packages/web). Build estatico: lo sirve este mismo proceso,
    // sin agregar un segundo servidor en la PC de la sucursal.
    if (hasWebBuild) {
      app.use(express.static(webDir));
    } else {
      (options.logger || console).warn?.(
        "[web] No hay build del front en public-dist. Ejecutar: npm run build:web"
      );
    }

    // Front anterior, accesible durante la validacion del nuevo.
    // Se retira cuando el front nuevo pase una jornada contra el robot real.
    const legacyDir = path.join(__dirname, "../public");
    if (fs.existsSync(legacyDir)) {
      app.use("/legacy", express.static(legacyDir));
      app.get("/legacy/metricas", (req, res) => {
        res.sendFile(path.join(legacyDir, "metricas.html"));
      });
    }
  }

  const logger = options.logger || console;

  let queueManager = options.queueManager;
  if (!queueManager) {
    const queueDriver = String(options.queueDriver || process.env.QUEUE_DRIVER || "memory").toLowerCase();
    if (queueDriver === "external") {
      const externalQueueUrl = options.externalQueueUrl || process.env.EXTERNAL_QUEUE_URL;
      if (!externalQueueUrl) {
        throw new Error("[app] QUEUE_DRIVER=external requiere EXTERNAL_QUEUE_URL");
      }
      queueManager = new ExternalQueueManager({ baseUrl: externalQueueUrl, logger });
      logger.info?.("[app] queue driver: external", { url: externalQueueUrl });
    } else {
      queueManager = new QueueManager();
      logger.info?.("[app] queue driver: memory");
    }
  }

  const pickSlots = resolvePickSlotsConfig(options);
  const stateManager = options.stateManager || new StateManager({ pickSlots });
  const errorHandler = options.errorHandler || new ErrorHandler({ logger });
  const deviceRegistry = options.deviceRegistry || new DeviceRegistry();
  const persistenceDriver = String(
    options.persistenceDriver || process.env.PERSISTENCE_DRIVER || "sqlite"
  ).toLowerCase();

  let eventStore = options.eventStore;
  let snapshotStore = options.snapshotStore;

  if (!eventStore || !snapshotStore) {
    if (persistenceDriver === "sqlite") {
      try {
        const sqliteOptions = { dbPath: options.sqliteDbPath || process.env.SQLITE_DB_PATH };
        eventStore = eventStore || new SqliteEventStore(sqliteOptions);
        snapshotStore = snapshotStore || new SqliteSnapshotStore(sqliteOptions);
      } catch (error) {
        logger.warn?.(
          `[persistence] sqlite unavailable (${error.message}). Falling back to file stores.`
        );
      }
    }

    eventStore = eventStore || new FileEventStore();
    snapshotStore = snapshotStore || new SnapshotStore();
  }

  const simulatePlc =
    typeof options.simulatePlc === "boolean"
      ? options.simulatePlc
      : String(process.env.SIMULATE_PLC || "true").toLowerCase() === "true";

  logger.info?.("[app] boot config", {
    mode: simulatePlc ? "simulation" : "modbus",
    persistenceDriver,
    pickSlotsCount: pickSlots.length,
  });

  const connectionService =
    options.connectionService ||
    new ConnectionService({
      logger,
      deviceRegistry,
      stateManager,
      simulate: simulatePlc,
    });

  const orchestrator =
    options.orchestrator ||
    new OrchestratorService({
      logger,
      queueManager,
      stateManager,
      connectionService,
      errorHandler,
      eventStore,
      snapshotStore,
      config: options.orchestratorConfig,
      pickSlots,
    });

  const services = {
    logger,
    queueManager,
    stateManager,
    errorHandler,
    deviceRegistry,
    connectionService,
    orchestrator,
    snapshotStore,
    eventStore,
  };

  if (typeof connectionService.setMonitorPriorityResolver === "function") {
    connectionService.setMonitorPriorityResolver((robotId) => orchestrator.isRobotProcessing(robotId));
  }

  logger.info?.("[app] services ready", {
    apiEnabled: options.enableApi !== false,
    staticEnabled: options.enableStatic !== false,
    jsonEnabled: options.enableJson !== false,
  });

  if (options.enableApi !== false) {
    app.use("/api/orders", createOrdersRoutes(services));
    app.use("/api/devices", createDevicesRoutes(services));
    app.use("/api/slots", createSlotsRoutes(services));
  }

  if (openApiDocument) {
    app.get("/api-docs.json", (req, res) => {
      res.json(openApiDocument);
    });

    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }

  if (typeof options.configureApp === "function") {
    options.configureApp(app, services);
  }

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: "aoki-one-server",
      ts: Date.now(),
      mode: connectionService.simulate ? "simulation" : "modbus",
    });
  });

  // El front usa rutas del navegador (/dispositivos, /metricas): cualquier GET
  // que no sea de la API ni un archivo existente devuelve el index de la SPA.
  // Va al final, despues de montar /api, /health y /api-docs.
  if (hasWebBuild) {
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        next();
        return;
      }

      if (/^\/(api|health|api-docs|legacy)(\/|$)/.test(req.path)) {
        next();
        return;
      }

      res.sendFile(webIndex);
    });
  }

  return {
    app,
    services,
  };
}

module.exports = {
  createApp,
};
