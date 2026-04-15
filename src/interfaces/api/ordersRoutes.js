const express = require("express");

function createOrdersRoutes(services) {
  const router = express.Router();

  router.post("/", (req, res) => {
    try {
      const order = services.orchestrator.submitOrder(req.body || {});
      res.status(202).json({ ok: true, data: order });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get("/", (req, res) => {
    res.json({ ok: true, data: services.stateManager.listOrders() });
  });

  router.get("/:id", (req, res) => {
    const order = services.stateManager.getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ ok: false, error: "Order no encontrada" });
      return;
    }

    res.json({ ok: true, data: order });
  });

  router.post("/:id/retry", (req, res) => {
    const order = services.orchestrator.retryOrder(req.params.id);
    if (!order) {
      res.status(404).json({ ok: false, error: "Order no encontrada" });
      return;
    }

    res.status(202).json({ ok: true, data: order });
  });

  router.post("/:id/cancel", (req, res) => {
    const order = services.orchestrator.cancelOrder(req.params.id);
    if (!order) {
      res.status(404).json({ ok: false, error: "Order no encontrada" });
      return;
    }

    res.status(202).json({ ok: true, data: order });
  });

  return router;
}

module.exports = {
  createOrdersRoutes,
};
