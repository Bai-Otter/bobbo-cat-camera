const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function hydrateUser(row) {
  if (!row) return null;
  return {
    openid: row.openid,
    unionid: row.unionid || "",
    nickname: row.nickname,
    avatar: row.avatar,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function hydrateFeedback(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    content: row.content,
    contact: row.contact,
    deviceSn: row.device_sn,
    status: row.status,
    createdAt: Number(row.created_at) || 0,
  };
}

function hydrateCover(row) {
  if (!row) return null;
  return {
    sn: row.sn,
    fileId: row.file_id,
    coverUrl: row.cover_url,
    capturedAt: Number(row.captured_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function hydrateFoodcastPreferences(row) {
  if (!row) return { mode: "quick_cut", durationMode: "auto", updatedAt: 0 };
  const supportedDurationModes = new Set(["auto", "compact", "standard", "rich"]);
  return {
    mode: row.mode === "natural" ? "natural" : "quick_cut",
    durationMode: supportedDurationModes.has(row.duration_mode) ? row.duration_mode : "auto",
    updatedAt: Number(row.updated_at) || 0,
  };
}

function hydrateWechatDeviceSubscription(row) {
  if (!row) return null;
  return {
    openid: row.openid,
    deviceSn: row.device_sn,
    templateId: row.template_id,
    eventType: row.event_type,
    status: row.wx_status,
    enabled: Number(row.enabled) === 1,
    subscribedAt: Number(row.subscribed_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function hydrateWechatFeedingSession(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    deviceSn: row.device_sn,
    startAt: Number(row.start_at) || 0,
    endAt: Number(row.end_at) || 0,
    state: row.state === "closed" ? "closed" : "open",
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function normalizeDeliveryStatus(value) {
  if (value === "sent" || value === "delivered") return "delivered";
  if (value === "failed") return "failed";
  return "pending";
}

const WXPUSHER_CLAWBOT_ACTIVE_MS = 24 * 60 * 60 * 1000;
const WXPUSHER_CLAWBOT_MESSAGE_LIMIT = 10;
const WXPUSHER_CLAWBOT_CONFIRM_MAX_AGE_MS = 30 * 60 * 1000;
// WxPusher's supported ClawBot flow runs inside its signed-in mobile app.
// The /app/#/ilink-bind H5 route requires an app device token and must not be
// exposed as a standalone WeChat QR code.
const WXPUSHER_CLAWBOT_BIND_PATH = "/app/#/push-channel";
const WXPUSHER_CLAWBOT_ACTIVATION_URL = "https://wxpusher.zjiecode.com/download/";

function hydrateNotificationDelivery(row) {
  if (!row) return null;
  return {
    id: row.delivery_id || "",
    deliveryKey: row.delivery_key || "",
    openid: row.openid || "",
    recipientHash: row.recipient_hash || "",
    deviceSn: row.device_sn || "",
    templateId: row.template_id || "",
    eventType: row.event_type || "",
    eventTime: Number(row.event_time) || 0,
    provider: row.provider || "legacy_device",
    providerMessageId: row.provider_message_id || "",
    providerStatus: row.provider_status || "",
    status: normalizeDeliveryStatus(row.status),
    attempts: Number(row.attempts) || 0,
    providerCode: Number(row.provider_code) || 0,
    lastError: row.last_error || "",
    acceptedAt: Number(row.accepted_at) || 0,
    deliveredAt: Number(row.delivered_at) || 0,
    failedAt: Number(row.failed_at) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

class AppDataStore {
  constructor(filePath) {
    this.filePath = filePath || ":memory:";
    if (this.filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_users (
        openid TEXT PRIMARY KEY,
        unionid TEXT NOT NULL DEFAULT '',
        nickname TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        openid TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        contact TEXT NOT NULL DEFAULT '',
        device_sn TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_feedback_owner
        ON app_feedback(openid, created_at DESC);
      CREATE TABLE IF NOT EXISTS app_device_covers (
        openid TEXT NOT NULL,
        sn TEXT NOT NULL,
        file_id TEXT NOT NULL DEFAULT '',
        cover_url TEXT NOT NULL DEFAULT '',
        captured_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (openid, sn)
      );
      CREATE TABLE IF NOT EXISTS app_foodcast_preferences (
        openid TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'quick_cut',
        duration_mode TEXT NOT NULL DEFAULT 'auto',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wechat_device_subscriptions (
        openid TEXT NOT NULL,
        device_sn TEXT NOT NULL,
        template_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        wx_status TEXT NOT NULL DEFAULT 'unknown',
        enabled INTEGER NOT NULL DEFAULT 0,
        subscribed_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (openid, device_sn, template_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wechat_device_subscriptions_device
        ON wechat_device_subscriptions(device_sn, template_id, enabled);
      CREATE TABLE IF NOT EXISTS wechat_feeding_sessions (
        session_id TEXT PRIMARY KEY,
        device_sn TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wechat_feeding_sessions_device
        ON wechat_feeding_sessions(device_sn, start_at, state);
      CREATE TABLE IF NOT EXISTS wechat_feeding_sources (
        source_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wechat_notification_deliveries (
        delivery_key TEXT PRIMARY KEY,
        openid TEXT NOT NULL,
        device_sn TEXT NOT NULL,
        template_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_time INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        provider_code INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_preferences (
        openid TEXT NOT NULL,
        device_sn TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        motion_alert_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (openid, device_sn)
      );
      CREATE INDEX IF NOT EXISTS idx_notification_preferences_device
        ON notification_preferences(device_sn, enabled);
      CREATE TABLE IF NOT EXISTS motion_alerts (
        device_sn TEXT NOT NULL,
        alarm_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        occurred_at_text TEXT NOT NULL DEFAULT '',
        alarm_type TEXT NOT NULL DEFAULT 'Motion',
        label TEXT NOT NULL DEFAULT '',
        image_source_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (device_sn, alarm_id)
      );
      CREATE INDEX IF NOT EXISTS idx_motion_alerts_device_time
        ON motion_alerts(device_sn, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS wechat_mini_subscription_grants (
        openid TEXT NOT NULL,
        device_sn TEXT NOT NULL,
        event_type TEXT NOT NULL,
        template_id TEXT NOT NULL,
        remaining_count INTEGER NOT NULL DEFAULT 0,
        last_status TEXT NOT NULL DEFAULT 'unknown',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (openid, device_sn, event_type)
      );
      CREATE INDEX IF NOT EXISTS idx_wechat_mini_grants_delivery
        ON wechat_mini_subscription_grants(device_sn, event_type, remaining_count);
      CREATE TABLE IF NOT EXISTS wechat_official_bindings (
        unionid TEXT PRIMARY KEY,
        official_openid TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        subscribed_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wxpusher_bindings (
        openid TEXT PRIMARY KEY,
        uid TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        bound_at INTEGER NOT NULL DEFAULT 0,
        clawbot_confirmed_at INTEGER NOT NULL DEFAULT 0,
        clawbot_active_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wxpusher_binding_challenges (
        challenge_hash TEXT PRIMARY KEY,
        openid TEXT NOT NULL,
        qr_code_url TEXT NOT NULL DEFAULT '',
        follow_url TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wxpusher_challenges_openid
        ON wxpusher_binding_challenges(openid, expires_at);
      CREATE TABLE IF NOT EXISTS pushplus_bindings (
        openid TEXT PRIMARY KEY,
        friend_token TEXT NOT NULL UNIQUE,
        friend_id TEXT NOT NULL DEFAULT '',
        is_follow INTEGER NOT NULL DEFAULT 0,
        nickname TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        bound_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pushplus_binding_challenges (
        code TEXT PRIMARY KEY,
        openid TEXT NOT NULL,
        qr_code_url TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pushplus_challenges_openid
        ON pushplus_binding_challenges(openid, expires_at);
    `);
    const userColumns = this.db.prepare("PRAGMA table_info(app_users)").all();
    if (!userColumns.some((column) => column.name === "unionid")) {
      this.db.exec("ALTER TABLE app_users ADD COLUMN unionid TEXT NOT NULL DEFAULT ''");
    }
    const foodcastPreferenceColumns = this.db.prepare("PRAGMA table_info(app_foodcast_preferences)").all();
    if (!foodcastPreferenceColumns.some((column) => column.name === "duration_mode")) {
      this.db.exec("ALTER TABLE app_foodcast_preferences ADD COLUMN duration_mode TEXT NOT NULL DEFAULT 'auto'");
    }
    const deliveryColumns = this.db.prepare("PRAGMA table_info(wechat_notification_deliveries)").all();
    if (!deliveryColumns.some((column) => column.name === "provider")) {
      this.db.exec("ALTER TABLE wechat_notification_deliveries ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy_device'");
    }
    if (!deliveryColumns.some((column) => column.name === "recipient")) {
      this.db.exec("ALTER TABLE wechat_notification_deliveries ADD COLUMN recipient TEXT NOT NULL DEFAULT ''");
    }
    const deliveryMigrations = [
      ["delivery_id", "TEXT NOT NULL DEFAULT ''"],
      ["recipient_hash", "TEXT NOT NULL DEFAULT ''"],
      ["provider_message_id", "TEXT NOT NULL DEFAULT ''"],
      ["provider_status", "TEXT NOT NULL DEFAULT ''"],
      ["accepted_at", "INTEGER NOT NULL DEFAULT 0"],
      ["delivered_at", "INTEGER NOT NULL DEFAULT 0"],
      ["failed_at", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [columnName, columnDefinition] of deliveryMigrations) {
      if (!deliveryColumns.some((column) => column.name === columnName)) {
        this.db.exec(`ALTER TABLE wechat_notification_deliveries ADD COLUMN ${columnName} ${columnDefinition}`);
      }
    }
    const notificationPreferenceColumns = this.db.prepare("PRAGMA table_info(notification_preferences)").all();
    if (!notificationPreferenceColumns.some((column) => column.name === "motion_alert_enabled")) {
      this.db.exec("ALTER TABLE notification_preferences ADD COLUMN motion_alert_enabled INTEGER NOT NULL DEFAULT 1");
    }
    const wxPusherBindingColumns = this.db.prepare("PRAGMA table_info(wxpusher_bindings)").all();
    const wxPusherBindingMigrations = [
      ["clawbot_confirmed_at", "INTEGER NOT NULL DEFAULT 0"],
      ["clawbot_active_until", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [columnName, columnDefinition] of wxPusherBindingMigrations) {
      if (!wxPusherBindingColumns.some((column) => column.name === columnName)) {
        this.db.exec(`ALTER TABLE wxpusher_bindings ADD COLUMN ${columnName} ${columnDefinition}`);
      }
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_unionid
        ON app_users(unionid) WHERE unionid <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_delivery_id
        ON wechat_notification_deliveries(delivery_id) WHERE delivery_id <> '';
      CREATE INDEX IF NOT EXISTS idx_notification_delivery_provider_message
        ON wechat_notification_deliveries(provider, provider_message_id)
        WHERE provider_message_id <> '';
    `);
  }

  getUser(openidValue) {
    const openid = cleanText(openidValue, 128);
    if (!openid) return null;
    return hydrateUser(
      this.db.prepare("SELECT * FROM app_users WHERE openid = ?").get(openid)
    );
  }

  upsertUser(openidValue, patch = {}) {
    const openid = cleanText(openidValue, 128);
    if (!openid) throw new Error("OPENID_REQUIRED");
    const existing = this.getUser(openid);
    const now = Date.now();
    const nickname = patch.nickname === undefined
      ? existing && existing.nickname || ""
      : cleanText(patch.nickname, 80);
    const avatar = patch.avatar === undefined
      ? existing && existing.avatar || ""
      : cleanText(patch.avatar, 1024);
    const unionid = patch.unionid === undefined
      ? existing && existing.unionid || ""
      : cleanText(patch.unionid, 128);
    const createdAt = existing && existing.createdAt || now;
    this.db.prepare(`
      INSERT INTO app_users (openid, unionid, nickname, avatar, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(openid) DO UPDATE SET
        unionid = excluded.unionid,
        nickname = excluded.nickname,
        avatar = excluded.avatar,
        updated_at = excluded.updated_at
    `).run(openid, unionid, nickname, avatar, createdAt, now);
    return this.getUser(openid);
  }

  getUserByUnionid(unionidValue) {
    const unionid = cleanText(unionidValue, 128);
    if (!unionid) return null;
    return hydrateUser(this.db.prepare("SELECT * FROM app_users WHERE unionid = ?").get(unionid));
  }

  saveNotificationPreference(openidValue, deviceSnValue, enabledValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    if (!openid || !deviceSn) throw new Error("NOTIFICATION_PREFERENCE_INVALID");
    const updatedAt = Date.now();
    this.db.prepare(`
      INSERT INTO notification_preferences (openid, device_sn, enabled, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(openid, device_sn) DO UPDATE SET
        enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(openid, deviceSn, enabledValue ? 1 : 0, updatedAt);
    return this.getNotificationPreference(openid, deviceSn);
  }

  getNotificationPreference(openidValue, deviceSnValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    const row = openid && deviceSn
      ? this.db.prepare("SELECT * FROM notification_preferences WHERE openid = ? AND device_sn = ?")
        .get(openid, deviceSn)
      : null;
    return {
      openid,
      deviceSn,
      enabled: Number(row && row.enabled) === 1,
      updatedAt: Number(row && row.updated_at) || 0,
    };
  }

  saveMotionAlertPreference(openidValue, deviceSnValue, enabledValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    if (!openid || !deviceSn) throw new Error("MOTION_ALERT_PREFERENCE_INVALID");
    const updatedAt = Date.now();
    this.db.prepare(`
      INSERT INTO notification_preferences (openid, device_sn, enabled, motion_alert_enabled, updated_at)
      VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(openid, device_sn) DO UPDATE SET
        motion_alert_enabled = excluded.motion_alert_enabled, updated_at = excluded.updated_at
    `).run(openid, deviceSn, enabledValue ? 1 : 0, updatedAt);
    return this.getMotionAlertPreference(openid, deviceSn);
  }

  getMotionAlertPreference(openidValue, deviceSnValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    const row = openid && deviceSn
      ? this.db.prepare("SELECT motion_alert_enabled, updated_at FROM notification_preferences WHERE openid = ? AND device_sn = ?")
        .get(openid, deviceSn)
      : null;
    return {
      openid,
      deviceSn,
      enabled: !row || Number(row.motion_alert_enabled) === 1,
      updatedAt: Number(row && row.updated_at) || 0,
    };
  }

  saveMotionAlarms(deviceSnValue, alarms = []) {
    const deviceSn = cleanText(deviceSnValue, 128);
    if (!deviceSn) throw new Error("MOTION_ALERT_DEVICE_INVALID");
    const insert = this.db.prepare(`
      INSERT INTO motion_alerts (
        device_sn, alarm_id, occurred_at, occurred_at_text,
        alarm_type, label, image_source_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_sn, alarm_id) DO UPDATE SET
        occurred_at = excluded.occurred_at,
        occurred_at_text = excluded.occurred_at_text,
        alarm_type = excluded.alarm_type,
        label = excluded.label,
        image_source_url = CASE
          WHEN excluded.image_source_url <> '' THEN excluded.image_source_url
          ELSE motion_alerts.image_source_url
        END
    `);
    const now = Date.now();
    let saved = 0;
    for (const alarm of Array.isArray(alarms) ? alarms : []) {
      const alarmId = cleanText(alarm?.id || alarm?.alarmId || alarm?.AlarmID || alarm?.AlarmId, 160);
      const occurredAt = Number(alarm?.occurredAtMs) || 0;
      if (!alarmId || occurredAt <= 0) continue;
      insert.run(
        deviceSn,
        alarmId,
        occurredAt,
        cleanText(alarm?.occurredAt || alarm?.AlarmTime, 64),
        cleanText(alarm?.alarmType || alarm?.AlarmType || alarm?.Event || "Motion", 80),
        cleanText(alarm?.label || "检测到移动", 80),
        cleanText(alarm?.imageUrl || alarm?.PicUrl || alarm?.snapshotUrl, 4096),
        now
      );
      saved += 1;
    }
    this.db.prepare("DELETE FROM motion_alerts WHERE occurred_at < ?")
      .run(now - 30 * 24 * 60 * 60 * 1000);
    return { saved };
  }

  listMotionAlarms(deviceSnValue, { date = "", limit = 50 } = {}) {
    const deviceSn = cleanText(deviceSnValue, 128);
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))
      ? this.db.prepare(`
          SELECT * FROM motion_alerts
          WHERE device_sn = ? AND occurred_at_text LIKE ?
          ORDER BY occurred_at DESC LIMIT ?
        `).all(deviceSn, `${date}%`, safeLimit)
      : this.db.prepare(`
          SELECT * FROM motion_alerts WHERE device_sn = ?
          ORDER BY occurred_at DESC LIMIT ?
        `).all(deviceSn, safeLimit);
    return rows.map((row) => ({
      id: row.alarm_id,
      occurredAt: row.occurred_at_text,
      occurredAtMs: Number(row.occurred_at) || 0,
      alarmType: row.alarm_type,
      label: row.label,
      imageUrl: row.image_source_url,
    }));
  }

  addMiniSubscriptionGrant(openidValue, input = {}) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(input.deviceSn, 128);
    const eventType = input.eventType === "feeding_end" ? "feeding_end" : "feeding_start";
    const templateId = cleanText(input.templateId, 128);
    const status = cleanText(input.status, 32) || "unknown";
    if (!openid || !deviceSn || !templateId) throw new Error("MINI_SUBSCRIPTION_GRANT_INVALID");
    const accepted = status === "accept";
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO wechat_mini_subscription_grants (
        openid, device_sn, event_type, template_id, remaining_count, last_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(openid, device_sn, event_type) DO UPDATE SET
        template_id = excluded.template_id,
        remaining_count = CASE
          WHEN excluded.last_status = 'accept' THEN wechat_mini_subscription_grants.remaining_count + 1
          ELSE wechat_mini_subscription_grants.remaining_count
        END,
        last_status = excluded.last_status,
        updated_at = excluded.updated_at
    `).run(openid, deviceSn, eventType, templateId, accepted ? 1 : 0, status, now);
    return this.getMiniSubscriptionGrants(openid, deviceSn)
      .find((grant) => grant.eventType === eventType);
  }

  getMiniSubscriptionGrants(openidValue, deviceSnValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    if (!openid || !deviceSn) return [];
    return this.db.prepare(`
      SELECT * FROM wechat_mini_subscription_grants
      WHERE openid = ? AND device_sn = ? ORDER BY event_type
    `).all(openid, deviceSn).map((row) => ({
      openid: row.openid,
      deviceSn: row.device_sn,
      eventType: row.event_type,
      templateId: row.template_id,
      remainingCount: Math.max(0, Number(row.remaining_count) || 0),
      status: row.last_status,
      updatedAt: Number(row.updated_at) || 0,
    }));
  }

  listMiniSubscriptionRecipients(deviceSnValue, eventTypeValue) {
    const deviceSn = cleanText(deviceSnValue, 128);
    const eventType = eventTypeValue === "feeding_end" ? "feeding_end" : "feeding_start";
    if (!deviceSn) return [];
    return this.db.prepare(`
      SELECT g.* FROM wechat_mini_subscription_grants g
      INNER JOIN notification_preferences p
        ON p.openid = g.openid AND p.device_sn = g.device_sn
      WHERE g.device_sn = ? AND g.event_type = ?
        AND g.remaining_count > 0 AND p.enabled = 1
      ORDER BY g.openid
    `).all(deviceSn, eventType).map((row) => ({
      openid: row.openid,
      deviceSn: row.device_sn,
      eventType: row.event_type,
      templateId: row.template_id,
      remainingCount: Number(row.remaining_count) || 0,
    }));
  }

  listNotificationRecipients(deviceSnValue) {
    const deviceSn = cleanText(deviceSnValue, 128);
    if (!deviceSn) return [];
    return this.db.prepare(`
      SELECT openid, device_sn, updated_at FROM notification_preferences
      WHERE device_sn = ? AND enabled = 1 ORDER BY openid
    `).all(deviceSn).map((row) => ({
      openid: row.openid,
      deviceSn: row.device_sn,
      updatedAt: Number(row.updated_at) || 0,
    }));
  }

  claimMiniSubscriptionGrant(openidValue, deviceSnValue, eventTypeValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    const eventType = eventTypeValue === "feeding_end" ? "feeding_end" : "feeding_start";
    const result = this.db.prepare(`
      UPDATE wechat_mini_subscription_grants
      SET remaining_count = remaining_count - 1, updated_at = ?
      WHERE openid = ? AND device_sn = ? AND event_type = ? AND remaining_count > 0
    `).run(Date.now(), openid, deviceSn, eventType);
    return Number(result.changes) === 1;
  }

  restoreMiniSubscriptionGrant(openidValue, deviceSnValue, eventTypeValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    const eventType = eventTypeValue === "feeding_end" ? "feeding_end" : "feeding_start";
    this.db.prepare(`
      UPDATE wechat_mini_subscription_grants
      SET remaining_count = remaining_count + 1, updated_at = ?
      WHERE openid = ? AND device_sn = ? AND event_type = ?
    `).run(Date.now(), openid, deviceSn, eventType);
  }

  saveOfficialBinding(input = {}) {
    const unionid = cleanText(input.unionid, 128);
    const officialOpenid = cleanText(input.officialOpenid, 128);
    const status = input.status === "unsubscribed" ? "unsubscribed" : "active";
    if (!unionid || !officialOpenid) throw new Error("OFFICIAL_BINDING_INVALID");
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO wechat_official_bindings (
        unionid, official_openid, status, subscribed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(unionid) DO UPDATE SET
        official_openid = excluded.official_openid,
        status = excluded.status,
        subscribed_at = CASE WHEN excluded.status = 'active' THEN excluded.subscribed_at ELSE subscribed_at END,
        updated_at = excluded.updated_at
    `).run(unionid, officialOpenid, status, status === "active" ? now : 0, now);
    return this.getOfficialBindingByUnionid(unionid);
  }

  getOfficialBindingByUnionid(unionidValue) {
    const unionid = cleanText(unionidValue, 128);
    const row = unionid
      ? this.db.prepare("SELECT * FROM wechat_official_bindings WHERE unionid = ?").get(unionid)
      : null;
    if (!row) return null;
    return {
      unionid: row.unionid,
      officialOpenid: row.official_openid,
      status: row.status,
      subscribedAt: Number(row.subscribed_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
    };
  }

  getOfficialBindingForOpenid(openidValue) {
    const user = this.getUser(openidValue);
    return user && user.unionid ? this.getOfficialBindingByUnionid(user.unionid) : null;
  }

  markOfficialBindingUnsubscribed(officialOpenidValue) {
    const officialOpenid = cleanText(officialOpenidValue, 128);
    if (!officialOpenid) return false;
    const result = this.db.prepare(`
      UPDATE wechat_official_bindings SET status = 'unsubscribed', updated_at = ?
      WHERE official_openid = ?
    `).run(Date.now(), officialOpenid);
    return Number(result.changes) > 0;
  }

  hashWxPusherChallenge(challengeValue) {
    const challenge = cleanText(challengeValue, 64);
    return challenge
      ? crypto.createHash("sha256").update(challenge).digest("hex")
      : "";
  }

  saveWxPusherBindingChallenge(input = {}) {
    const openid = cleanText(input.openid, 128);
    const challengeHash = this.hashWxPusherChallenge(input.challenge);
    const expiresAt = Math.max(1, Number(input.expiresAt) || 0);
    if (!openid || !challengeHash || !expiresAt) throw new Error("WXPUSHER_CHALLENGE_INVALID");
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO wxpusher_binding_challenges (
        challenge_hash, openid, qr_code_url, follow_url, expires_at,
        consumed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(challenge_hash) DO UPDATE SET
        qr_code_url = excluded.qr_code_url,
        follow_url = excluded.follow_url,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      challengeHash,
      openid,
      cleanText(input.qrCodeUrl, 1024),
      cleanText(input.followUrl, 1024),
      expiresAt,
      now,
      now
    );
    return this.getActiveWxPusherBindingChallenge(input.challenge, expiresAt - 1);
  }

  getActiveWxPusherBindingChallenge(challengeValue, nowValue = Date.now()) {
    const challengeHash = this.hashWxPusherChallenge(challengeValue);
    const now = Number(nowValue) || Date.now();
    const row = challengeHash ? this.db.prepare(`
      SELECT * FROM wxpusher_binding_challenges
      WHERE challenge_hash = ? AND expires_at > ? AND consumed_at = 0
    `).get(challengeHash, now) : null;
    if (!row) return null;
    return {
      openid: row.openid,
      qrCodeUrl: row.qr_code_url,
      followUrl: row.follow_url,
      expiresAt: Number(row.expires_at) || 0,
      consumedAt: Number(row.consumed_at) || 0,
    };
  }

  expireWxPusherBindingChallenge(challengeValue) {
    const challengeHash = this.hashWxPusherChallenge(challengeValue);
    if (!challengeHash) return false;
    const result = this.db.prepare(`
      UPDATE wxpusher_binding_challenges SET expires_at = 0, updated_at = ?
      WHERE challenge_hash = ? AND consumed_at = 0
    `).run(Date.now(), challengeHash);
    return Number(result.changes) > 0;
  }

  completeWxPusherBindingChallenge(input = {}) {
    const challengeHash = this.hashWxPusherChallenge(input.challenge);
    const uid = cleanText(input.uid, 128);
    const now = Number(input.now) || Date.now();
    if (!challengeHash || !uid) return null;
    const challenge = this.db.prepare(`
      SELECT * FROM wxpusher_binding_challenges WHERE challenge_hash = ?
    `).get(challengeHash);
    if (!challenge || Number(challenge.expires_at) <= now) return null;
    if (Number(challenge.consumed_at) > 0) {
      const existing = this.getWxPusherBinding(challenge.openid);
      return existing && existing.uid === uid ? existing : null;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.db.prepare(`
        UPDATE wxpusher_binding_challenges
        SET consumed_at = ?, updated_at = ?
        WHERE challenge_hash = ? AND consumed_at = 0 AND expires_at > ?
      `).run(now, now, challengeHash, now);
      if (Number(consumed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare(`
        INSERT INTO wxpusher_bindings (
          openid, uid, status, bound_at, clawbot_confirmed_at,
          clawbot_active_until, updated_at
        ) VALUES (?, ?, 'active', ?, 0, 0, ?)
        ON CONFLICT(openid) DO UPDATE SET
          uid = excluded.uid, status = 'active', bound_at = excluded.bound_at,
          clawbot_confirmed_at = CASE
            WHEN wxpusher_bindings.uid = excluded.uid THEN wxpusher_bindings.clawbot_confirmed_at
            ELSE 0
          END,
          clawbot_active_until = CASE
            WHEN wxpusher_bindings.uid = excluded.uid THEN wxpusher_bindings.clawbot_active_until
            ELSE 0
          END,
          updated_at = excluded.updated_at
      `).run(challenge.openid, uid, now, now);
      this.db.exec("COMMIT");
      return this.getWxPusherBinding(challenge.openid);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch (rollbackError) {}
      throw error;
    }
  }

  getWxPusherBinding(openidValue) {
    const openid = cleanText(openidValue, 128);
    const row = openid
      ? this.db.prepare("SELECT * FROM wxpusher_bindings WHERE openid = ?").get(openid)
      : null;
    if (!row) return null;
    return {
      openid: row.openid,
      uid: row.uid,
      status: row.status,
      boundAt: Number(row.bound_at) || 0,
      clawBotConfirmedAt: Number(row.clawbot_confirmed_at) || 0,
      clawBotActiveUntil: Number(row.clawbot_active_until) || 0,
      updatedAt: Number(row.updated_at) || 0,
    };
  }

  getWxPusherClawBotStatus(openidValue, nowValue = Date.now()) {
    const openid = cleanText(openidValue, 128);
    const now = Number(nowValue) || Date.now();
    const binding = this.getWxPusherBinding(openid);
    const bound = !!(binding && binding.status === "active");
    const confirmedAt = bound ? binding.clawBotConfirmedAt : 0;
    const activeUntil = bound ? binding.clawBotActiveUntil : 0;
    const deliveredCount = confirmedAt > 0
      ? Number(this.db.prepare(`
          SELECT COUNT(*) AS count FROM wechat_notification_deliveries
          WHERE openid = ? AND provider = 'wxpusher'
            AND status = 'delivered' AND delivered_at >= ? AND delivered_at <= ?
            AND provider_message_id <> ''
        `).get(openid, confirmedAt, now).count) || 0
      : 0;
    const estimatedUsed = Math.min(WXPUSHER_CLAWBOT_MESSAGE_LIMIT, deliveredCount);
    const estimatedRemaining = Math.max(0, WXPUSHER_CLAWBOT_MESSAGE_LIMIT - deliveredCount);
    const active = bound && confirmedAt > 0 && activeUntil > now && estimatedRemaining > 0;
    return {
      bound,
      status: !bound
        ? "not_bound"
        : active
          ? "active"
          : confirmedAt > 0
            ? "reactivation_required"
            : "pending_confirmation",
      confirmedAt,
      activeUntil,
      estimatedUsed,
      estimatedRemaining,
      needsReactivation: bound && confirmedAt > 0 && !active,
      activationMethod: "wxpusher_app",
      activationPath: WXPUSHER_CLAWBOT_BIND_PATH,
      activationUrl: WXPUSHER_CLAWBOT_ACTIVATION_URL,
    };
  }

  confirmWxPusherClawBot(openidValue, deliveryIdValue, nowValue = Date.now()) {
    const openid = cleanText(openidValue, 128);
    const deliveryId = cleanText(deliveryIdValue, 128);
    const now = Number(nowValue) || Date.now();
    const binding = this.getWxPusherBinding(openid);
    if (!binding || binding.status !== "active") {
      const error = new Error("WXPUSHER_BINDING_REQUIRED");
      error.code = "WXPUSHER_BINDING_REQUIRED";
      throw error;
    }
    const delivery = this.getWechatNotificationDelivery(deliveryId, openid);
    const validTarget = !!(
      delivery && delivery.provider === "wxpusher" &&
      String(delivery.templateId || "").endsWith(":test") && delivery.providerMessageId
    );
    if (validTarget && delivery.status === "pending") {
      const error = new Error("WXPUSHER_CLAWBOT_TEST_PENDING");
      error.code = "WXPUSHER_CLAWBOT_TEST_PENDING";
      throw error;
    }
    if (validTarget && delivery.status === "failed") {
      const error = new Error("WXPUSHER_CLAWBOT_TEST_FAILED");
      error.code = "WXPUSHER_CLAWBOT_TEST_FAILED";
      throw error;
    }
    const deliveredAt = Number(delivery && delivery.deliveredAt) || 0;
    const isRecentTest = !!(
      validTarget && delivery.status === "delivered" && deliveredAt > 0 &&
      now - deliveredAt >= 0 && now - deliveredAt <= WXPUSHER_CLAWBOT_CONFIRM_MAX_AGE_MS
    );
    if (!isRecentTest) {
      const error = new Error("WXPUSHER_CLAWBOT_TEST_INVALID");
      error.code = "WXPUSHER_CLAWBOT_TEST_INVALID";
      throw error;
    }
    this.db.prepare(`
      UPDATE wxpusher_bindings SET
        clawbot_confirmed_at = ?, clawbot_active_until = ?, updated_at = ?
      WHERE openid = ? AND status = 'active'
    `).run(deliveredAt, now + WXPUSHER_CLAWBOT_ACTIVE_MS, now, openid);
    return this.getWxPusherClawBotStatus(openid, now);
  }

  disableWxPusherBinding(openidValue) {
    const openid = cleanText(openidValue, 128);
    if (!openid) return false;
    const result = this.db.prepare(`
      UPDATE wxpusher_bindings SET status = 'disabled', clawbot_confirmed_at = 0,
        clawbot_active_until = 0, updated_at = ? WHERE openid = ?
    `).run(Date.now(), openid);
    return Number(result.changes) > 0;
  }

  savePushPlusBindingChallenge(input = {}) {
    const openid = cleanText(input.openid, 128);
    const code = cleanText(input.code, 128);
    const expiresAt = Math.max(1, Number(input.expiresAt) || 0);
    if (!openid || !code || !expiresAt) throw new Error("PUSHPLUS_CHALLENGE_INVALID");
    const now = Date.now();
    this.db.prepare("DELETE FROM pushplus_binding_challenges WHERE openid = ?").run(openid);
    this.db.prepare(`
      INSERT INTO pushplus_binding_challenges (
        code, openid, qr_code_url, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(code, openid, cleanText(input.qrCodeUrl, 1024), expiresAt, now, now);
    return this.getPushPlusBindingChallengeByCode(code, expiresAt - 1);
  }

  getActivePushPlusBindingChallenge(openidValue, nowValue = Date.now()) {
    const openid = cleanText(openidValue, 128);
    const row = openid ? this.db.prepare(`
      SELECT * FROM pushplus_binding_challenges
      WHERE openid = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1
    `).get(openid, Number(nowValue) || Date.now()) : null;
    return row ? {
      code: row.code,
      openid: row.openid,
      qrCodeUrl: row.qr_code_url,
      expiresAt: Number(row.expires_at) || 0,
      createdAt: Number(row.created_at) || 0,
    } : null;
  }

  getPushPlusBindingChallengeByCode(codeValue, nowValue = Date.now()) {
    const code = cleanText(codeValue, 128);
    const row = code ? this.db.prepare(`
      SELECT * FROM pushplus_binding_challenges
      WHERE code = ? AND expires_at > ? LIMIT 1
    `).get(code, Number(nowValue) || Date.now()) : null;
    return row ? {
      code: row.code,
      openid: row.openid,
      qrCodeUrl: row.qr_code_url,
      expiresAt: Number(row.expires_at) || 0,
      createdAt: Number(row.created_at) || 0,
    } : null;
  }

  completePushPlusBinding(codeValue, friendInfo = {}) {
    const code = cleanText(codeValue, 128);
    const friendToken = cleanText(friendInfo.token, 256);
    const challenge = this.getPushPlusBindingChallengeByCode(code, Date.now());
    if (!challenge || !friendToken || Number(friendInfo.isFollow) !== 1) return null;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const deleted = this.db.prepare(`
        DELETE FROM pushplus_binding_challenges
        WHERE code = ? AND expires_at > ?
      `).run(code, now);
      if (Number(deleted.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare(`
        INSERT INTO pushplus_bindings (
          openid, friend_token, friend_id, is_follow, nickname, status, bound_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, 'active', ?, ?)
        ON CONFLICT(openid) DO UPDATE SET
          friend_token = excluded.friend_token,
          friend_id = excluded.friend_id,
          is_follow = 1,
          nickname = excluded.nickname,
          status = 'active',
          bound_at = excluded.bound_at,
          updated_at = excluded.updated_at
      `).run(
        challenge.openid,
        friendToken,
        cleanText(friendInfo.friendId, 128),
        cleanText(friendInfo.nickName, 80),
        now,
        now
      );
      this.db.exec("COMMIT");
      return this.getPushPlusBinding(challenge.openid);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch (rollbackError) {}
      throw error;
    }
  }

  getPushPlusBinding(openidValue) {
    const openid = cleanText(openidValue, 128);
    const row = openid
      ? this.db.prepare("SELECT * FROM pushplus_bindings WHERE openid = ?").get(openid)
      : null;
    if (!row) return null;
    return {
      openid: row.openid,
      friendToken: row.friend_token,
      friendId: row.friend_id,
      isFollow: Number(row.is_follow) === 1,
      nickname: row.nickname,
      status: row.status,
      boundAt: Number(row.bound_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
    };
  }

  disablePushPlusBinding(openidValue) {
    const openid = cleanText(openidValue, 128);
    if (!openid) return false;
    const result = this.db.prepare(`
      UPDATE pushplus_bindings SET status = 'disabled', updated_at = ? WHERE openid = ?
    `).run(Date.now(), openid);
    return Number(result.changes) > 0;
  }

  addFeedback(openidValue, input = {}) {
    const openid = cleanText(openidValue, 128);
    const content = cleanText(input.content, 2000);
    if (!openid) throw new Error("OPENID_REQUIRED");
    if (!content) throw new Error("FEEDBACK_CONTENT_REQUIRED");
    const createdAt = Date.now();
    const result = this.db.prepare(`
      INSERT INTO app_feedback (
        openid, type, content, contact, device_sn, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(
      openid,
      cleanText(input.type, 40),
      content,
      cleanText(input.contact, 160),
      cleanText(input.deviceSn, 128),
      createdAt
    );
    return hydrateFeedback(
      this.db.prepare("SELECT * FROM app_feedback WHERE id = ?").get(result.lastInsertRowid)
    );
  }

  listFeedback(openidValue) {
    const openid = cleanText(openidValue, 128);
    if (!openid) return [];
    return this.db
      .prepare("SELECT * FROM app_feedback WHERE openid = ? ORDER BY created_at DESC, id DESC")
      .all(openid)
      .map(hydrateFeedback);
  }

  saveDeviceCover(openidValue, input = {}) {
    const openid = cleanText(openidValue, 128);
    const sn = cleanText(input.sn, 128);
    if (!openid) throw new Error("OPENID_REQUIRED");
    if (!sn) throw new Error("DEVICE_SN_REQUIRED");
    const capturedAt = Number(input.capturedAt) || Date.now();
    this.db.prepare(`
      INSERT INTO app_device_covers (
        openid, sn, file_id, cover_url, captured_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(openid, sn) DO UPDATE SET
        file_id = excluded.file_id,
        cover_url = excluded.cover_url,
        captured_at = excluded.captured_at,
        updated_at = excluded.updated_at
    `).run(
      openid,
      sn,
      cleanText(input.fileId, 1024),
      cleanText(input.coverUrl, 2048),
      capturedAt,
      capturedAt
    );
    return hydrateCover(
      this.db.prepare(
        "SELECT * FROM app_device_covers WHERE openid = ? AND sn = ?"
      ).get(openid, sn)
    );
  }

  getDeviceCovers(openidValue, sns = []) {
    const openid = cleanText(openidValue, 128);
    const requested = new Set(
      (Array.isArray(sns) ? sns : [])
        .map((sn) => cleanText(sn, 128))
        .filter(Boolean)
    );
    if (!openid || requested.size === 0) return {};
    const rows = this.db
      .prepare("SELECT * FROM app_device_covers WHERE openid = ?")
      .all(openid);
    return rows.reduce((result, row) => {
      if (requested.has(row.sn)) result[row.sn] = hydrateCover(row);
      return result;
    }, {});
  }

  deleteDeviceCover(openidValue, snValue) {
    const openid = cleanText(openidValue, 128);
    const sn = cleanText(snValue, 128);
    if (!openid || !sn) return false;
    const result = this.db
      .prepare("DELETE FROM app_device_covers WHERE openid = ? AND sn = ?")
      .run(openid, sn);
    return Number(result.changes) > 0;
  }

  getFoodcastPreferences(openidValue) {
    const openid = cleanText(openidValue, 128);
    if (!openid) return hydrateFoodcastPreferences(null);
    return hydrateFoodcastPreferences(
      this.db.prepare("SELECT * FROM app_foodcast_preferences WHERE openid = ?").get(openid)
    );
  }

  saveFoodcastPreferences(openidValue, input = {}) {
    const openid = cleanText(openidValue, 128);
    if (!openid) throw new Error("OPENID_REQUIRED");
    const current = this.getFoodcastPreferences(openid);
    let mode = current.mode;
    if (Object.prototype.hasOwnProperty.call(input, "mode")) {
      mode = input.mode === "natural" ? "natural" : input.mode === "quick_cut" ? "quick_cut" : "";
      if (!mode) throw new Error("FOODCAST_MODE_INVALID");
    }
    let durationMode = current.durationMode;
    if (Object.prototype.hasOwnProperty.call(input, "durationMode")) {
      const supportedDurationModes = new Set(["auto", "compact", "standard", "rich"]);
      durationMode = supportedDurationModes.has(input.durationMode) ? input.durationMode : "";
      if (!durationMode) throw new Error("FOODCAST_DURATION_MODE_INVALID");
    }
    const updatedAt = Date.now();
    this.db.prepare(`
      INSERT INTO app_foodcast_preferences (openid, mode, duration_mode, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(openid) DO UPDATE SET
        mode = excluded.mode,
        duration_mode = excluded.duration_mode,
        updated_at = excluded.updated_at
    `).run(openid, mode, durationMode, updatedAt);
    return this.getFoodcastPreferences(openid);
  }

  getMeta(keyValue) {
    const key = cleanText(keyValue, 128);
    if (!key) return "";
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
    return row ? String(row.value || "") : "";
  }

  setMeta(keyValue, value) {
    const key = cleanText(keyValue, 128);
    if (!key) throw new Error("APP_META_KEY_REQUIRED");
    const updatedAt = Date.now();
    this.db.prepare(`
      INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value ?? ""), updatedAt);
    return String(value ?? "");
  }

  saveWechatDeviceSubscription(openidValue, input = {}) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(input.deviceSn, 128);
    const templateId = cleanText(input.templateId, 128);
    const eventType = input.eventType === "feeding_end" ? "feeding_end" : "feeding_start";
    const allowedStatuses = new Set(["accept", "acceptWithAudio", "reject", "ban", "filter", "unknown"]);
    const status = allowedStatuses.has(input.status) ? input.status : "unknown";
    if (!openid || !deviceSn || !templateId) throw new Error("WECHAT_DEVICE_SUBSCRIPTION_INVALID");
    const now = Date.now();
    const accepted = status === "accept" || status === "acceptWithAudio";
    const enabled = accepted && input.enabled !== false ? 1 : 0;
    this.db.prepare(`
      INSERT INTO wechat_device_subscriptions (
        openid, device_sn, template_id, event_type, wx_status, enabled, subscribed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(openid, device_sn, template_id) DO UPDATE SET
        event_type = excluded.event_type,
        wx_status = excluded.wx_status,
        enabled = excluded.enabled,
        subscribed_at = CASE WHEN excluded.enabled = 1 THEN excluded.subscribed_at ELSE subscribed_at END,
        updated_at = excluded.updated_at
    `).run(openid, deviceSn, templateId, eventType, status, enabled, accepted ? now : 0, now);
    return this.getWechatDeviceSubscriptions(openid, deviceSn)
      .find((item) => item.templateId === templateId);
  }

  setWechatDeviceSubscriptionsEnabled(openidValue, deviceSnValue, enabledValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    if (!openid || !deviceSn) return 0;
    const enabled = enabledValue ? 1 : 0;
    const result = this.db.prepare(`
      UPDATE wechat_device_subscriptions
      SET enabled = CASE WHEN wx_status IN ('accept', 'acceptWithAudio') THEN ? ELSE 0 END,
          updated_at = ?
      WHERE openid = ? AND device_sn = ?
    `).run(enabled, Date.now(), openid, deviceSn);
    return Number(result.changes) || 0;
  }

  getWechatDeviceSubscriptions(openidValue, deviceSnValue) {
    const openid = cleanText(openidValue, 128);
    const deviceSn = cleanText(deviceSnValue, 128);
    if (!openid || !deviceSn) return [];
    return this.db.prepare(`
      SELECT * FROM wechat_device_subscriptions
      WHERE openid = ? AND device_sn = ?
      ORDER BY event_type, template_id
    `).all(openid, deviceSn).map(hydrateWechatDeviceSubscription);
  }

  listEnabledWechatDeviceSubscriptions(deviceSnValue, templateIdValue) {
    const deviceSn = cleanText(deviceSnValue, 128);
    const templateId = cleanText(templateIdValue, 128);
    if (!deviceSn || !templateId) return [];
    return this.db.prepare(`
      SELECT * FROM wechat_device_subscriptions
      WHERE device_sn = ? AND template_id = ? AND enabled = 1
        AND wx_status IN ('accept', 'acceptWithAudio')
      ORDER BY openid
    `).all(deviceSn, templateId).map(hydrateWechatDeviceSubscription);
  }

  resolveWechatFeedingSession(input = {}) {
    const deviceSn = cleanText(input.deviceSn, 128);
    const eventType = input.eventType === "feeding_end" ? "feeding_end" : "feeding_start";
    const sourceKey = cleanText(input.sourceKey, 240);
    const occurredAt = Math.max(1, Number(input.occurredAt) || Date.now());
    if (!deviceSn || !sourceKey) throw new Error("WECHAT_FEEDING_SESSION_INVALID");
    const source = this.db.prepare(`
      SELECT session_id FROM wechat_feeding_sources WHERE source_key = ?
    `).get(sourceKey);
    if (source) {
      return hydrateWechatFeedingSession(
        this.db.prepare("SELECT * FROM wechat_feeding_sessions WHERE session_id = ?").get(source.session_id)
      );
    }

    let session = null;
    const requestedSessionId = cleanText(input.sessionId, 128);
    if (requestedSessionId) {
      session = this.db.prepare("SELECT * FROM wechat_feeding_sessions WHERE session_id = ?")
        .get(requestedSessionId);
    }
    if (!session && eventType === "feeding_start") {
      const windowMs = Math.max(60_000, Number(input.dedupeWindowMs) || 30 * 60_000);
      session = this.db.prepare(`
        SELECT * FROM wechat_feeding_sessions
        WHERE device_sn = ? AND state = 'open' AND ABS(start_at - ?) <= ?
        ORDER BY ABS(start_at - ?) ASC LIMIT 1
      `).get(deviceSn, occurredAt, windowMs, occurredAt);
      if (!session) {
        session = this.db.prepare(`
          SELECT * FROM wechat_feeding_sessions
          WHERE device_sn = ? AND state = 'closed'
            AND ? BETWEEN start_at - 300000 AND end_at
          ORDER BY start_at DESC LIMIT 1
        `).get(deviceSn, occurredAt);
      }
    }
    if (!session && eventType === "feeding_end") {
      session = this.db.prepare(`
        SELECT * FROM wechat_feeding_sessions
        WHERE device_sn = ? AND state = 'open' AND start_at <= ? AND ? - start_at <= 7200000
        ORDER BY start_at DESC LIMIT 1
      `).get(deviceSn, occurredAt, occurredAt);
    }
    const now = Date.now();
    if (!session) {
      const sessionId = `feed_${crypto.createHash("sha256")
        .update(`${deviceSn}:${occurredAt}:${sourceKey}`)
        .digest("hex").slice(0, 24)}`;
      this.db.prepare(`
        INSERT INTO wechat_feeding_sessions (
          session_id, device_sn, start_at, end_at, state, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'open', ?, ?)
      `).run(sessionId, deviceSn, occurredAt, now, now);
      session = this.db.prepare("SELECT * FROM wechat_feeding_sessions WHERE session_id = ?")
        .get(sessionId);
    }
    if (eventType === "feeding_end") {
      this.db.prepare(`
        UPDATE wechat_feeding_sessions SET end_at = ?, state = 'closed', updated_at = ?
        WHERE session_id = ?
      `).run(occurredAt, now, session.session_id);
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO wechat_feeding_sources (
        source_key, session_id, event_type, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(sourceKey, session.session_id, eventType, occurredAt, now);
    return hydrateWechatFeedingSession(
      this.db.prepare("SELECT * FROM wechat_feeding_sessions WHERE session_id = ?").get(session.session_id)
    );
  }

  claimWechatNotificationDelivery(input = {}) {
    const deliveryKey = cleanText(input.deliveryKey, 320);
    if (!deliveryKey) throw new Error("WECHAT_NOTIFICATION_DELIVERY_KEY_REQUIRED");
    const existing = this.db.prepare(`
      SELECT status, updated_at FROM wechat_notification_deliveries WHERE delivery_key = ?
    `).get(deliveryKey);
    const now = Date.now();
    if (existing && (["sent", "delivered"].includes(existing.status) || (
      ["sending", "pending"].includes(existing.status) && now - Number(existing.updated_at) < 2 * 60_000
    ))) return false;
    const deliveryId = `delivery_${crypto.randomUUID().replace(/-/g, "")}`;
    const recipient = cleanText(input.recipient || input.openid, 256);
    const recipientHash = recipient
      ? crypto.createHash("sha256").update(`notification-recipient:${recipient}`).digest("hex")
      : "";
    this.db.prepare(`
      INSERT INTO wechat_notification_deliveries (
        delivery_key, openid, device_sn, template_id, event_type, event_time,
        status, attempts, provider_code, last_error, created_at, updated_at, provider, recipient,
        delivery_id, recipient_hash, provider_message_id, provider_status,
        accepted_at, delivered_at, failed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, 0, '', ?, ?, ?, '', ?, ?, '', '', 0, 0, 0)
      ON CONFLICT(delivery_key) DO UPDATE SET
        status = 'pending', attempts = attempts + 1, provider_code = 0,
        last_error = '', provider_status = '', failed_at = 0,
        delivery_id = CASE WHEN delivery_id = '' THEN excluded.delivery_id ELSE delivery_id END,
        recipient_hash = CASE WHEN recipient_hash = '' THEN excluded.recipient_hash ELSE recipient_hash END,
        updated_at = excluded.updated_at
    `).run(
      deliveryKey,
      cleanText(input.openid, 128),
      cleanText(input.deviceSn, 128),
      cleanText(input.templateId, 128),
      input.eventType === "feeding_end" ? "feeding_end" : "feeding_start",
      Number(input.eventTime) || now,
      now,
      now,
      cleanText(input.provider, 40) || "legacy_device",
      deliveryId,
      recipientHash
    );
    return true;
  }

  markWechatNotificationDeliveryPending(deliveryKeyValue, input = {}) {
    const deliveryKey = cleanText(deliveryKeyValue, 320);
    const now = Date.now();
    this.db.prepare(`
      UPDATE wechat_notification_deliveries
      SET status = 'pending', provider_message_id = ?, provider_status = ?,
          provider_code = ?, last_error = '', accepted_at = CASE WHEN accepted_at > 0 THEN accepted_at ELSE ? END,
          updated_at = ?
      WHERE delivery_key = ?
    `).run(
      cleanText(input.providerMessageId, 128),
      cleanText(input.providerStatus, 160),
      Number(input.providerCode) || 0,
      now,
      now,
      deliveryKey
    );
  }

  markWechatNotificationDeliveryDelivered(deliveryKeyValue, input = {}) {
    const deliveryKey = cleanText(deliveryKeyValue, 320);
    const now = Date.now();
    this.db.prepare(`
      UPDATE wechat_notification_deliveries
      SET status = 'delivered', provider_message_id = CASE WHEN ? <> '' THEN ? ELSE provider_message_id END,
          provider_status = ?, provider_code = ?, last_error = '',
          accepted_at = CASE WHEN accepted_at > 0 THEN accepted_at ELSE ? END,
          delivered_at = ?, failed_at = 0, updated_at = ?
      WHERE delivery_key = ?
    `).run(
      cleanText(input.providerMessageId, 128),
      cleanText(input.providerMessageId, 128),
      cleanText(input.providerStatus, 160) || "delivered",
      Number(input.providerCode) || 0,
      now,
      now,
      now,
      deliveryKey
    );
  }

  markWechatNotificationDeliverySent(deliveryKeyValue, input = {}) {
    this.markWechatNotificationDeliveryDelivered(deliveryKeyValue, input);
  }

  markWechatNotificationDeliveryFailed(deliveryKeyValue, error = {}) {
    const deliveryKey = cleanText(deliveryKeyValue, 320);
    const now = Date.now();
    this.db.prepare(`
      UPDATE wechat_notification_deliveries
      SET status = 'failed', provider_code = ?, provider_status = ?, last_error = ?,
          failed_at = ?, updated_at = ?
      WHERE delivery_key = ?
    `).run(
      Number(error.providerCode) || 0,
      cleanText(error.providerStatus, 160) || "failed",
      cleanText(error.code || error.message, 160),
      now,
      now,
      deliveryKey
    );
  }

  getWechatNotificationDeliveryByKey(deliveryKeyValue) {
    const deliveryKey = cleanText(deliveryKeyValue, 320);
    const row = deliveryKey
      ? this.db.prepare("SELECT * FROM wechat_notification_deliveries WHERE delivery_key = ?").get(deliveryKey)
      : null;
    return hydrateNotificationDelivery(row);
  }

  getWechatNotificationDelivery(deliveryIdValue, openidValue = "") {
    const deliveryId = cleanText(deliveryIdValue, 128);
    const openid = cleanText(openidValue, 128);
    const row = deliveryId
      ? openid
        ? this.db.prepare(`
            SELECT * FROM wechat_notification_deliveries WHERE delivery_id = ? AND openid = ?
          `).get(deliveryId, openid)
        : this.db.prepare("SELECT * FROM wechat_notification_deliveries WHERE delivery_id = ?").get(deliveryId)
      : null;
    return hydrateNotificationDelivery(row);
  }

  updateWechatNotificationDeliveryByProviderMessageId(providerValue, providerMessageIdValue, input = {}) {
    const provider = cleanText(providerValue, 40);
    const providerMessageId = cleanText(providerMessageIdValue, 128);
    if (!provider || !providerMessageId) return 0;
    const status = normalizeDeliveryStatus(input.status);
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE wechat_notification_deliveries SET
        status = ?, provider_status = ?, provider_code = ?, last_error = ?,
        delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
        failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END,
        updated_at = ?
      WHERE provider = ? AND provider_message_id = ?
    `).run(
      status,
      cleanText(input.providerStatus, 160) || status,
      Number(input.providerCode) || 0,
      status === "failed" ? cleanText(input.error || input.lastError, 160) : "",
      status,
      now,
      status,
      now,
      now,
      provider,
      providerMessageId
    );
    return Number(result.changes) || 0;
  }

  clear() {
    this.db.exec(`
      DELETE FROM app_users;
      DELETE FROM app_feedback;
      DELETE FROM app_device_covers;
      DELETE FROM app_foodcast_preferences;
      DELETE FROM app_meta;
      DELETE FROM wechat_device_subscriptions;
      DELETE FROM wechat_feeding_sources;
      DELETE FROM wechat_feeding_sessions;
      DELETE FROM wechat_notification_deliveries;
      DELETE FROM notification_preferences;
      DELETE FROM motion_alerts;
      DELETE FROM wechat_mini_subscription_grants;
      DELETE FROM wechat_official_bindings;
      DELETE FROM wxpusher_binding_challenges;
      DELETE FROM wxpusher_bindings;
      DELETE FROM pushplus_binding_challenges;
      DELETE FROM pushplus_bindings;
    `);
  }

  close() {
    this.db.close();
  }
}

module.exports = { AppDataStore };
