const test = require("node:test");
const assert = require("node:assert/strict");
const { QueueManager } = require("../../src/core/queue/QueueManager");

test("QueueManager mantiene FIFO por robot", () => {
  const queue = new QueueManager();

  queue.enqueue({ id: "o1", robotId: "1" });
  queue.enqueue({ id: "o2", robotId: "1" });

  assert.equal(queue.dequeueNext("1"), "o1");
  assert.equal(queue.dequeueNext("1"), "o2");
  assert.equal(queue.dequeueNext("1"), null);
});

test("QueueManager permite una orden activa por robot", () => {
  const queue = new QueueManager();
  queue.enqueue({ id: "o1", robotId: "1" });

  const next = queue.dequeueNext("1");
  queue.setActive("1", next);

  assert.equal(queue.isRobotBusy("1"), true);
  queue.clearActive("1");
  assert.equal(queue.isRobotBusy("1"), false);
});
