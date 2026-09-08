#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { accrueLedger, canStartWorker, normalizeLedger } = require("../src/feedAnalysis/elasticWorkerBudget");

const settings = {
  aliyunCli: process.env.ALIYUN_CLI || "aliyun",
  aliyunProfile: String(process.env.ALIBABA_CLOUD_PROFILE || "").trim(),
  regionId: process.env.WORKER_REGION_ID || "cn-beijing",
  instanceId: process.env.WORKER_INSTANCE_ID || "",
  controlUrl: String(process.env.WORKER_CONTROL_URL || "http://127.0.0.1:3000/internal/feed-analysis/worker-demand"),
  controlToken: String(process.env.FEED_ANALYSIS_WORKER_CONTROL_TOKEN || ""),
  healthUrl: String(process.env.WORKER_HEALTH_URL || ""),
  hourlyCny: Number(process.env.WORKER_HOURLY_CNY) || 0,
  monthlyLimitCny: Number(process.env.WORKER_MONTHLY_LIMIT_CNY) || 100,
  fixedReserveCny: Number(process.env.WORKER_MONTHLY_FIXED_RESERVE_CNY) || 20,
  idleStopMs: (Number(process.env.WORKER_IDLE_STOP_SECONDS) || 600) * 1000,
  pollMs: (Number(process.env.WORKER_POLL_SECONDS) || 15) * 1000,
  stateFile: process.env.WORKER_BUDGET_STATE_FILE || "/opt/bobbo/elastic-worker/budget.json",
};

function requireSettings() {
  for (const [key, value] of Object.entries({
    WORKER_INSTANCE_ID: settings.instanceId,
    FEED_ANALYSIS_WORKER_CONTROL_TOKEN: settings.controlToken,
    WORKER_HEALTH_URL: settings.healthUrl,
    WORKER_HOURLY_CNY: settings.hourlyCny,
  })) {
    if (!value) throw new Error(`${key}_REQUIRED`);
  }
}

function readLedger() {
  try { return normalizeLedger(JSON.parse(fs.readFileSync(settings.stateFile, "utf8"))); }
  catch (_) { return normalizeLedger({}); }
}

function writeLedger(ledger) {
  fs.mkdirSync(path.dirname(settings.stateFile), { recursive: true });
  const temp = `${settings.stateFile}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(normalizeLedger(ledger), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, settings.stateFile);
}

function runAliyun(args) {
  return new Promise((resolve, reject) => {
    // Alibaba Cloud CLI expects the product and operation first. Keeping global
    // flags at the tail avoids `--profile` being treated as a command in an
    // unattended systemd process, while bounded retries prevent stuck polls.
    const cliArgs = [
      ...args,
      ...(settings.aliyunProfile ? ["--profile", settings.aliyunProfile] : []),
      "--connect-timeout", "5",
      "--read-timeout", "15",
      "--retry-count", "1",
      "--yes",
    ];
    const child = spawn(settings.aliyunCli, cliArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`ALIYUN_CLI_${code}: ${stderr.trim()}`));
      else resolve(stdout.trim() ? JSON.parse(stdout) : {});
    });
  });
}

async function instanceStatus() {
  const result = await runAliyun([
    "ecs", "DescribeInstances",
    "--RegionId", settings.regionId,
    "--InstanceIds", JSON.stringify([settings.instanceId]),
  ]);
  return String(result?.Instances?.Instance?.[0]?.Status || "Missing");
}

function buildInstanceActionArgs(action, instanceId = settings.instanceId) {
  const command = action === "start" ? "StartInstance" : "StopInstance";
  const args = ["ecs", command, "--InstanceId", instanceId];
  if (action === "stop") args.push("--ForceStop", "true", "--StoppedMode", "StopCharging");
  return args;
}

async function setInstanceState(action) {
  return runAliyun(buildInstanceActionArgs(action));
}

async function demand() {
  const response = await fetch(settings.controlUrl, { headers: { Authorization: `Bearer ${settings.controlToken}` } });
  if (!response.ok) throw new Error(`CONTROL_HTTP_${response.status}`);
  return response.json();
}

async function healthReady() {
  try { return (await fetch(settings.healthUrl, { signal: AbortSignal.timeout(5000) })).ok; }
  catch (_) { return false; }
}

async function main() {
  requireSettings();
  let ledger = readLedger();
  let idleSinceMs = 0;
  let stopping = false;
  const requestStop = () => { stopping = true; };
  process.once("SIGTERM", requestStop);
  process.once("SIGINT", requestStop);
  while (!stopping) {
    try {
      const now = Date.now();
      ledger = accrueLedger(ledger, now);
      const queue = await demand();
      const status = await instanceStatus();
      const running = status === "Running";
      if (running && !ledger.runningSinceMs) ledger.runningSinceMs = now;
      if (!running && ledger.runningSinceMs) {
        ledger = accrueLedger(ledger, now);
        ledger.runningSinceMs = 0;
      }

      const budget = canStartWorker({
        ledger,
        timestamp: now,
        hourlyCny: settings.hourlyCny,
        fixedReserveCny: settings.fixedReserveCny,
        monthlyLimitCny: settings.monthlyLimitCny,
      });
      if (queue.desired) {
        idleSinceMs = 0;
        if (!running) {
          if (!budget.allowed) throw new Error(`MONTHLY_BUDGET_EXHAUSTED_${budget.projectedCny.toFixed(2)}`);
          await setInstanceState("start");
          ledger.runningSinceMs = now;
          console.log(`[elastic-worker] start requested; projected CNY ${budget.projectedCny.toFixed(2)}`);
        } else if (await healthReady()) {
          console.log(`[elastic-worker] ready; pending=${queue.pending} running=${queue.running}`);
        }
      } else if (running) {
        if (!idleSinceMs) idleSinceMs = now;
        if (now - idleSinceMs >= settings.idleStopMs) {
          await setInstanceState("stop");
          ledger = accrueLedger(ledger, Date.now());
          ledger.runningSinceMs = 0;
          idleSinceMs = 0;
          console.log("[elastic-worker] stopped after idle window");
        }
      }
      writeLedger(ledger);
    } catch (error) {
      console.error(`[elastic-worker] poll failed; retrying: ${error.message}`);
      try { writeLedger(ledger); }
      catch (writeError) { console.error(`[elastic-worker] ledger write failed: ${writeError.message}`); }
    }
    await new Promise((resolve) => setTimeout(resolve, settings.pollMs));
  }
  process.removeListener("SIGTERM", requestStop);
  process.removeListener("SIGINT", requestStop);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[elastic-worker] controller failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { buildInstanceActionArgs };
