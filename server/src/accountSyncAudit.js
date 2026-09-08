const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function cleanRequestId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(text) ? text : crypto.randomUUID();
}

function shortHash(value) {
  const text = String(value || "").trim();
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}

function safeErrorCode(error) {
  const text = String(error && (error.code || error.message) || "");
  const named = text.match(/\b(?:DEVICE|DEV|AUTH|SESSION|CAT)_[A-Z0-9_]+\b/);
  if (named) return named[0];
  const numeric = text.match(/(?:"code"\s*:\s*|\bcode[=: ]+)(\d{3,8})/i);
  return numeric ? numeric[1] : "UNKNOWN";
}

class AccountSyncAudit {
  constructor(options = {}) {
    this.filePath = String(options.filePath || "").trim();
    this.logger = options.logger || console;
    this.now = options.now || (() => new Date().toISOString());
  }

  record(event, fields = {}) {
    const entry = {
      timestamp: this.now(),
      event: String(event || "unknown").slice(0, 80),
      requestId: cleanRequestId(fields.requestId),
      resourceHash: shortHash(fields.resourceId),
      accountHash: shortHash(fields.openid),
      source: String(fields.source || "").slice(0, 40),
      statusCode: Number(fields.statusCode) || 0,
      errorCode: fields.error ? safeErrorCode(fields.error) : String(fields.errorCode || "").slice(0, 80),
    };
    const line = JSON.stringify(entry);
    this.logger.info?.("[account-sync-audit]", line);
    if (this.filePath) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.appendFileSync(this.filePath, line + "\n", "utf8");
      } catch (error) {
        this.logger.warn?.("[account-sync-audit] persist failed", error.message);
      }
    }
    return entry;
  }
}

module.exports = { AccountSyncAudit, cleanRequestId, safeErrorCode, shortHash };
