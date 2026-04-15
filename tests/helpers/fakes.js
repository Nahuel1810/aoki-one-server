class InMemoryEventStore {
  constructor() {
    this.events = [];
  }

  append(event) {
    this.events.push({ ...event, ts: Date.now() });
  }
}

class InMemorySnapshotStore {
  constructor() {
    this.last = null;
  }

  save(snapshot) {
    this.last = snapshot;
  }

  load() {
    return this.last;
  }
}

function createFakeConnectionService(options = {}) {
  const plan = Array.isArray(options.plan) ? [...options.plan] : [];

  return {
    simulate: options.simulate ?? true,
    calls: [],
    registerDevice(deviceInput) {
      return { ...deviceInput, status: "CONNECTED", lastSeen: Date.now() };
    },
    async connectDevice() {},
    getDevice() {
      return { id: "fake-device" };
    },
    async executeStepCommand(payload) {
      this.calls.push(payload);

      if (plan.length > 0) {
        const next = plan.shift();
        if (next instanceof Error) {
          throw next;
        }

        return next;
      }

      return { ack: "DONE", stateOk: true, raw: { fake: true } };
    },
  };
}

module.exports = {
  InMemoryEventStore,
  InMemorySnapshotStore,
  createFakeConnectionService,
};
