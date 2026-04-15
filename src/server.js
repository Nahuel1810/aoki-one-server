const { createApp } = require("./app");

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);

async function bootstrap() {
  const { app, services } = createApp();

  const snapshot = services.snapshotStore.load();
  if (snapshot) {
    services.orchestrator.rehydrateFromSnapshot(snapshot);
  }

  if (typeof services.connectionService.startMonitoring === "function") {
    services.connectionService.startMonitoring();
  }

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
