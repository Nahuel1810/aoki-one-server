const express = require("express");
const path = require("node:path");
const { QueueManager } = require("./core/queue/QueueManager");
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

  if (options.enableJson !== false) {
    app.use(express.json());
  }

  if (options.enableStatic !== false) {
    app.use(express.static(path.join(__dirname, "../public")));
  }

  const logger = options.logger || console;
  const queueManager = options.queueManager || new QueueManager();
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

  if (options.enableApi !== false) {
    app.use("/api/orders", createOrdersRoutes(services));
    app.use("/api/devices", createDevicesRoutes(services));
    app.use("/api/slots", createSlotsRoutes(services));
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

  return {
    app,
    services,
  };
}

module.exports = {
  createApp,
};
