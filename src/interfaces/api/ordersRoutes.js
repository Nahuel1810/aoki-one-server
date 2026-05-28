const express = require("express");
const {
  parseLocationCode,
  hasLocationActionSuffix,
  toCarroCommand,
  toElevadorGoLevelCommand,
} = require("../../core/orchestrator/locationTranslator");

function createOrdersRoutes(services) {
  const router = express.Router();

  function parseNumericOrderId(rawId) {
    if (rawId === undefined || rawId === null || String(rawId).trim() === "") {
      return null;
    }

    const value = Number(rawId);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error("id debe ser numerico entero");
    }

    return value;
  }

  function parseOrigin(rawOrigin) {
    if (rawOrigin === undefined || rawOrigin === null || String(rawOrigin).trim() === "") {
      return null;
    }
    const origin = String(rawOrigin).trim().toUpperCase();
    if (!["MANUAL", "PICKING"].includes(origin)) {
      throw new Error("origin invalido. Usar MANUAL o PICKING");
    }
    return origin;
  }

  function parseDateInput(value, label) {
    if (value === undefined || value === null || String(value).trim() === "") {
      return null;
    }
    const raw = String(value).trim();
    if (/^\d+$/.test(raw)) {
      return Number(raw);
    }
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label} invalido. Usar timestamp o ISO`);
    }
    return parsed;
  }

  async function createOrderResponsePayload(orderInput) {
    const numericId = parseNumericOrderId(orderInput.id);
    const existingOrder = Number.isInteger(numericId)
      ? services.stateManager.findOrderByExternalId(numericId)
      : null;

    const order = await services.orchestrator.submitOrder(orderInput);
    const created = !existingOrder;
    return { order, created };
  }

  router.post("/simulate", (req, res) => {
    try {
      const body = req.body || {};
      const type = String(body.type || "PICK").toUpperCase();
      if (!body.locationCode) {
        throw new Error("locationCode es requerido");
      }

      if (!["PICK", "PUT"].includes(type)) {
        throw new Error("type invalido. Usar PICK o PUT");
      }

      if (hasLocationActionSuffix(body.locationCode)) {
        throw new Error("locationCode no debe incluir accion final (T/D/L). La accion se deriva desde type PICK/PUT");
      }

      const parsed = parseLocationCode(body.locationCode);
      const robotId = String(body.robotId || parsed.robotId || "").trim();
      if (!robotId) {
        throw new Error("No se pudo derivar robotId. Enviar robotId o locationCode valido");
      }

      const simulatedOrder = {
        id: "SIMULATION",
        type,
        robotId,
        locationCode: parsed.baseCode,
      };

      const steps = services.orchestrator.buildSteps(type);
      const stepCommands = steps.map((step) => {
        const payload = services.orchestrator.resolveStepCommand(step, simulatedOrder);
        return {
          stepId: step.id,
          stepType: step.type,
          deviceType: step.deviceType,
          commandCode: payload.commandCode,
          address: payload.address,
          responseAddress: payload.responseAddress,
          verifyAddress: payload.verifyAddress,
          expectedResponses: payload.expectedResponses,
          expectedValue: payload.expectedValue,
        };
      });

      const carroBring = toCarroCommand(parsed, "T");
      const carroReturn = toCarroCommand(parsed, "D");
      const elevadorGoLevel = toElevadorGoLevelCommand(parsed);

      res.json({
        ok: true,
        data: {
          order: simulatedOrder,
          location: parsed,
          commandPreview: {
            carroBring,
            carroReturn,
            elevadorGoLevel,
          },
          stepCommands,
        },
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const body = req.body || {};
      const origin = parseOrigin(body.origin);
      const { order, created } = await createOrderResponsePayload({
        ...body,
        origin: origin || undefined,
      });
      res.status(created ? 202 : 200).json({ ok: true, data: order, created });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/pick", async (req, res) => {
    try {
      const body = req.body || {};
      const origin = parseOrigin(body.origin);
      const { order, created } = await createOrderResponsePayload({
        ...body,
        type: "PICK",
        origin: origin || "PICKING",
      });

      res.status(created ? 202 : 200).json({ ok: true, data: order, created });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/", (req, res) => {
    res.json({ ok: true, data: services.stateManager.listOrders() });
  });

  router.get("/queue/status", async (req, res) => {
    try {
      const snapshot = await services.queueManager.getSnapshot();
      res.json({ ok: true, data: snapshot });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get("/metrics/report", (req, res) => {
    try {
      if (!services.eventStore || typeof services.eventStore.getMetricsReport !== "function") {
        res.status(501).json({ ok: false, error: "Reporte de métricas no disponible" });
        return;
      }

      const startDate = parseDateInput(req.query.startDate, "startDate");
      const endDate = parseDateInput(req.query.endDate, "endDate");
      if (startDate !== null && endDate !== null && endDate < startDate) {
        throw new Error("endDate debe ser mayor o igual a startDate");
      }

      const report = services.eventStore.getMetricsReport({ startDate, endDate });
      res.json({ ok: true, data: report });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/queue/:robotId/pause", async (req, res) => {
    try {
      const robotId = String(req.params.robotId || "").trim();
      if (!robotId) {
        res.status(400).json({ ok: false, error: "robotId es requerido" });
        return;
      }

      await services.queueManager.pauseQueue(robotId);
      res.json({ ok: true, data: { robotId, paused: true } });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/queue/:robotId/resume", async (req, res) => {
    try {
      const robotId = String(req.params.robotId || "").trim();
      if (!robotId) {
        res.status(400).json({ ok: false, error: "robotId es requerido" });
        return;
      }

      await services.queueManager.resumeQueue(robotId);
      res.json({ ok: true, data: { robotId, paused: false } });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/:id", (req, res) => {
    const order = services.stateManager.getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ ok: false, error: "Order no encontrada" });
      return;
    }

    res.json({ ok: true, data: order });
  });

  router.post("/:id/retry", async (req, res) => {
    try {
      const order = await services.orchestrator.retryOrder(req.params.id);
      if (!order) {
        res.status(404).json({ ok: false, error: "Order no encontrada" });
        return;
      }

      res.status(202).json({ ok: true, data: order });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post("/:id/cancel", async (req, res) => {
    try {
      const order = await services.orchestrator.cancelOrder(req.params.id);
      if (!order) {
        res.status(404).json({ ok: false, error: "Order no encontrada" });
        return;
      }

      res.status(202).json({ ok: true, data: order });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  return router;
}

module.exports = {
  createOrdersRoutes,
};
