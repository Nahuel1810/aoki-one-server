const express = require("express");
const path = require("node:path");
const { createPlcMqttModule } = require("./modules/plcMqttModule");

async function createApp(config = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../public")));

  const plcMqtt = await createPlcMqttModule({
    mqttPort: config.mqttPort ?? 1883,
    host: config.mqttHost ?? "0.0.0.0",
    endpointBasePath: config.endpointBasePath ?? "/api/plc",
    logger: config.logger ?? console,
  });

  plcMqtt.attachHttpRoutes(app);

  app.get("/health", (req, res) => {
    res.json({ ok: true, service: "aoki-one-server", ts: Date.now() });
  });

  return {
    app,
    plcMqtt,
  };
}

module.exports = {
  createApp,
};
