const express = require("express");

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeDeviceType(value) {
  const deviceType = String(value || "").trim().toUpperCase();
  if (["CARRO", "ELEVADOR"].includes(deviceType)) {
    return deviceType;
  }

  return null;
}

function normalizeDeviceProtocol(value) {
  const protocol = String(value || "").trim().toLowerCase();
  if (["single-register", "split-message"].includes(protocol)) {
    return protocol;
  }

  return undefined;
}

function parseRegisterMap(body = {}) {
  const incoming = body.registerMap && typeof body.registerMap === "object" ? body.registerMap : null;
  const messageIn = parseOptionalNumber(incoming?.messageIn);
  const messageOut = parseOptionalNumber(incoming?.messageOut);
  const registerMap = {};

  if (messageIn !== undefined) {
    registerMap.messageIn = messageIn;
  }

  if (messageOut !== undefined) {
    registerMap.messageOut = messageOut;
  }

  return registerMap;
}

function createDevicesRoutes(services) {
  const router = express.Router();

  router.post("/register", async (req, res) => {
    try {
      const body = req.body || {};
      const deviceType = normalizeDeviceType(body.type);
      services.logger?.info?.("[api/devices] register requested", {
        robotId: body.robotId,
        type: body.type,
        host: body.host,
        port: body.port,
        unitId: body.unitId,
      });

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
        protocol: normalizeDeviceProtocol(body.protocol),
        host: body.host,
        port: Number(body.port || 502),
        unitId: Number(body.unitId || 1),
        timeoutMs: Number(body.timeoutMs || 2000),
        registerMap: parseRegisterMap(body),
      });

      services.stateManager.upsertRobot({ id: String(body.robotId), status: "IDLE", enabled: true });
      await services.connectionService.connectDevice(device);

      services.logger?.info?.("[api/devices] register ok", {
        robotId: device.robotId,
        type: device.type,
        registerMap: device.registerMap,
      });

      res.status(201).json({ ok: true, data: device });
    } catch (error) {
      services.logger?.error?.("[api/devices] register failed", { error: error.message });
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

  router.post("/:robotId/:type/command", async (req, res) => {
    try {
      const robotId = String(req.params.robotId || "").trim();
      const deviceType = normalizeDeviceType(req.params.type);
      const body = req.body || {};
      const value = parseOptionalNumber(body.value);
      const expectedResponses = Array.isArray(body.expectedResponses)
        ? body.expectedResponses
        : [parseOptionalNumber(body.expectedResponse) ?? 100];

      if (!deviceType) {
        res.status(400).json({ ok: false, error: "type invalido. Usar CARRO o ELEVADOR" });
        return;
      }

      if (!robotId) {
        res.status(400).json({ ok: false, error: "robotId es obligatorio" });
        return;
      }

      if (value === undefined) {
        res.status(400).json({ ok: false, error: "value es obligatorio y numerico" });
        return;
      }

      const response = await services.connectionService.executeDirectCommand({
        robotId,
        type: deviceType,
        value,
        expectedResponses,
      });

      res.json({
        ok: true,
        data: {
          robotId,
          type: deviceType,
          commandValue: value,
          response,
        },
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/:robotId/:type/state", async (req, res) => {
    try {
      const robotId = String(req.params.robotId || "").trim();
      const deviceType = normalizeDeviceType(req.params.type);

      if (!deviceType) {
        res.status(400).json({ ok: false, error: "type invalido. Usar CARRO o ELEVADOR" });
        return;
      }

      if (!robotId) {
        res.status(400).json({ ok: false, error: "robotId es obligatorio" });
        return;
      }

      const state = await services.connectionService.readDeviceState({
        robotId,
        type: deviceType,
      });

      res.json({ ok: true, data: state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  return router;
}

module.exports = {
  createDevicesRoutes,
};
