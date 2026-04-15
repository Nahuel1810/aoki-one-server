const fs = require("node:fs");
const path = require("node:path");

class FileEventStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(process.cwd(), "data", "events.ndjson");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  append(event) {
    const line = `${JSON.stringify({ ...event, ts: Date.now() })}\n`;
    fs.appendFileSync(this.filePath, line, "utf8");
  }
}

module.exports = {
  FileEventStore,
};
