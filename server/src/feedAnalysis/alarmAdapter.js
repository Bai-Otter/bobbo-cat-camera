const {
  formatDeviceDateTime,
  parseDeviceDateTime,
} = require("./deviceTime");

function formatLocalDateTime(date) {
  return formatDeviceDateTime(date);
}

function parseLocalTime(value) {
  return parseDeviceDateTime(value);
}

function dateRange(dateValue) {
  const date = String(dateValue || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    beginTime: `${date} 00:00:00`,
    endTime: `${date} 23:59:59`,
  };
}

function alarmTimeOf(alarm = {}) {
  return (
    alarm.AlarmTime ||
    alarm.alarmTime ||
    alarm.Time ||
    alarm.time ||
    alarm.BeginTime ||
    alarm.beginTime ||
    alarm.startTime ||
    alarm.occurTime ||
    alarm.timestamp ||
    ""
  );
}

function buildAlarmScanWindows(alarms = [], { paddingSeconds = 5 * 60 } = {}) {
  const paddingMs = Math.max(0, Number(paddingSeconds) || 0) * 1000;
  return alarms
    .map((alarm) => {
      const alarmAt = parseLocalTime(alarmTimeOf(alarm));
      if (!alarmAt) return null;
      const begin = new Date(alarmAt.getTime() - paddingMs);
      const end = new Date(alarmAt.getTime() + paddingMs);
      return {
        date: formatLocalDateTime(alarmAt).slice(0, 10),
        beginTime: formatLocalDateTime(begin),
        endTime: formatLocalDateTime(end),
        alarm,
      };
    })
    .filter(Boolean);
}

class AlarmScanAdapter {
  constructor({ paddingSeconds = 5 * 60, timeoutMs = 3000 } = {}) {
    this.paddingSeconds = paddingSeconds;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 3000);
  }

  async fetchWindows(device, { date = "" } = {}) {
    if (!device || typeof device.getDeviceAlarmList !== "function") return [];
    const range = dateRange(date);
    if (!range) return [];
    try {
      const alarms = await withTimeout(
        device.getDeviceAlarmList(range),
        this.timeoutMs
      );
      return buildAlarmScanWindows(alarms, { paddingSeconds: this.paddingSeconds });
    } catch (error) {
      return [];
    }
  }
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("ALARM_API_TIMEOUT"));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

module.exports = {
  AlarmScanAdapter,
  buildAlarmScanWindows,
};
