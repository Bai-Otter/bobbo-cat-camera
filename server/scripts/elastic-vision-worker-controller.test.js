const test = require("node:test");
const assert = require("node:assert/strict");

const { buildInstanceActionArgs } = require("./elastic-vision-worker-controller");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "elastic-vision-worker-controller.js"), "utf8");

test("start action contains only StartInstance parameters", () => {
  assert.deepEqual(buildInstanceActionArgs("start", "i-worker"), [
    "ecs", "StartInstance", "--InstanceId", "i-worker",
  ]);
});

test("stop action requests StopCharging", () => {
  assert.deepEqual(buildInstanceActionArgs("stop", "i-worker"), [
    "ecs", "StopInstance", "--InstanceId", "i-worker",
    "--ForceStop", "true", "--StoppedMode", "StopCharging",
  ]);
});

test("uses the configured Aliyun CLI profile and survives transient poll failures", () => {
  assert.match(source, /ALIBABA_CLOUD_PROFILE/);
  assert.match(source, /\.\.\.args,[\s\S]*\["--profile", settings\.aliyunProfile\]/);
  assert.match(source, /"--connect-timeout", "5"/);
  assert.match(source, /"--read-timeout", "15"/);
  assert.match(source, /"--retry-count", "1"/);
  assert.match(source, /poll failed; retrying/);
  assert.doesNotMatch(source, /poll failed; retrying[\s\S]{0,200}process\.exit/);
});
