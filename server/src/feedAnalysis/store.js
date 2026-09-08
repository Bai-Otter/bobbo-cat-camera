const fs = require("fs");
const path = require("path");

const {
  buildDiaryFromClips,
  buildReplayMarkersFromClips,
  sanitizeAnalysisMarker,
  sanitizeFeedingActivity,
  sanitizeFeedingStats,
  sanitizeFeedingStateTimeline,
} = require("./model");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  DatabaseSync = null;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function defaultState() {
  return {
    settings: {
      openid: "",
      deviceSn: "",
      analysisEnabled: false,
      notifyEnabled: false,
      templateId: "",
      bowlRoi: null,
      bowlRoisByDevice: {},
      bowlConfidence: 0,
      lastScannedAt: 0,
      lastOfficialAlarmAt: 0,
      lastOfficialAlarmScanAt: 0,
      lastDeviceLogPosition: 0,
      lastDeviceLogScanAt: 0,
      deviceLogStatus: "idle",
      deviceLogError: "",
      lastAlarmCompensationAt: 0,
      feedingAnalyzedThroughMs: 0,
      feedingPendingFromMs: 0,
      feedingPendingThroughMs: 0,
      feedingStartState: "idle",
      feedingStartCandidateFromMs: 0,
      feedingStartCandidateThroughMs: 0,
      feedingStartLastAnalyzedThroughMs: 0,
      feedingStartLastAlarmAtMs: 0,
      feedingStartConfirmedAtMs: 0,
      feedingStartEventAtMs: 0,
      officialAlarmStatus: "idle",
      officialAlarmConfigNames: [],
      officialAlarmProfileVersion: 0,
      officialAlarmError: "",
      lastProcessedRecordingKey: "",
      officialConfigStatus: "idle",
      motionDeliveryEnabled: false,
      motionDeliveryStatus: "idle",
      motionDeliveryError: "",
      motionDeliveryCheckedAt: 0,
      lastMotionAlarmAt: 0,
      lastPetAlarmAt: 0,
      lastHumanAlarmAt: 0,
      officialAlarmSource: "none",
      officialAlarmCheckedAt: 0,
      updatedAt: 0,
    },
    recordings: {},
    settingsByDevice: {},
    pendingNotifications: [],
    pushPlusBindings: {},
    pushPlusChallenges: {},
  };
}

class FeedAnalysisStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.sqliteMode = /\.sqlite(?:3|db)?$/i.test(filePath || "");
    ensureDir(filePath);
    if (this.sqliteMode) {
      if (!DatabaseSync) throw new Error("SQLITE_UNAVAILABLE");
      this.db = new DatabaseSync(filePath);
      this.initSqlite();
      this.state = defaultState();
      this.migrateLegacyJsonIfEmpty();
      return;
    }
    this.state = this.load();
  }

  initSqlite() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recording_analysis (
        device_sn TEXT NOT NULL,
        date TEXT NOT NULL,
        recording_key TEXT NOT NULL,
        status TEXT NOT NULL,
        recording_json TEXT NOT NULL DEFAULT '{}',
        clip_json TEXT NOT NULL DEFAULT '{}',
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        material_sync_status TEXT NOT NULL DEFAULT 'pending',
        material_sync_attempts INTEGER NOT NULL DEFAULT 0,
        material_sync_error TEXT NOT NULL DEFAULT '',
        material_sync_updated_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (device_sn, recording_key)
      );
      CREATE INDEX IF NOT EXISTS idx_recording_analysis_date
        ON recording_analysis(device_sn, date, status);
      CREATE TABLE IF NOT EXISTS pushplus_binding (
        openid TEXT PRIMARY KEY,
        friend_token TEXT NOT NULL,
        friend_id TEXT NOT NULL DEFAULT '',
        is_follow INTEGER NOT NULL DEFAULT 0,
        nickname TEXT NOT NULL DEFAULT '',
        bound_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pushplus_binding_challenge (
        code TEXT PRIMARY KEY,
        openid TEXT NOT NULL,
        qr_code_url TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pushplus_binding_challenge_openid
        ON pushplus_binding_challenge(openid, expires_at);
    `);
    const recordingColumns = new Set(
      this.db.prepare("PRAGMA table_info(recording_analysis)").all().map((column) => column.name)
    );
    const materialColumns = [
      ["material_sync_status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["material_sync_attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["material_sync_error", "TEXT NOT NULL DEFAULT ''"],
      ["material_sync_updated_at", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of materialColumns) {
      if (!recordingColumns.has(name)) {
        this.db.exec(`ALTER TABLE recording_analysis ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  migrateLegacyJsonIfEmpty() {
    const settingsRow = this.db.prepare("SELECT value FROM settings WHERE key = ?").get("settings");
    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM recording_analysis").get();
    if (settingsRow || Number(countRow && countRow.count) > 0) return;
    const legacyPath = this.filePath.replace(/\.sqlite(?:3|db)?$/i, ".json");
    if (!legacyPath || legacyPath === this.filePath || !fs.existsSync(legacyPath)) return;
    let legacy = null;
    try {
      legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    } catch (error) {
      return;
    }
    if (legacy && legacy.settings) {
      this.updateSettings(legacy.settings);
    }
    const deviceSn = (legacy && legacy.settings && legacy.settings.deviceSn) || "";
    const recordings = legacy && legacy.recordings && typeof legacy.recordings === "object"
      ? Object.values(legacy.recordings)
      : [];
    for (const item of recordings) {
      if (!item || !item.recordingKey || !item.date || !item.clip) continue;
      this.upsertRecording({
        deviceSn,
        recordingKey: item.recordingKey,
        date: item.date,
        clip: item.clip,
      });
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) return defaultState();
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return { ...defaultState(), ...raw };
    } catch (error) {
      return defaultState();
    }
  }

  save() {
    if (this.sqliteMode) return;
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getSettings(deviceSn = "") {
    const sn = String(deviceSn || "").trim();
    if (this.sqliteMode) {
      const key = sn ? `settings:${sn}` : "settings";
      const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      if (row) return { ...defaultState().settings, ...JSON.parse(row.value) };
      if (sn) {
        const legacy = this.getSettings();
        if (legacy.deviceSn === sn) return legacy;
        return { ...defaultState().settings, deviceSn: sn };
      }
      return { ...defaultState().settings };
    }
    if (sn) {
      const stored = this.state.settingsByDevice && this.state.settingsByDevice[sn];
      if (stored) return { ...defaultState().settings, ...stored, deviceSn: sn };
      if (this.state.settings.deviceSn === sn) return { ...this.state.settings };
      return { ...defaultState().settings, deviceSn: sn };
    }
    return { ...this.state.settings };
  }

  updateSettings(patch, deviceSn = "") {
    const sn = String(deviceSn || "").trim();
    if (this.sqliteMode) {
      const next = {
        ...this.getSettings(sn),
        ...patch,
        ...(sn ? { deviceSn: sn } : {}),
        updatedAt: Date.now(),
      };
      this.db
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .run(sn ? `settings:${sn}` : "settings", JSON.stringify(next));
      return this.getSettings(sn);
    }
    if (sn) {
      this.state.settingsByDevice ||= {};
      this.state.settingsByDevice[sn] = {
        ...this.getSettings(sn),
        ...patch,
        deviceSn: sn,
        updatedAt: Date.now(),
      };
      this.save();
      return this.getSettings(sn);
    }
    this.state.settings = {
      ...this.state.settings,
      ...patch,
      updatedAt: Date.now(),
    };
    this.save();
    return this.getSettings();
  }

  getBowlRoi(deviceSn = "") {
    const sn = String(deviceSn || "").trim();
    if (!sn) return null;
    const settings = this.getSettings(sn);
    const configured = settings.bowlRoisByDevice?.[sn];
    if (configured) return { ...configured };
    if (settings.deviceSn === sn && settings.bowlRoi) return { ...settings.bowlRoi };
    return null;
  }

  setBowlRoi(deviceSn, bowlRoi) {
    const sn = String(deviceSn || "").trim();
    if (!sn) throw new Error("DEVICE_SN_REQUIRED");
    const settings = this.getSettings(sn);
    const bowlRoisByDevice = { ...(settings.bowlRoisByDevice || {}) };
    if (bowlRoi) bowlRoisByDevice[sn] = { ...bowlRoi };
    else delete bowlRoisByDevice[sn];
    const patch = { bowlRoisByDevice };
    if (settings.deviceSn === sn) patch.bowlRoi = bowlRoi ? { ...bowlRoi } : null;
    return this.updateSettings(patch, sn);
  }

  savePushPlusBindingChallenge({ openid = "", code = "", qrCodeUrl = "", expiresAt = 0 } = {}) {
    const item = {
      openid: String(openid),
      code: String(code),
      qrCodeUrl: String(qrCodeUrl),
      expiresAt: Number(expiresAt) || 0,
      createdAt: Date.now(),
    };
    if (this.sqliteMode) {
      this.db.prepare("DELETE FROM pushplus_binding_challenge WHERE openid = ?").run(item.openid);
      this.db.prepare(`
        INSERT INTO pushplus_binding_challenge (code, openid, qr_code_url, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(item.code, item.openid, item.qrCodeUrl, item.expiresAt, item.createdAt);
      return item;
    }
    this.state.pushPlusChallenges[item.openid] = item;
    this.save();
    return item;
  }

  getActivePushPlusBindingChallenge(openid, now = Date.now()) {
    if (this.sqliteMode) {
      const row = this.db.prepare(`
        SELECT code, openid, qr_code_url, expires_at, created_at
        FROM pushplus_binding_challenge
        WHERE openid = ? AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1
      `).get(String(openid), Number(now));
      return row ? mapPushPlusChallengeRow(row) : null;
    }
    const item = this.state.pushPlusChallenges[String(openid)];
    return item && item.expiresAt > Number(now) ? { ...item } : null;
  }

  getPushPlusBindingChallengeByCode(code, now = Date.now()) {
    if (this.sqliteMode) {
      const row = this.db.prepare(`
        SELECT code, openid, qr_code_url, expires_at, created_at
        FROM pushplus_binding_challenge
        WHERE code = ? AND expires_at > ? LIMIT 1
      `).get(String(code), Number(now));
      return row ? mapPushPlusChallengeRow(row) : null;
    }
    const item = Object.values(this.state.pushPlusChallenges)
      .find((candidate) => candidate.code === String(code) && candidate.expiresAt > Number(now));
    return item ? { ...item } : null;
  }

  completePushPlusBinding(code, friendInfo = {}) {
    const challenge = this.getPushPlusBindingChallengeByCode(code, Date.now());
    if (!challenge || !friendInfo.token) return null;
    const now = Date.now();
    const binding = {
      openid: challenge.openid,
      friendToken: String(friendInfo.token),
      friendId: String(friendInfo.friendId || ""),
      isFollow: Number(friendInfo.isFollow) === 1,
      nickname: String(friendInfo.nickName || "").slice(0, 80),
      boundAt: now,
      updatedAt: now,
    };
    this.savePushPlusBinding(binding);
    if (this.sqliteMode) {
      this.db.prepare("DELETE FROM pushplus_binding_challenge WHERE code = ?").run(String(code));
    } else {
      delete this.state.pushPlusChallenges[binding.openid];
      this.save();
    }
    return binding;
  }

  savePushPlusBinding(binding = {}) {
    const normalized = {
      openid: String(binding.openid || "").trim(),
      friendToken: String(binding.friendToken || "").trim(),
      friendId: String(binding.friendId || ""),
      isFollow: !!binding.isFollow,
      nickname: String(binding.nickname || "").slice(0, 80),
      boundAt: Number(binding.boundAt) || Date.now(),
      updatedAt: Number(binding.updatedAt) || Date.now(),
    };
    if (!normalized.openid || !normalized.friendToken) return null;
    if (this.sqliteMode) {
      this.db.prepare(`
        INSERT INTO pushplus_binding (
          openid, friend_token, friend_id, is_follow, nickname, bound_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(openid) DO UPDATE SET
          friend_token = excluded.friend_token,
          friend_id = excluded.friend_id,
          is_follow = excluded.is_follow,
          nickname = excluded.nickname,
          updated_at = excluded.updated_at
      `).run(
        normalized.openid,
        normalized.friendToken,
        normalized.friendId,
        normalized.isFollow ? 1 : 0,
        normalized.nickname,
        normalized.boundAt,
        normalized.updatedAt
      );
      return normalized;
    }
    this.state.pushPlusBindings[normalized.openid] = normalized;
    this.save();
    return normalized;
  }

  getPushPlusBinding(openid) {
    if (this.sqliteMode) {
      const row = this.db.prepare(`
        SELECT openid, friend_token, friend_id, is_follow, nickname, bound_at, updated_at
        FROM pushplus_binding WHERE openid = ? LIMIT 1
      `).get(String(openid));
      return row ? mapPushPlusBindingRow(row) : null;
    }
    const item = this.state.pushPlusBindings[String(openid)];
    return item ? { ...item } : null;
  }

  hasProcessed(recordingKey, deviceSn = "") {
    if (this.sqliteMode) {
      const row = deviceSn
        ? this.db
            .prepare("SELECT status FROM recording_analysis WHERE device_sn = ? AND recording_key = ? AND status = 'ready' LIMIT 1")
            .get(deviceSn, recordingKey)
        : this.db
            .prepare("SELECT status FROM recording_analysis WHERE recording_key = ? AND status = 'ready' LIMIT 1")
            .get(recordingKey);
      return !!row;
    }
    return !!this.state.recordings[recordingKey];
  }

  upsertRecording({ deviceSn: inputDeviceSn = "", recordingKey, date, clip }) {
    if (!clip || typeof clip !== "object" || Array.isArray(clip)) {
      throw new Error("RECORDING_CLIP_INVALID");
    }
    if (this.sqliteMode) {
      const deviceSn = inputDeviceSn || this.getSettings().deviceSn || "";
      const sanitizedClip = sanitizeClip(clip);
      this.db
        .prepare(`
          INSERT INTO recording_analysis (
            device_sn, date, recording_key, status, recording_json, clip_json,
            failure_count, last_error, updated_at
          )
          VALUES (?, ?, ?, 'ready', '{}', ?, 0, '', ?)
          ON CONFLICT(device_sn, recording_key) DO UPDATE SET
            date = excluded.date,
            status = 'ready',
            clip_json = excluded.clip_json,
            material_sync_status = 'pending',
            material_sync_attempts = 0,
            material_sync_error = '',
            material_sync_updated_at = excluded.updated_at,
            failure_count = 0,
            last_error = '',
            updated_at = excluded.updated_at
        `)
        .run(deviceSn, date, recordingKey, JSON.stringify(sanitizedClip), Date.now());
      this.updateSettings({
        deviceSn,
        lastProcessedRecordingKey: recordingKey,
        lastScannedAt: Date.now(),
      });
      return;
    }
    const sanitizedClip = sanitizeClip(clip);
    this.state.recordings[recordingKey] = {
      recordingKey,
      date,
      clip: sanitizedClip,
      updatedAt: Date.now(),
    };
    this.state.settings.lastProcessedRecordingKey = recordingKey;
    this.state.settings.lastScannedAt = Date.now();
    this.refreshDerivedState(date);
    this.save();
  }

  refreshDerivedState(date) {
    const clips = Object.values(this.state.recordings)
      .filter(
        (item) =>
          item &&
          item.date === date &&
          item.clip &&
          typeof item.clip === "object" &&
          !Array.isArray(item.clip)
      )
      .map((item) => sanitizeClip(item.clip));
    const diary = buildDiaryFromClips({
      deviceSn: this.state.settings.deviceSn,
      date,
      clips,
      activityHistory: this.getActivityHistory(this.state.settings.deviceSn, date),
    });
    const markers = buildReplayMarkersFromClips(diary.clips);
    this.state[`diary:${date}`] = diary;
    this.state[`markers:${date}`] = markers;
    // Derived diary refreshes are used by historical scans and retries too.
    // Notification delivery is intentionally owned by the realtime-alarm
    // confirmation path in the coordinator, never by derived-state rebuilds.
  }

  enqueueFeedingNotification(payload = {}) {
    if (!payload.eventId) return null;
    const existing = this.state.pendingNotifications.find((item) => item.eventId === payload.eventId);
    if (existing) return existing;
    const startTime = payload.startTime || "";
    const item = {
      eventId: payload.eventId,
      markerType: payload.markerType || "feeding_start",
      date: payload.date || "",
      clipId: payload.clipId || "",
      title: payload.title || "\u732b\u54aa\u6765\u5403\u996d\u4e86",
      message: payload.message || "\u68c0\u6d4b\u5230\u732b\u54aa\u5f00\u59cb\u8fdb\u98df",
      startTime,
      endTime: payload.endTime || startTime,
      snapshotUrl: payload.snapshotUrl || "",
      alarmId: payload.alarmId || "",
      createdAt: Date.now(),
      sentAt: null,
    };
    this.state.pendingNotifications.push(item);
    this.save();
    return item;
  }

  getDiary(date, deviceSn = "") {
    if (this.sqliteMode) {
      const clips = this.getClipsForDate(deviceSn, date);
      return buildDiaryFromClips({
        deviceSn: deviceSn || this.getSettings().deviceSn,
        date,
        clips,
        activityHistory: this.getActivityHistory(deviceSn, date),
      });
    }
    const diary = this.state[`diary:${date}`];
    if (!diary || typeof diary !== "object" || Array.isArray(diary)) return null;
    const clips = Array.isArray(diary.clips)
      ? diary.clips
          .filter((clip) => clip && typeof clip === "object" && !Array.isArray(clip))
          .map(sanitizeClip)
      : [];
    return { ...diary, clips };
  }

  getActivityHistory(deviceSn = "", beforeDate = "", limit = 14) {
    const safeLimit = Math.max(1, Math.min(14, Math.floor(Number(limit) || 14)));
    if (this.sqliteMode) {
      const rows = this.db.prepare(`
        SELECT DISTINCT date FROM recording_analysis
        WHERE device_sn = ? AND date < ? AND status = 'ready'
        ORDER BY date DESC
      `).all(String(deviceSn || ""), String(beforeDate || ""));
      const history = [];
      for (const row of rows) {
        const diary = buildDiaryFromClips({
          deviceSn,
          date: row.date,
          clips: this.getClipsForDate(deviceSn, row.date),
        });
        if (diary.activityMetric) history.push({ date: row.date, ...diary.activityMetric });
        if (history.length >= safeLimit) break;
      }
      return history.reverse();
    }
    return Object.entries(this.state)
      .filter(([key, value]) => key.startsWith("diary:")
        && value && typeof value === "object" && !Array.isArray(value)
        && String(value.date || key.slice(6)) < String(beforeDate || "")
        && (!deviceSn || !value.deviceSn || value.deviceSn === deviceSn)
        && value.activityMetric)
      .map(([key, value]) => ({ date: value.date || key.slice(6), ...value.activityMetric }))
      .sort((left, right) => String(left.date).localeCompare(String(right.date)))
      .slice(-safeLimit);
  }

  getReplayMarkers(date, deviceSn = "") {
    if (this.sqliteMode) {
      const clips = this.getClipsForDate(deviceSn, date);
      return buildReplayMarkersFromClips(clips);
    }
    const diary = this.state[`diary:${date}`];
    if (diary && typeof diary === "object" && !Array.isArray(diary) && Array.isArray(diary.clips)) {
      const clips = diary.clips
        .filter((clip) => clip && typeof clip === "object" && !Array.isArray(clip))
        .map(sanitizeClip);
      if (clips.length) return buildReplayMarkersFromClips(clips);
    }
    const markers = this.state[`markers:${date}`];
    return Array.isArray(markers)
      ? markers
          .filter((marker) => marker && typeof marker === "object" && !Array.isArray(marker))
          .map(sanitizeMarker)
      : [];
  }

  listPendingNotifications() {
    return this.state.pendingNotifications.filter((item) => !item.sentAt);
  }

  ackNotifications(eventIds = []) {
    const ids = new Set(eventIds);
    this.state.pendingNotifications = this.state.pendingNotifications.map((item) =>
      ids.has(item.eventId) ? { ...item, sentAt: Date.now() } : item
    );
    this.save();
  }

  markRecordingQueued({ deviceSn = "", date = "", recordingKey = "", recording = {}, force = false } = {}) {
    if (!this.sqliteMode) return false;
    const existing = this.db
      .prepare("SELECT status FROM recording_analysis WHERE device_sn = ? AND recording_key = ?")
      .get(deviceSn, recordingKey);
    if (!force && ["failed", "running"].includes(existing?.status)) return false;
    this.db
      .prepare(`
        INSERT INTO recording_analysis (
          device_sn, date, recording_key, status, recording_json, clip_json,
          failure_count, last_error, updated_at
        )
        VALUES (?, ?, ?, 'queued', ?, '{}', 0, '', ?)
        ON CONFLICT(device_sn, recording_key) DO UPDATE SET
          date = excluded.date,
          status = CASE
            WHEN ? = 1 THEN 'queued'
            WHEN recording_analysis.status = 'ready' THEN 'ready'
            ELSE 'queued'
          END,
          recording_json = excluded.recording_json,
          updated_at = excluded.updated_at
      `)
      .run(deviceSn, date, recordingKey, JSON.stringify(sanitizeRecording(recording)), Date.now(), force ? 1 : 0);
    return true;
  }

  recoverInterruptedRecordings() {
    if (!this.sqliteMode) return 0;
    const result = this.db
      .prepare(`
        UPDATE recording_analysis
        SET status = 'queued', updated_at = ?
        WHERE status = 'running'
      `)
      .run(Date.now());
    return Number(result.changes) || 0;
  }

  markRecordingRunning({ deviceSn = "", recordingKey = "" } = {}) {
    if (!this.sqliteMode) return;
    this.db
      .prepare(`
        UPDATE recording_analysis
        SET status = 'running', updated_at = ?
        WHERE device_sn = ? AND recording_key = ? AND status != 'ready'
      `)
      .run(Date.now(), deviceSn, recordingKey);
  }

  markRecordingFailed({ deviceSn = "", recordingKey = "", error = "" } = {}) {
    if (!this.sqliteMode) return;
    this.db
      .prepare(`
        UPDATE recording_analysis
        SET status = CASE WHEN status = 'ready' THEN 'ready' ELSE 'failed' END,
            failure_count = failure_count + 1,
            last_error = ?,
            updated_at = ?
        WHERE device_sn = ? AND recording_key = ?
      `)
      .run(String(error && error.message ? error.message : error).slice(0, 1000), Date.now(), deviceSn, recordingKey);
  }

  markMaterialSyncRunning({ deviceSn = "", recordingKey = "" } = {}) {
    if (!this.sqliteMode) return;
    this.db.prepare(`
      UPDATE recording_analysis
      SET material_sync_status = 'running', material_sync_updated_at = ?
      WHERE device_sn = ? AND recording_key = ? AND status = 'ready'
    `).run(Date.now(), deviceSn, recordingKey);
  }

  markMaterialSyncReady({ deviceSn = "", recordingKey = "" } = {}) {
    if (!this.sqliteMode) return;
    this.db.prepare(`
      UPDATE recording_analysis
      SET material_sync_status = 'ready', material_sync_error = '', material_sync_updated_at = ?
      WHERE device_sn = ? AND recording_key = ? AND status = 'ready'
    `).run(Date.now(), deviceSn, recordingKey);
  }

  markMaterialSyncFailed({ deviceSn = "", recordingKey = "", error = "" } = {}) {
    if (!this.sqliteMode) return;
    this.db.prepare(`
      UPDATE recording_analysis
      SET material_sync_status = 'failed',
          material_sync_attempts = material_sync_attempts + 1,
          material_sync_error = ?, material_sync_updated_at = ?
      WHERE device_sn = ? AND recording_key = ? AND status = 'ready'
    `).run(String(error && error.message ? error.message : error).slice(0, 1000), Date.now(), deviceSn, recordingKey);
  }

  listPendingMaterialSync(maxAttempts = 10) {
    if (!this.sqliteMode) return [];
    return this.db.prepare(`
      SELECT device_sn, date, recording_key, recording_json, clip_json,
             material_sync_status, material_sync_attempts, material_sync_error
      FROM recording_analysis
      WHERE status = 'ready'
        AND material_sync_status IN ('pending', 'running', 'failed')
        AND material_sync_attempts < ?
      ORDER BY material_sync_updated_at, recording_key
    `).all(Math.max(1, Number(maxAttempts) || 10)).map((row) => ({
      deviceSn: row.device_sn,
      date: row.date,
      recordingKey: row.recording_key,
      recording: sanitizeRecording(JSON.parse(row.recording_json || "{}")),
      clip: sanitizeClip(JSON.parse(row.clip_json || "{}")),
      materialSyncStatus: row.material_sync_status,
      materialSyncAttempts: Number(row.material_sync_attempts) || 0,
      materialSyncError: row.material_sync_error || "",
    }));
  }

  clearAnalysisForDate(deviceSn = "", date = "") {
    if (!this.sqliteMode) return { deleted: 0 };
    const result = this.db
      .prepare("DELETE FROM recording_analysis WHERE device_sn = ? AND date = ?")
      .run(String(deviceSn || ""), String(date || ""));
    return { deleted: Number(result.changes) || 0 };
  }

  getAnalysisStatus(deviceSn = "", date = "") {
    if (!this.sqliteMode) return [];
    return this.db
      .prepare(`
        SELECT device_sn, date, recording_key, status, failure_count, last_error, updated_at
        FROM recording_analysis
        WHERE device_sn = ? AND date = ?
        ORDER BY recording_key
      `)
      .all(deviceSn, date)
      .map((row) => ({
        deviceSn: row.device_sn,
        date: row.date,
        recordingKey: row.recording_key,
        status: row.status,
        failureCount: Number(row.failure_count) || 0,
        lastError: row.last_error || "",
        updatedAt: Number(row.updated_at) || 0,
      }));
  }

  getClipsForDate(deviceSn = "", date = "") {
    if (!this.sqliteMode) return [];
    const sql = deviceSn
      ? `
        SELECT clip_json FROM recording_analysis
        WHERE device_sn = ? AND date = ? AND status = 'ready'
        ORDER BY recording_key
      `
      : `
        SELECT clip_json FROM recording_analysis
        WHERE date = ? AND status = 'ready'
        ORDER BY recording_key
      `;
    const rows = deviceSn
      ? this.db.prepare(sql).all(deviceSn, date)
      : this.db.prepare(sql).all(date);
    return rows
      .map((row) => {
        try {
          const clip = JSON.parse(row.clip_json || "{}");
          if (!clip || typeof clip !== "object" || Array.isArray(clip)) return null;
          return sanitizeClip(clip);
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);
  }

  getAnalysisRecord(deviceSn = "", recordingKey = "") {
    if (!this.sqliteMode) return null;
    const row = this.db.prepare(`
      SELECT device_sn, date, recording_key, status, recording_json, clip_json,
             failure_count, last_error, material_sync_status, material_sync_attempts,
             material_sync_error, material_sync_updated_at, updated_at
      FROM recording_analysis WHERE device_sn = ? AND recording_key = ? LIMIT 1
    `).get(String(deviceSn), String(recordingKey));
    if (!row) return null;
    return {
      deviceSn: row.device_sn, date: row.date, recordingKey: row.recording_key,
      status: row.status,
      recording: sanitizeRecording(JSON.parse(row.recording_json || "{}")),
      clip: sanitizeClip(JSON.parse(row.clip_json || "{}")),
      failureCount: Number(row.failure_count) || 0, lastError: row.last_error || "",
      materialSyncStatus: row.material_sync_status || "pending",
      materialSyncAttempts: Number(row.material_sync_attempts) || 0,
      materialSyncError: row.material_sync_error || "",
      materialSyncUpdatedAt: Number(row.material_sync_updated_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
    };
  }

  restoreAnalysisRecords(records = []) {
    if (!this.sqliteMode) return 0;
    let restored = 0;
    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO recording_analysis (
        device_sn, date, recording_key, status, recording_json, clip_json,
        failure_count, last_error, material_sync_status, material_sync_attempts,
        material_sync_error, material_sync_updated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of records) {
      if (!item?.deviceSn || !item?.recordingKey) continue;
      statement.run(
        item.deviceSn, item.date || "", item.recordingKey,
        item.status === "running" ? "queued" : item.status,
        JSON.stringify(sanitizeRecording(item.recording || {})),
        JSON.stringify(sanitizeClip(item.clip || {})),
        Number(item.failureCount) || 0, String(item.lastError || "").slice(0, 1000),
        item.materialSyncStatus || "pending", Number(item.materialSyncAttempts) || 0,
        String(item.materialSyncError || "").slice(0, 1000),
        Number(item.materialSyncUpdatedAt) || 0, Number(item.updatedAt) || Date.now()
      );
      restored += 1;
    }
    return restored;
  }
}

module.exports = { FeedAnalysisStore };

function mapPushPlusChallengeRow(row) {
  return {
    code: row.code,
    openid: row.openid,
    qrCodeUrl: row.qr_code_url,
    expiresAt: Number(row.expires_at) || 0,
    createdAt: Number(row.created_at) || 0,
  };
}

function mapPushPlusBindingRow(row) {
  return {
    openid: row.openid,
    friendToken: row.friend_token,
    friendId: row.friend_id,
    isFollow: Number(row.is_follow) === 1,
    nickname: row.nickname,
    boundAt: Number(row.bound_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function sanitizeRecording(recording = {}) {
  return {
    BeginTime: recording.BeginTime || recording.beginTime || recording.startTime || "",
    EndTime: recording.EndTime || recording.endTime || "",
    FileName: recording.FileName || recording.fileName || "",
    beginTime: recording.beginTime || recording.BeginTime || recording.startTime || "",
    endTime: recording.endTime || recording.EndTime || "",
    fileName: recording.fileName || recording.FileName || "",
    durationSec: Number(recording.durationSec) || 0,
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boundedScore(value) {
  return Math.max(0, Math.min(1, finiteNumber(value)));
}

function normalizeCuteReasons(value) {
  const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return [...new Set(candidates.filter((reason) => typeof reason === "string"))];
}

function stringScalar(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function sanitizeCuteTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const base = {
      offsetSec: finiteNumber(item.offsetSec),
      cuteScore: boundedScore(item.cuteScore),
      modelConfidence: boundedScore(item.modelConfidence),
      cuteReasons: normalizeCuteReasons(item.cuteReasons),
      hasCat: typeof item.hasCat === "boolean" ? item.hasCat : false,
      };
      if (!Object.prototype.hasOwnProperty.call(item, "faceRelation")) return base;
      return {
        ...base,
        faceRelation: typeof item.faceRelation === "string" ? item.faceRelation : "unknown",
        relationConfidence: boundedScore(item.relationConfidence),
        strictEligible: item.strictEligible === true,
        looseEligible: item.looseEligible === true,
        sizeScore: boundedScore(item.sizeScore),
        cameraScore: boundedScore(item.cameraScore),
        pitchScore: boundedScore(item.pitchScore),
        visibilityScore: boundedScore(item.visibilityScore),
      };
    });
}

function sanitizeMarker(marker = {}) {
  const sanitized = sanitizeAnalysisMarker(marker);
  const playbackParams = marker.playbackParams;
  return {
    ...sanitized,
    playbackParams: playbackParams && typeof playbackParams === "object" && !Array.isArray(playbackParams)
      ? {
          startTime: stringScalar(playbackParams.startTime),
          endTime: stringScalar(playbackParams.endTime),
          fileName: stringScalar(playbackParams.fileName),
          targetSec: finiteNumber(playbackParams.targetSec),
        }
      : undefined,
  };
}

function booleanScalar(value) {
  return typeof value === "boolean" ? value : false;
}

function sanitizeBowlRoi(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = ["x", "y", "width", "height"];
  if (!fields.every((field) => typeof value[field] === "number" && Number.isFinite(value[field]))) {
    return null;
  }
  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}

function sanitizeClip(clip = {}) {
  const playbackParams = clip.playbackParams;
  const structuredFeedingFact = clip.dataKind === "feeding_fact";
  const sanitized = {
    ...(structuredFeedingFact ? { dataKind: "feeding_fact" } : {}),
    id: stringScalar(clip.id),
    recordingKey: stringScalar(clip.recordingKey),
    beginTime: stringScalar(clip.beginTime),
    endTime: stringScalar(clip.endTime),
    durationSec: finiteNumber(clip.durationSec),
    catId: typeof clip.catId === "string" && clip.catId ? clip.catId : null,
    isEffective: booleanScalar(clip.isEffective),
    hasCat: booleanScalar(clip.hasCat),
    hasFeeding: booleanScalar(clip.hasFeeding),
    analysisConfidence: boundedScore(clip.analysisConfidence),
    bowlRoi: sanitizeBowlRoi(clip.bowlRoi),
    markers: Array.isArray(clip.markers)
      ? clip.markers
          .filter((marker) => marker && typeof marker === "object" && !Array.isArray(marker))
          .map(sanitizeMarker)
      : [],
    feedingStateTimeline: sanitizeFeedingStateTimeline(clip.feedingStateTimeline),
    feedingActivity: sanitizeFeedingActivity(clip.feedingActivity),
    feedingStats: sanitizeFeedingStats(clip.feedingStats),
    analysisUpdatedAt: Math.max(0, finiteNumber(clip.analysisUpdatedAt)),
  };
  if (Object.prototype.hasOwnProperty.call(clip, "fileName")) {
    sanitized.fileName = stringScalar(clip.fileName);
  }
  if (Object.prototype.hasOwnProperty.call(clip, "title")) {
    sanitized.title = stringScalar(clip.title);
  }
  if (Object.prototype.hasOwnProperty.call(clip, "time")) {
    sanitized.time = stringScalar(clip.time);
  }
  if (Object.prototype.hasOwnProperty.call(clip, "cover")) {
    sanitized.cover = stringScalar(clip.cover);
  }
  if (!structuredFeedingFact || Object.prototype.hasOwnProperty.call(clip, "cuteTimeline")) {
    sanitized.cuteTimeline = sanitizeCuteTimeline(clip.cuteTimeline);
  }
  if (playbackParams && typeof playbackParams === "object" && !Array.isArray(playbackParams)) {
    sanitized.playbackParams = {
      startTime: stringScalar(playbackParams.startTime),
      endTime: stringScalar(playbackParams.endTime),
      fileName: stringScalar(playbackParams.fileName),
    };
  }
  return sanitized;
}
