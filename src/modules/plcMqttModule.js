const net = require("node:net");
const { EventEmitter } = require("node:events");

function isValidTipo(value) {
  return typeof value === "string" && /^[a-z0-9_-]+$/i.test(value);
}

function isValidId(value) {
  return typeof value === "string" && /^[a-z0-9_-]+$/i.test(value);
}

function isValidPlcTopic(topic) {
  return /^plc\/[a-z0-9_-]+\/[a-z0-9_-]+\/(cmd|state)$/i.test(topic);
}

function buildPlcTopic(tipo, id, channel) {
  return `plc/${tipo}/${id}/${channel}`;
}

function validateCommandPayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "El payload debe ser un objeto JSON";
  }

  if (!("cmd" in payload)) {
    return "Falta el campo cmd";
  }

  if (!("ts" in payload)) {
    return "Falta el campo ts";
  }

  if (typeof payload.ts !== "number" || !Number.isFinite(payload.ts)) {
    return "El campo ts debe ser un numero UNIX timestamp";
  }

  return null;
}

async function createAedesBroker() {
  const aedesLib = require("aedes");

  if (aedesLib && aedesLib.Aedes && typeof aedesLib.Aedes.createBroker === "function") {
    return aedesLib.Aedes.createBroker();
  }

  if (typeof aedesLib === "function") {
    return aedesLib();
  }

  throw new Error("No se pudo inicializar Aedes con la version instalada");
}

async function createPlcMqttModule(options = {}) {
  const {
    mqttPort = 1883,
    host = "0.0.0.0",
    endpointBasePath = "/api/plc",
    logger = console,
  } = options;

  const broker = await createAedesBroker();
  const emitter = new EventEmitter();
  const lastKnownStates = new Map();

  const mqttServer = net.createServer(broker.handle);

  broker.on("publish", (packet, client) => {
    if (!packet || !packet.topic || !packet.payload) {
      return;
    }

    if (!isValidPlcTopic(packet.topic) || !packet.topic.endsWith("/state")) {
      return;
    }

    try {
      const payloadAsText = packet.payload.toString("utf8");
      const parsed = JSON.parse(payloadAsText);

      lastKnownStates.set(packet.topic, {
        topic: packet.topic,
        payload: parsed,
        ts: Date.now(),
        clientId: client ? client.id : null,
      });

      emitter.emit("plc:state", {
        topic: packet.topic,
        payload: parsed,
        clientId: client ? client.id : null,
      });
    } catch (error) {
      logger.warn("[plc-mqtt] state payload invalido", {
        topic: packet.topic,
        error: error.message,
      });
    }
  });

  function publish(topic, payload, publishOptions = {}) {
    return new Promise((resolve, reject) => {
      if (!isValidPlcTopic(topic)) {
        reject(new Error("Topico invalido. Formato esperado: plc/{tipo}/{id}/cmd|state"));
        return;
      }

      const body = Buffer.from(JSON.stringify(payload), "utf8");
      const packet = {
        topic,
        payload: body,
        qos: publishOptions.qos ?? 0,
        retain: publishOptions.retain ?? false,
      };

      broker.publish(packet, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          topic,
          payload,
          qos: packet.qos,
          retain: packet.retain,
          publishedAt: Date.now(),
        });
      });
    });
  }

  async function publishCommand(tipo, id, payload, publishOptions = {}) {
    if (!isValidTipo(tipo)) {
      throw new Error("tipo invalido. Solo letras, numeros, guion y guion_bajo");
    }

    if (!isValidId(id)) {
      throw new Error("id invalido. Solo letras, numeros, guion y guion_bajo");
    }

    const validationError = validateCommandPayload(payload);
    if (validationError) {
      throw new Error(validationError);
    }

    const topic = buildPlcTopic(tipo, id, "cmd");
    return publish(topic, payload, publishOptions);
  }

  function getLastKnownState(tipo, id) {
    const topic = buildPlcTopic(tipo, id, "state");
    return lastKnownStates.get(topic) || null;
  }

  function attachHttpRoutes(app) {
    app.post(`${endpointBasePath}/:tipo/:id/cmd`, async (req, res) => {
      const { tipo, id } = req.params;
      const payload = req.body;

      try {
        const result = await publishCommand(tipo, id, payload);
        res.status(202).json({
          ok: true,
          data: result,
        });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: error.message,
        });
      }
    });

    app.post(`${endpointBasePath}/publish`, async (req, res) => {
      const { topic, payload, qos, retain } = req.body || {};

      if (!topic) {
        res.status(400).json({ ok: false, error: "Falta topic" });
        return;
      }

      if (typeof payload !== "object" || payload === null) {
        res.status(400).json({ ok: false, error: "Falta payload o no es objeto" });
        return;
      }

      try {
        const result = await publish(topic, payload, { qos, retain });
        res.status(202).json({ ok: true, data: result });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    app.get(`${endpointBasePath}/:tipo/:id/state`, (req, res) => {
      const { tipo, id } = req.params;

      if (!isValidTipo(tipo) || !isValidId(id)) {
        res.status(400).json({ ok: false, error: "tipo o id invalido" });
        return;
      }

      const state = getLastKnownState(tipo, id);

      if (!state) {
        res.status(404).json({ ok: false, error: "No hay state registrado para este PLC" });
        return;
      }

      res.json({ ok: true, data: state });
    });
  }

  async function start() {
    return new Promise((resolve, reject) => {
      mqttServer.once("error", reject);
      mqttServer.listen(mqttPort, host, () => {
        mqttServer.off("error", reject);
        logger.info(`[plc-mqtt] broker MQTT escuchando en ${host}:${mqttPort}`);
        resolve();
      });
    });
  }

  async function stop() {
    await new Promise((resolve) => {
      mqttServer.close(() => resolve());
    });

    await new Promise((resolve) => {
      broker.close(() => resolve());
    });

    logger.info("[plc-mqtt] broker MQTT detenido");
  }

  return {
    start,
    stop,
    broker,
    publish,
    publishCommand,
    getLastKnownState,
    attachHttpRoutes,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    topic: {
      buildPlcTopic,
      isValidPlcTopic,
    },
  };
}

module.exports = {
  createPlcMqttModule,
  buildPlcTopic,
  isValidPlcTopic,
};
