const test = require("node:test");
const assert = require("node:assert/strict");
const { ErrorHandler } = require("../../src/core/errors/ErrorHandler");
const { StateManager } = require("../../src/core/state/StateManager");

test("ErrorHandler calcula backoff exponencial", () => {
  const handler = new ErrorHandler();
  assert.equal(handler.nextBackoffMs(1, 100), 100);
  assert.equal(handler.nextBackoffMs(2, 100), 200);
  assert.equal(handler.nextBackoffMs(3, 100), 400);
});

test("ErrorHandler clasifica errores retryables", () => {
  const handler = new ErrorHandler();
  assert.equal(handler.isRetryable(new Error("retry")), true);

  const fatal = new Error("fatal");
  fatal.fatal = true;
  assert.equal(handler.isRetryable(fatal), false);
});

test("ErrorHandler captura error en estado", () => {
  const state = new StateManager();
  const handler = new ErrorHandler({ logger: { error() {} } });

  const entity = handler.capture(state, {
    entityType: "ORDER",
    entityId: "o1",
    message: "boom",
  });

  assert.equal(entity.entityId, "o1");
  assert.equal(state.listErrors().length, 1);
});
