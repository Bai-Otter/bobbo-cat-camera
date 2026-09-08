function createNativeHlsSourceController(options = {}) {
  const nativeClient = options.nativeClient;
  if (!nativeClient) throw new Error("NATIVE_HLS_CLIENT_REQUIRED");
  const channel = Number(options.channel || 0);
  const stream = options.stream || "Main";
  const beginTime = options.beginTime;
  const fileName = options.fileName;
  const initialTargetSec = Math.max(0, Number(options.targetSec) || 0);

  return {
    start({ write, onError, onClose }) {
      return nativeClient.startPlayback({
        channel,
        stream,
        beginTime,
        fileName,
        targetSec: initialTargetSec,
        onData: write,
        onError,
        onClose,
      });
    },
    pause() {
      return nativeClient.pausePlayback({ channel, stream });
    },
    seek(targetSec) {
      return nativeClient.seekTo({
        channel,
        stream,
        beginTime,
        targetSec: Math.max(0, Number(targetSec) || 0),
      });
    },
    resume() {
      return nativeClient.resumePlayback({ channel, stream });
    },
    stop() {
      return nativeClient.stopPlayback({ channel, stream, beginTime });
    },
  };
}

module.exports = {
  createNativeHlsSourceController,
};
