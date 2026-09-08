const path = require("node:path");
const { spawn } = require("node:child_process");

const ALGORITHM_VERSION = "cute-continuity-v3";

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class ContinuityV3Selector {
  constructor(options = {}) {
    this.pythonPath = options.pythonPath || process.env.FEED_ANALYSIS_PYTHON || "python";
    this.projectRoot = options.projectRoot || path.resolve(__dirname, "../../..");
    this.timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 30_000);
    this.maxOutputBytes = Math.max(1_024, Number(options.maxOutputBytes) || 32 * 1024 * 1024);
    this.spawn = options.spawn || spawn;
  }

  async select(requests, config = undefined) {
    if (!Array.isArray(requests)) throw codedError("CUTE_SELECTOR_REQUESTS_INVALID");
    if (requests.length === 0) {
      return { ok: true, algorithm: ALGORITHM_VERSION, config: config || {}, results: [] };
    }
    const payload = JSON.stringify({ requests, ...(config ? { config } : {}) });
    const pythonPath = path.join(this.projectRoot, "vision");
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.pythonPath, ["-m", "evaluation.cute_select_cli"], {
        cwd: this.projectRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONPATH: [this.projectRoot, pythonPath, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
        },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;
      const finish = (action) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        action();
      };
      const append = (current, chunk) => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next) > this.maxOutputBytes) {
          child.kill();
          finish(() => reject(codedError("CUTE_SELECTOR_OUTPUT_TOO_LARGE")));
          return current;
        }
        return next;
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => finish(() => reject(codedError("CUTE_SELECTOR_START_FAILED", error.message))));
      child.once("close", (code) => finish(() => {
        if (code !== 0) {
          reject(codedError("CUTE_SELECTOR_FAILED", stderr.trim() || stdout.trim() || `exit ${code}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (!result?.ok || result.algorithm !== ALGORITHM_VERSION || !Array.isArray(result.results)) {
            throw codedError("CUTE_SELECTOR_RESPONSE_INVALID");
          }
          resolve(result);
        } catch (error) {
          reject(error.code ? error : codedError("CUTE_SELECTOR_RESPONSE_INVALID", error.message));
        }
      }));
      timer = setTimeout(() => {
        child.kill();
        finish(() => reject(codedError("CUTE_SELECTOR_TIMEOUT")));
      }, this.timeoutMs);
      child.stdin.end(payload);
    });
  }
}

module.exports = { ALGORITHM_VERSION, ContinuityV3Selector };
