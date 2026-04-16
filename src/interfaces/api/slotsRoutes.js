const express = require("express");

function createSlotsRoutes(services) {
  const router = express.Router();

  router.get("/", (req, res) => {
    const statusFilter = String(req.query.status || "").trim().toUpperCase();
    const slots = services.stateManager.listSlots().filter((slot) => {
      if (!statusFilter) {
        return true;
      }

      return String(slot.status || "").toUpperCase() === statusFilter;
    });

    res.json({ ok: true, data: slots });
  });

  router.post("/:locationCode/release", (req, res) => {
    const locationCode = decodeURIComponent(req.params.locationCode || "");
    const released = services.stateManager.releaseSlot(locationCode);

    if (!released) {
      res.status(404).json({ ok: false, error: "Slot no encontrado" });
      return;
    }

    services.eventStore.append({
      entityType: "SLOT",
      entityId: released.locationCode,
      event: "SLOT_RELEASED_MANUAL",
    });

    services.snapshotStore.save(services.stateManager.getSnapshot());
    res.json({ ok: true, data: released });
  });

  return router;
}

module.exports = {
  createSlotsRoutes,
};
