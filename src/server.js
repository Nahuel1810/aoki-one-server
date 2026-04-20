require("dotenv").config();
const { createApp } = require("./app");

const HTTP_PORT =3000;

async function bootstrap() {
  const { app, services } = createApp();
  console.log(`[boot] mode=${services.connectionService.simulate ? "simulation" : "modbus"}`);

  const snapshot = services.snapshotStore.load();
  if (snapshot) {
    console.log("[boot] snapshot found, rehydrating orchestrator state");
    services.orchestrator.rehydrateFromSnapshot(snapshot);

    const restoredDevices = services.connectionService.restoreRegisteredDevices(
      services.stateManager.listDevices()
    );
    console.log(`[boot] restored devices in registry: ${restoredDevices}`);
  } else {
    console.log("[boot] no snapshot found");
  }

  if (typeof services.connectionService.startMonitoring === "function") {
    console.log("[boot] starting connection monitor");
    services.connectionService.startMonitoring();
  }

  console.log("[boot] starting orchestrator loop");
  await services.orchestrator.start();

  const httpServer = app.listen(HTTP_PORT, () => {
    console.log(`[http] API escuchando en 0.0.0.0:${HTTP_PORT}`);
  });

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[shutdown] Senal recibida: ${signal}`);

    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });

    if (typeof services.connectionService.stopMonitoring === "function") {
      services.connectionService.stopMonitoring();
    }

    await services.orchestrator.stop();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      console.error("Error en shutdown", error);
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      console.error("Error en shutdown", error);
      process.exit(1);
    });
  });
}

bootstrap().catch((error) => {
  console.error("No se pudo iniciar el servidor", error);
  process.exit(1);
});
