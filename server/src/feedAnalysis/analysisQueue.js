function taskKey(task = {}) {
  if (task.recordingKey) return `${task.deviceSn || ""}:recording:${task.recordingKey}`;
  return `${task.deviceSn || ""}:date:${task.date || ""}`;
}

function failureCategory(error = "") {
  const message = String(error).toUpperCase();
  if (/DEVICE|TOKEN|LOGIN|AUTH|SESSION/.test(message)) return "device_auth";
  if (/PLAYBACK|RECORD|HLS|RTSP|MEDIA|SOURCE|DOWNLOAD|FETCH|FFMPEG|HTTP/.test(message)) return "media_source";
  if (/TIMEOUT|TIMED OUT|ETIMEDOUT/.test(message)) return "timeout";
  if (/VISION|ANALYSIS|MODEL|DETECT/.test(message)) return "vision";
  return "other";
}

function safeFailureCode(error = "") {
  const message = String(error).trim();
  return /^[A-Z][A-Z0-9_:-]{0,79}$/.test(message) ? message : "REDACTED_ERROR";
}

class AnalysisQueue {
  constructor({ globalConcurrency = 2, processTask, logger = console, nowProvider } = {}) {
    this.globalConcurrency = Math.max(1, Number(globalConcurrency) || 2);
    this.processTask =
      typeof processTask === "function"
        ? processTask
        : async () => {};
    this.logger = logger;
    this.nowProvider = typeof nowProvider === "function" ? nowProvider : () => Date.now();
    this.pending = [];
    this.knownKeys = new Set();
    this.runningDevices = new Set();
    this.runningTasks = new Map();
    this.completions = new Map();
    this.runningCount = 0;
    this.idleResolvers = [];
    this.outcomes = {
      accepted: 0,
      coalesced: 0,
      completed: 0,
      failed: 0,
      preempted: 0,
    };
    this.recentFailures = [];
  }

  enqueueRecording(task = {}) {
    const normalized = {
      ...task,
      deviceSn: String(task.deviceSn || ""),
      date: String(task.date || ""),
      recordingKey: String(task.recordingKey || ""),
      reason: task.reason || "recording",
      priority: Number.isFinite(Number(task.priority)) ? Number(task.priority) : 0,
    };
    const key = taskKey(normalized);
    if (this.knownKeys.has(key)) {
      const pendingTask = this.pending.find((item) => item.jobKey === key);
      if (pendingTask && normalized.priority > pendingTask.priority) {
        pendingTask.priority = normalized.priority;
        pendingTask.reason = normalized.reason;
        this.pending.sort((left, right) => right.priority - left.priority);
      }
      this.outcomes.coalesced += 1;
      return {
        ok: true,
        queued: false,
        jobKey: key,
        completion: this.completions.get(key)?.promise || Promise.resolve({ ok: true, coalesced: true }),
      };
    }
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    this.knownKeys.add(key);
    this.completions.set(key, { promise: completion, resolve: resolveCompletion });
    this.outcomes.accepted += 1;
    this.pending.push({ ...normalized, jobKey: key, queuedAt: this.nowProvider() });
    this.pending.sort((left, right) => right.priority - left.priority);
    this.preemptFor(normalized);
    this.pump();
    return { ok: true, queued: true, jobKey: key, completion };
  }

  preemptFor(incoming = {}) {
    if (this.runningCount < this.globalConcurrency) return false;
    const incomingPriority = Number(incoming.priority) || 0;
    if (incomingPriority < 100) return false;
    const candidates = [...this.runningTasks.entries()]
      .filter(([, task]) => Number(task.priority) < incomingPriority && !task.preemptRequested)
      .sort((left, right) => {
        const leftSameDevice = left[1].deviceSn === incoming.deviceSn ? 1 : 0;
        const rightSameDevice = right[1].deviceSn === incoming.deviceSn ? 1 : 0;
        if (leftSameDevice !== rightSameDevice) return rightSameDevice - leftSameDevice;
        return left[1].startedAt - right[1].startedAt;
      });
    const candidate = candidates[0];
    if (!candidate) return false;
    candidate[1].preemptRequested = true;
    candidate[1].controller.abort("higher-priority-task");
    this.outcomes.preempted += 1;
    this.logger?.info?.("[feed-analysis] lower-priority task preempted", {
      deviceSn: candidate[1].deviceSn,
      jobKey: candidate[0],
      incomingDeviceSn: incoming.deviceSn,
      incomingPriority,
    });
    return true;
  }

  enqueueDeviceDate(task = {}) {
    return this.enqueueRecording({
      ...task,
      recordingKey: "",
      reason: task.reason || "scan",
    });
  }

  pump() {
    while (this.runningCount < this.globalConcurrency) {
      const index = this.pending.findIndex((task) => !this.runningDevices.has(task.deviceSn));
      if (index < 0) break;
      const [task] = this.pending.splice(index, 1);
      this.runTask(task);
    }
    this.resolveIdleIfNeeded();
  }

  runTask(task) {
    const controller = new AbortController();
    task.signal = controller.signal;
    this.runningCount += 1;
    this.runningDevices.add(task.deviceSn);
    this.runningTasks.set(task.jobKey, {
      deviceSn: task.deviceSn,
      kind: task.recordingKey ? "recording" : "scan",
      queuedAt: task.queuedAt,
      startedAt: this.nowProvider(),
      priority: task.priority,
      controller,
      preemptRequested: false,
    });
    let failed = false;
    let result;
    let failureMessage = "";
    Promise.resolve()
      .then(() => this.processTask(task))
      .then((taskResult) => {
        result = taskResult;
        if (taskResult && taskResult.ok === false && !taskResult.deferred) {
          failed = true;
          failureMessage = taskResult.error || "TASK_UNSUCCESSFUL";
          this.logTaskFailure(task, failureMessage);
        }
      })
      .catch((error) => {
        failed = true;
        failureMessage = error?.message || String(error || "UNKNOWN_ERROR");
        this.logTaskFailure(task, failureMessage);
      })
      .finally(() => {
        this.runningCount -= 1;
        this.runningDevices.delete(task.deviceSn);
        this.runningTasks.delete(task.jobKey);
        this.knownKeys.delete(task.jobKey);
        const completion = this.completions.get(task.jobKey);
        completion?.resolve({ ok: !failed, result, error: failureMessage });
        this.completions.delete(task.jobKey);
        this.outcomes.completed += 1;
        if (failed) this.outcomes.failed += 1;
        this.pump();
      });
  }

  logTaskFailure(task, error) {
    this.recentFailures.push({
      deviceSn: task.deviceSn,
      kind: task.recordingKey ? "recording" : "scan",
      category: failureCategory(error),
      code: safeFailureCode(error),
    });
    this.recentFailures = this.recentFailures.slice(-10);
    this.logger?.error?.("[feed-analysis] queue task failed", {
      deviceSn: task.deviceSn,
      jobKey: task.jobKey,
      error,
    });
  }

  onIdle() {
    if (this.pending.length === 0 && this.runningCount === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  getCompletion(jobKey = "") {
    return this.completions.get(String(jobKey || ""))?.promise || null;
  }

  resolveIdleIfNeeded() {
    if (this.pending.length !== 0 || this.runningCount !== 0) return;
    const resolvers = this.idleResolvers.splice(0);
    resolvers.forEach((resolve) => resolve());
  }

  getStatus({ deviceSn = "" } = {}) {
    const now = this.nowProvider();
    const byKind = {
      scan: { pending: 0, running: 0 },
      recording: { pending: 0, running: 0 },
    };
    let oldestPendingAt = 0;
    let longestRunningAt = 0;
    let activeDevicePending = 0;
    let activeDeviceRunning = false;
    for (const task of this.pending) {
      const kind = task.recordingKey ? "recording" : "scan";
      byKind[kind].pending += 1;
      if (!oldestPendingAt || task.queuedAt < oldestPendingAt) oldestPendingAt = task.queuedAt;
      if (deviceSn && task.deviceSn === deviceSn) activeDevicePending += 1;
    }
    for (const task of this.runningTasks.values()) {
      byKind[task.kind].running += 1;
      if (!longestRunningAt || task.startedAt < longestRunningAt) longestRunningAt = task.startedAt;
      if (deviceSn && task.deviceSn === deviceSn) activeDeviceRunning = true;
    }
    const status = {
      pending: this.pending.length,
      running: this.runningCount,
      globalConcurrency: this.globalConcurrency,
      ...this.outcomes,
      oldestPendingMs: oldestPendingAt ? Math.max(0, now - oldestPendingAt) : 0,
      longestRunningMs: longestRunningAt ? Math.max(0, now - longestRunningAt) : 0,
      byKind,
    };
    if (this.recentFailures.length > 0) status.recentFailures = [...this.recentFailures];
    if (deviceSn) {
      status.activeDevice = {
        pending: activeDevicePending,
        running: activeDeviceRunning,
      };
    }
    return status;
  }
}

module.exports = {
  AnalysisQueue,
};
