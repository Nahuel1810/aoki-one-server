const express = require("express");

function normalizeDeviceType(value) {
  const deviceType = String(value || "").trim().toUpperCase();
  if (["CARRO", "ELEVADOR"].includes(deviceType)) {
    return deviceType;
  }

  return null;
}

function createDevicesRoutes(services) {
  const router = express.Router();

  router.post("/register", async (req, res) => {
    try {
      const body = req.body || {};
      const deviceType = normalizeDeviceType(body.type);

      if (!deviceType) {
        res.status(400).json({ ok: false, error: "type invalido. Usar CARRO o ELEVADOR" });
        return;
      }

      if (!body.robotId) {
        res.status(400).json({ ok: false, error: "robotId es obligatorio" });
        return;
      }

      const device = services.connectionService.registerDevice({
        robotId: String(body.robotId),
        type: deviceType,
        host: body.host,
        port: Number(body.port || 502),
        unitId: Number(body.unitId || 1),
        heartbeatRegister: Number(body.heartbeatRegister || 0),
        timeoutMs: Number(body.timeoutMs || 2000),
      });

      services.stateManager.upsertRobot({ id: String(body.robotId), status: "IDLE", enabled: true });
      await services.connectionService.connectDevice(device);

      res.status(201).json({ ok: true, data: device });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/", (req, res) => {
    res.json({ ok: true, data: services.stateManager.listDevices() });
  });

  router.get("/robots", (req, res) => {
    const robots = services.stateManager.listRobots().map((robot) => ({
      ...robot,
      queue: services.queueManager.ensureRobot(robot.id),
      devices: services.stateManager.listDevices().filter((device) => String(device.robotId) === String(robot.id)),
    }));

    res.json({ ok: true, data: robots });
  });

  return router;
}

module.exports = {
  createDevicesRoutes,
};
