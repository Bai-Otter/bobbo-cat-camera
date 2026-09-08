const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "swas-elastic-worker-controller.sh"), "utf8");

test("installs only staged controller sources and a private environment", () => {
  assert.match(source, /refusing source outside \/opt\/bobbo\/incoming/);
  assert.match(source, /environment must be a non-empty file under \/opt\/bobbo\/secrets/);
  assert.match(source, /chmod 0600/);
});

test("runs the controller as a bounded systemd service", () => {
  assert.match(source, /bobbo-elastic-vision-controller\.service/);
  assert.match(source, /Environment=HOME=\/root/);
  assert.match(source, /systemctl restart bobbo-elastic-vision-controller\.service/);
  assert.match(source, /Restart=always/);
  assert.match(source, /ReadWritePaths=\/opt\/bobbo\/elastic-worker/);
  assert.match(source, /MemoryMax=160M/);
});
