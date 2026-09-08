const MAX_CONTROL_BYTES = 8 * 1024;
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_TOKEN_LENGTH = 1024;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertSafeId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && SAFE_ID.test(value);
}

function assertSafeToken(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TOKEN_LENGTH
    && SAFE_ID.test(value);
}

function hasOnlyKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseControlMessage(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_CONTROL_BYTES) {
    throw codedError("MEDIA_MESSAGE_TOO_LARGE");
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw codedError("MEDIA_MESSAGE_INVALID");
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw codedError("MEDIA_MESSAGE_INVALID");
  }
  switch (message.type) {
    case "authorize":
      if (!hasOnlyKeys(message, ["type", "token"]) || !assertSafeToken(message.token)) {
        throw codedError("MEDIA_MESSAGE_INVALID");
      }
      return { type: message.type, token: message.token };
    case "record.start":
      if (hasOnlyKeys(message, ["type"])) return { type: message.type };
      if (!hasOnlyKeys(message, ["type", "sessionId"]) || !assertSafeId(message.sessionId)) {
        throw codedError("MEDIA_MESSAGE_INVALID");
      }
      return { type: message.type, sessionId: message.sessionId };
    case "record.stop":
    case "talk.start":
    case "talk.stop":
    case "ping":
      if (!hasOnlyKeys(message, ["type"])) throw codedError("MEDIA_MESSAGE_INVALID");
      return { type: message.type };
    default:
      throw codedError("MEDIA_MESSAGE_INVALID");
  }
}

function validateAudioFrame(frame) {
  if (!Buffer.isBuffer(frame) && !(frame instanceof Uint8Array)) {
    throw codedError("AUDIO_FRAME_INVALID");
  }
  const size = frame.byteLength;
  if (size <= 0) throw codedError("AUDIO_FRAME_INVALID");
  if (size > MAX_AUDIO_FRAME_BYTES) throw codedError("AUDIO_FRAME_TOO_LARGE");
  return size;
}

function mediaEvent(scope, state, details = {}) {
  return { type: `${scope}.${state}`, ...details };
}

function mediaError(scope, code) {
  return mediaEvent(scope, "failed", { error: code });
}

module.exports = {
  MAX_CONTROL_BYTES,
  MAX_AUDIO_FRAME_BYTES,
  parseControlMessage,
  validateAudioFrame,
  mediaEvent,
  mediaError,
};
