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
const { createOrdersRoutes } = require("./interfaces/api/ordersRoutes");
const { createDevicesRoutes } = require("./interfaces/api/devicesRoutes");

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
  const stateManager = options.stateManager || new StateManager();
  const errorHandler = options.errorHandler || new ErrorHandler({ logger });
  const deviceRegistry = options.deviceRegistry || new DeviceRegistry();
  const eventStore = options.eventStore || new FileEventStore();
  const snapshotStore = options.snapshotStore || new SnapshotStore();

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
