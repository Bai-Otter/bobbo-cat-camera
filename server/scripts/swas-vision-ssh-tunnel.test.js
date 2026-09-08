const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "swas-vision-ssh-tunnel.sh"), "utf8");

test("pins the worker host and confines the private key", () => {
  assert.match(source, /StrictHostKeyChecking=yes/);
  assert.match(source, /vision-worker-known_hosts/);
  assert.match(source, /refusing key outside \/opt\/bobbo\/secrets/);
  assert.doesNotMatch(source, /StrictHostKeyChecking=no/);
});

test("forwards only loopback worker traffic and restarts automatically", () => {
  assert.match(source, /-L 127\.0\.0\.1:\$\{local_port\}:127\.0\.0\.1:\$\{remote_port\}/);
  assert.match(source, /ExitOnForwardFailure=yes/);
  assert.match(source, /Restart=always/);
});
