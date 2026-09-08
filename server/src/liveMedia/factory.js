const { CloudMediaStorage, LocalMediaStorage } = require("../foodcast/mediaStorage");
const { CloudLiveRecordingStore } = require("./cloudLiveRecordingStore");
const { LiveRecordingSession } = require("./liveRecordingSession");
const { LiveRecordingStore } = require("./liveRecordingStore");
const { MediaControlGateway } = require("./mediaControlGateway");
const { SdRecordingExportSession } = require("./sdRecordingExportSession");
const { TalkbackSession } = require("./talkbackSession");

function createDefaultLiveMediaServices({ config, routes, cloudbase, logger = console } = {}) {
  if (!config?.liveMedia || !config?.replay?.ffmpegPath) {
    throw new Error("LIVE_MEDIA_CONFIG_REQUIRED");
  }
  if (!routes) throw new Error("LIVE_MEDIA_ROUTES_REQUIRED");
  const options = config.liveMedia;
  let store;
  let mediaStorage;

  if (config.cloudHosting) {
    const cloudbaseSdk = cloudbase || require("@cloudbase/node-sdk");
    const app = cloudbaseSdk.init({
      env: config.cloudbaseEnvId,
      secretId: config.cloudbaseCredentials.secretId,
      secretKey: config.cloudbaseCredentials.secretKey,
    });
    store = new CloudLiveRecordingStore({
      database: app.database(),
      collectionName: options.collection,
    });
    mediaStorage = new CloudMediaStorage({ app });
  } else {
    store = new LiveRecordingStore({ filePath: options.stateFile });
    mediaStorage = new LocalMediaStorage({ rootDir: options.outputDir });
  }

  const gateway = new MediaControlGateway({
    authenticate: (req, token) => routes.authenticateMediaControl(req, token),
    resolveOwnedDevice: (openid, deviceSn) => routes.resolveOwnedMediaDevice(openid, deviceSn),
    resolveLiveSession: (openid, deviceSn, sessionId) => (
      routes.resolveOwnedLiveSession(openid, deviceSn, sessionId)
    ),
    createTalkback: ({ ownerOpenid, deviceSn }) => new TalkbackSession({
      ffmpegPath: config.replay.ffmpegPath,
      resolveTalkbackUrl: () => routes.resolveOwnedTalkbackUrl(ownerOpenid, deviceSn),
      logger,
    }),
    createRecording: (recordingContext = {}) => new LiveRecordingSession({
      ffmpegPath: config.replay.ffmpegPath,
      rootDir: options.tempDir,
      store,
      mediaStorage,
      resolveSourceUrl: () => routes.resolveOwnedRecordingLiveSource(
        recordingContext.ownerOpenid,
        recordingContext.deviceSn
      ),
      logger,
      maxDurationSec: Math.min(300, Math.max(1, Number(options.maxDurationSec) || 300)),
    }),
    logger,
  });

  return {
    gateway,
    store,
    mediaStorage,
    async startReplayExport(input = {}) {
      const session = new SdRecordingExportSession({
        ffmpegPath: config.replay.ffmpegPath,
        rootDir: options.tempDir,
        store,
        mediaStorage,
        resolveRecordingWindow: routes.resolveOwnedRecordingWindow,
        logger,
        maxDurationSec: Math.min(300, Math.max(1, Number(options.maxDurationSec) || 300)),
      });
      return session.exportWindow(input);
    },
    async initialize() {
      await store.initialize?.();
      return store.recoverInterrupted();
    },
    async close() {
      await gateway.close();
    },
  };
}

module.exports = { createDefaultLiveMediaServices };
