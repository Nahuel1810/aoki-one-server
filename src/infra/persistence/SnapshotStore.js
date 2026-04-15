const fs = require("node:fs");
const path = require("node:path");

class SnapshotStore {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(process.cwd(), "data", "snapshot.json");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  save(snapshot) {
    fs.writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}

module.exports = {
  SnapshotStore,
};
