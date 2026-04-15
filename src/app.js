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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../public")));

  const logger = console;
  const queueManager = new QueueManager();
  const stateManager = new StateManager();
  const errorHandler = new ErrorHandler({ logger });
  const deviceRegistry = new DeviceRegistry();
  const eventStore = new FileEventStore();
  const snapshotStore = new SnapshotStore();
  const connectionService = new ConnectionService({
    logger,
    deviceRegistry,
    stateManager,
    simulate: String(process.env.SIMULATE_PLC || "true").toLowerCase() === "true",
  });

  const orchestrator = new OrchestratorService({
    logger,
    queueManager,
    stateManager,
    connectionService,
    errorHandler,
    eventStore,
    snapshotStore,
  });

  const services = {
    logger,
    queueManager,
    stateManager,
    connectionService,
    orchestrator,
    snapshotStore,
    eventStore,
  };

  app.use("/api/orders", createOrdersRoutes(services));
  app.use("/api/devices", createDevicesRoutes(services));

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
