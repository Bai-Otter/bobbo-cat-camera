const crypto = require("node:crypto");

const { BgmLibrary } = require("./bgmLibrary");
const { FoodcastRenderer } = require("./renderer");
const { FoodcastService } = require("./service");
const { FoodcastStore } = require("./store");
const { FoodcastAutomationService } = require("./automationService");
const { MaterialCatalog } = require("./materialCatalog");
const { CloudMaterialCatalog } = require("./cloudMaterialCatalog");
const { CloudMediaStorage, LocalMediaStorage } = require("./mediaStorage");
const { CustomFoodcastService } = require("./customService");
const { VisionWorkerAnalyzer } = require("../feedAnalysis/visionWorker");

function createDefaultFoodcastService({ config, coordinator }) {
  const options = config.foodcast;
  const store = new FoodcastStore(options.stateFile);
  const bgmLibrary = new BgmLibrary({ dir: options.bgmDir });
  const renderer = new FoodcastRenderer({
    rootDir: options.tempDir,
    ffmpegPath: options.ffmpegPath,
  });
  return new FoodcastService({
    store,
    bgmLibrary,
    renderer,
    outputDir: options.outputDir,
    concurrency: options.concurrency,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
    retentionMs: options.retentionMs,
    maxStorageBytes: options.maxStorageBytes,
    idFactory: () => crypto.randomUUID(),
    tokenFactory: () => crypto.randomBytes(24).toString("hex"),
    getDiary: (deviceSn, date) => coordinator.store.getDiary(date, deviceSn),
    resolveSource: async () => {
      const error = new Error("RECORDING_UNAVAILABLE");
      error.code = "RECORDING_UNAVAILABLE";
      throw error;
    },
  });
}

function createDefaultFoodcastAutomationService({
  config,
  resolveOwnerOpenid,
  resolvePreferences,
  resolveSource,
  shouldYieldHeavyWork,
} = {}) {
  const options = config.foodcast;
  let catalog;
  let mediaStorage;
  if (config.cloudHosting) {
    const cloudbase = require("@cloudbase/node-sdk");
    const app = cloudbase.init({
      env: config.cloudbaseEnvId,
      secretId: config.cloudbaseCredentials.secretId,
      secretKey: config.cloudbaseCredentials.secretKey,
    });
    catalog = new CloudMaterialCatalog({
      database: app.database(),
      collectionName: options.materials.collection,
    });
    mediaStorage = new CloudMediaStorage({ app });
  } else {
    catalog = new MaterialCatalog(options.materials.stateFile);
    mediaStorage = new LocalMediaStorage({ rootDir: options.outputDir });
  }
  return new FoodcastAutomationService({
    catalog,
    mediaStorage,
    bgmLibrary: new BgmLibrary({ dir: options.bgmDir }),
    renderer: new FoodcastRenderer({ rootDir: options.tempDir, ffmpegPath: options.ffmpegPath }),
    resolveOwnerOpenid,
    resolvePreferences,
    resolveSource,
    shouldYieldHeavyWork,
    tempDir: options.tempDir,
    retentionMs: options.materials.retentionMs,
    mealGapMs: options.materials.mealGapMs,
    leaseMs: options.materials.leaseMs,
    pollIntervalMs: Math.min(options.cleanupIntervalMs, 60_000),
    cleanupIntervalMs: options.cleanupIntervalMs,
    pythonPath: config.analysis?.pythonPath,
    dailyTimelineAnalyzer: new VisionWorkerAnalyzer({
      pythonPath: config.analysis?.pythonPath,
      workerScript: config.analysis?.workerScript,
      minConfidence: config.analysis?.minConfidence,
      timeoutMs: config.analysis?.visionTimeoutMs,
    }),
    dailyTimelineSampleSeconds: 0.5,
    dailyTimelineOrientation: config.analysis?.orientation || "none",
    dailyTimelineDetectorBackend: config.analysis?.detectorBackend || "auto",
    dailyTimelineYoloModel: config.analysis?.yoloModel || "",
    idFactory: () => crypto.randomUUID(),
  });
}

function createDefaultCustomFoodcastService({ automationService } = {}) {
  return new CustomFoodcastService({
    catalog: automationService.catalog,
    mediaStorage: automationService.mediaStorage,
    bgmLibrary: automationService.bgmLibrary,
    renderOutput: (input) => automationService.renderAndUpload(input),
    renderCover: (input) => automationService.renderMaterialCover(input),
    leaseMs: automationService.leaseMs,
    retentionMs: automationService.retentionMs,
  });
}

module.exports = {
  createDefaultCustomFoodcastService,
  createDefaultFoodcastAutomationService,
  createDefaultFoodcastService,
};

