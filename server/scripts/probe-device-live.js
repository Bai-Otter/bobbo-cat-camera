#!/usr/bin/env node
const fs = require("node:fs");

const config = require("../src/config");
const { JFDevice } = require("../src/jf/device");
const { probeLiveDevice } = require("../src/livePlaybackDiagnostics");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function loadDeviceProfile(sn) {
  const state = JSON.parse(fs.readFileSync(config.deviceRegistryFile, "utf8"));
  const devices = Array.isArray(state.devices) ? state.devices : Object.values(state.devices || {});
  return devices.find((device) => String(device.sn || "") === sn) || null;
}

async function main() {
  const sn = argumentValue("--sn") || config.livePlaybackDiagnosticSn;
  if (!sn) throw new Error("LIVE_PROBE_SN_REQUIRED");
  const profile = loadDeviceProfile(sn);
  if (!profile) throw new Error("LIVE_PROBE_DEVICE_NOT_FOUND");
  const device = new JFDevice({
    endpoint: config.endpoint,
    auth: config.auth,
    sn: profile.sn,
    username: profile.username || config.device.username,
    password: profile.password !== undefined ? profile.password : config.device.password,
    nickname: profile.nickname,
    ip: profile.ip,
    port: profile.port,
    adminToken: profile.adminToken,
  });
  const result = await probeLiveDevice({
    device,
    sn,
    channel: config.channel,
    stream: config.stream,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.code || error.message || "LIVE_PROBE_FAILED") })}\n`);
  process.exitCode = 1;
});
