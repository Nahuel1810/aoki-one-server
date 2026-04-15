const { createApp } = require("./app");

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);

async function bootstrap() {
  const { app, services } = createApp();

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
