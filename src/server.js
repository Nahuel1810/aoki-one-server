const { createApp } = require("./app");

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const MQTT_HOST = process.env.MQTT_HOST || "0.0.0.0";

async function bootstrap() {
  const { app, plcMqtt } = await createApp({
    mqttPort: MQTT_PORT,
    mqttHost: MQTT_HOST,
    endpointBasePath: "/api/plc",
  });

  await plcMqtt.start();

  const httpServer = app.listen(HTTP_PORT, () => {
    console.log(`[http] API escuchando en 0.0.0.0:${HTTP_PORT}`);
  });

  async function shutdown(signal) {
    console.log(`[shutdown] Senal recibida: ${signal}`);

    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });

    await plcMqtt.stop();
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
