function initialState() {
  return {
    fullScreen: false,
    direction: "vertical",
    landscape: false,
    playState: "idle",
    muted: false,
    record: "idle",
    recordStartedAt: 0,
    recording: null,
    talk: "idle",
    error: "",
  };
}

function reduceMediaState(current, event = {}) {
  const state = { ...initialState(), ...(current || {}) };
  switch (event.type) {
    case "fullscreen": {
      const fullScreen = event.fullScreen === true;
      const direction = String(event.direction || "vertical");
      if (!fullScreen) {
        return {
          ...state,
          fullScreen: false,
          direction,
          landscape: false,
          record: "idle",
          recordStartedAt: 0,
          talk: "idle",
        };
      }
      return {
        ...state,
        fullScreen,
        direction,
        landscape: direction === "horizontal" || direction === "landscape",
      };
    }
    case "playback":
      return { ...state, playState: String(event.playState || "idle") };
    case "mute.toggle":
      return { ...state, muted: !state.muted };
    case "mute.set":
      return { ...state, muted: event.muted === true };
    case "record.starting":
      return { ...state, record: "starting", error: "" };
    case "record.active":
      return {
        ...state,
        record: "recording",
        recordStartedAt: Number(event.startedAt) || state.recordStartedAt || Date.now(),
        recording: event.id
          ? { ...(state.recording || {}), id: String(event.id) }
          : state.recording,
        error: "",
      };
    case "record.stopping":
      return { ...state, record: "stopping" };
    case "record.finalizing":
      return {
        ...state,
        record: "finalizing",
        recordStartedAt: 0,
        recording: event.id ? { id: String(event.id), status: "finalizing" } : state.recording,
        error: "",
      };
    case "record.ready":
      return {
        ...state,
        record: "ready",
        recordStartedAt: 0,
        recording: event.recording || state.recording,
        error: "",
      };
    case "record.failed":
      return {
        ...state,
        record: "failed",
        recordStartedAt: 0,
        error: String(event.error || "RECORDING_FAILED"),
      };
    case "record.idle":
      return { ...state, record: "idle", recordStartedAt: 0 };
    case "talk.starting":
      return { ...state, talk: "starting", error: "" };
    case "talk.active":
      return { ...state, talk: "talking", muted: false, error: "" };
    case "talk.stopping":
      return { ...state, talk: "stopping" };
    case "talk.idle":
      return { ...state, talk: "idle" };
    case "talk.failed":
      return { ...state, talk: "idle", error: String(event.error || "TALKBACK_FAILED") };
    case "media.error":
      return { ...state, error: String(event.error || "MEDIA_CONTROL_FAILED") };
    case "media.failed": {
      const recordPending = ["starting", "recording", "stopping", "finalizing"].includes(state.record);
      const talkPending = ["starting", "talking", "stopping"].includes(state.talk);
      return {
        ...state,
        record: recordPending ? "failed" : state.record,
        recordStartedAt: recordPending ? 0 : state.recordStartedAt,
        talk: talkPending ? "idle" : state.talk,
        error: String(event.error || "MEDIA_CONTROL_FAILED"),
      };
    }
    default:
      return state;
  }
}

function canStartRecording(state = {}) {
  return state.playState === "playing" && ["idle", "ready", "failed"].includes(state.record);
}

function canStartTalk(state = {}) {
  return state.playState === "playing" && ["idle", undefined].includes(state.talk);
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0");
}

function mediaActionAcknowledgements(eventType) {
  const type = String(eventType || "");
  if (["media.failed", "media.disconnected"].includes(type)) return ["record", "talk"];
  if (["record.active", "record.stopping", "record.finalizing", "record.ready", "record.failed", "record.idle"].includes(type)) {
    return ["record"];
  }
  if (["talk.active", "talk.stopping", "talk.idle", "talk.failed"].includes(type)) return ["talk"];
  return [];
}

function createRecordingSaveLedger() {
  const pending = new Set();
  const saved = new Set();
  return {
    begin(id) {
      const recordingId = String(id || "");
      if (!recordingId || pending.has(recordingId) || saved.has(recordingId)) return false;
      pending.add(recordingId);
      return true;
    },
    succeed(id) {
      const recordingId = String(id || "");
      pending.delete(recordingId);
      if (recordingId) saved.add(recordingId);
    },
    fail(id) {
      pending.delete(String(id || ""));
    },
  };
}

module.exports = {
  canStartRecording,
  canStartTalk,
  createRecordingSaveLedger,
  formatElapsed,
  initialState,
  mediaActionAcknowledgements,
  reduceMediaState,
};
