#!/usr/bin/env node

const { createDefaultFoodcastAutomationService } = require("../src/foodcast/factory");
const config = require("../src/config");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

async function main() {
  const deviceSn = argument("device");
  const date = argument("date");
  let ownerOpenid = argument("owner");
  if (!deviceSn || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("usage: rebuild-daily-foodcast.js --device <sn> --date <YYYY-MM-DD> [--owner <openid>]");
  }
  const service = createDefaultFoodcastAutomationService({
    config,
    resolveOwnerOpenid: async () => ownerOpenid,
    resolvePreferences: async () => ({ mode: "quick_cut" }),
    resolveSource: async () => {
      throw new Error("RECORDING_UNAVAILABLE");
    },
  });
  try {
    await service.initialize();
    if (!ownerOpenid && service.catalog?.db) {
      const rows = service.catalog.db.prepare(`
        SELECT DISTINCT owner_openid FROM foodcast_material_records
        WHERE kind = 'material' AND device_sn = ? AND date = ? AND owner_openid != ''
      `).all(deviceSn, date);
      if (rows.length !== 1) throw new Error(`OWNER_AMBIGUOUS:${rows.length}`);
      ownerOpenid = rows[0].owner_openid;
    }
    if (!ownerOpenid) throw new Error("OWNER_REQUIRED");
    const material = await service.updateDailyFeatured({
      ownerOpenid,
      deviceSn,
      date,
      nowMs: Date.now(),
    });
    if (!material?.id) throw new Error("DAILY_NOT_GENERATED");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      id: material.id,
      algorithm: material.algorithm,
      durationSec: material.durationSec,
      bgm: material.bgm,
      sourceMaterialIds: material.sourceMaterialIds,
      selectedSegments: material.selectedSegments,
      fileId: material.fileId,
    }, null, 2)}\n`);
  } finally {
    service.catalog?.close?.();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
