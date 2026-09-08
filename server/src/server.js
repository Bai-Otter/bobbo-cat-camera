const path = require("path");
const express = require("express");
const config = require("./config");
const routes = require("./routes");
const { createNetworkServer } = require("./networkServer");
const { createDefaultLiveMediaServices } = require("./liveMedia/factory");
const { createDefaultCoordinator } = require("./feedAnalysis/coordinator");
const { createWorkerDemandHandler } = require("./feedAnalysis/workerDemand");
const {
  createDefaultCustomFoodcastService,
  createDefaultFoodcastAutomationService,
  createDefaultFoodcastService,
} = require("./foodcast/factory");

const app = express();
// Avatar uploads are sent as validated base64 JSON from the mini program.
app.use(express.json({ limit: "8mb" }));

const publicDir = path.join(__dirname, "../../public");
app.use(express.static(publicDir));
app.use("/media/cat-avatars", express.static(config.catAvatarDir, {
  fallthrough: false,
  index: false,
  dotfiles: "deny",
  maxAge: "1d",
}));
app.use("/media/replay-thumbnails", express.static(config.replayThumbnailDir, {
  fallthrough: false,
  index: false,
  dotfiles: "deny",
  maxAge: "30d",
}));
app.use("/media/device-covers", express.static(config.deviceCoverDir, {
  fallthrough: false,
  index: false,
  dotfiles: "deny",
  maxAge: "1d",
}));

const feedAnalysisCoordinator = createDefaultCoordinator({ config });
routes.setFeedAnalysisCoordinator(feedAnalysisCoordinator);
const foodcastService = createDefaultFoodcastService({ config, coordinator: feedAnalysisCoordinator });
routes.setFoodcastService(foodcastService);
const foodcastAutomationService = createDefaultFoodcastAutomationService({
  config,
  resolveOwnerOpenid: (deviceSn) => routes.resolveDeviceOwnerOpenid(deviceSn),
  resolvePreferences: (openid) => routes.resolveFoodcastPreferences(openid),
  resolveSource: (input) => foodcastService.resolveSource(input),
  shouldYieldHeavyWork: () => {
    const status = feedAnalysisCoordinator.getQueueStatus?.() || {};
    return Number(status.running) > 0 || Number(status.pending) > 0;
  },
});
routes.setFoodcastAutomationService(foodcastAutomationService);
const customFoodcastService = createDefaultCustomFoodcastService({
  automationService: foodcastAutomationService,
});
routes.setCustomFoodcastService(customFoodcastService);
const liveMediaServices = createDefaultLiveMediaServices({ config, routes });
routes.setLiveRecordingService(liveMediaServices);
feedAnalysisCoordinator.persistAnalyzedClip = (input) => (
  foodcastAutomationService.ingestAnalyzedClip(input)
);
foodcastService.cleanup();
const foodcastCleanupTimer = setInterval(() => {
  try {
    foodcastService.cleanup();
  } catch (error) {
    console.warn("[foodcast] cleanup failed", error.message);
  }
}, config.foodcast.cleanupIntervalMs);
foodcastCleanupTimer.unref?.();
app.get("/health", (req, res) => res.send("OK"));
if (config.analysis.workerControlToken) {
  app.get("/internal/feed-analysis/worker-demand", createWorkerDemandHandler({
    token: config.analysis.workerControlToken,
    getQueueStatus: () => feedAnalysisCoordinator.getQueueStatus?.() || {},
  }));
}
app.use(routes.router);

async function start() {
  await routes.initializeDeviceRegistry();
  await feedAnalysisCoordinator.initialize();
  await foodcastAutomationService.initialize();
  await liveMediaServices.initialize();
  const server = createNetworkServer({
    app,
    config,
    mediaControlGateway: liveMediaServices.gateway,
  });
  server.listen(config.port, config.host, () => {
    const protocol = config.cloudHosting || config.httpBehindProxy ? "http" : "https";
    console.log(`[server] ${protocol.toUpperCase()} service started`);
    console.log(`  ${protocol}://${config.host}:${config.port}`);
    feedAnalysisCoordinator.start();
    foodcastAutomationService.start();
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    feedAnalysisCoordinator.stop();
    foodcastAutomationService.stop();
    clearInterval(foodcastCleanupTimer);
    foodcastAutomationService.catalog.close?.();
    await liveMediaServices.close().catch((error) => {
      console.warn("[live-media] shutdown failed", error.message);
    });
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

start().catch((error) => {
  console.error("[server] failed to start:", error.message);
  process.exit(1);
});
