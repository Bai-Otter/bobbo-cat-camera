function unwrapConfig(result, key) {
  if (!result || typeof result !== "object") return {};
  if (result[key] && typeof result[key] === "object") return result[key];
  const qualifiedKey = Object.keys(result).find((candidate) => candidate.endsWith(`.${key}`));
  if (qualifiedKey && result[qualifiedKey] && typeof result[qualifiedKey] === "object") {
    return result[qualifiedKey];
  }
  if (result.data) return unwrapConfig(result.data, key);
  return result;
}

function walkEntries(value, entries = [], depth = 0, inheritedKey = "") {
  if (depth > 8 || value === null || value === undefined) return entries;
  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (item !== null && item !== undefined && typeof item !== "object") {
        entries.push({ key: inheritedKey, value: item });
      } else {
        walkEntries(item, entries, depth + 1, inheritedKey);
      }
    });
    return entries;
  }
  if (typeof value !== "object") return entries;
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined && typeof item !== "object") {
      entries.push({ key, value: item });
    } else {
      walkEntries(item, entries, depth + 1, key);
    }
  }
  return entries;
}

function firstNumber(entries, patterns) {
  for (const pattern of patterns) {
    const row = entries.find((entry) => pattern.test(entry.key) && Number.isFinite(Number(entry.value)));
    if (row) return { value: Number(row.value), key: row.key };
  }
  return null;
}

function sumNumbers(entries, patterns) {
  return entries
    .filter((entry) => patterns.some((pattern) => pattern.test(entry.key)) && Number.isFinite(Number(entry.value)))
    .reduce((total, entry) => total + capacityBytes({ key: entry.key, value: Number(entry.value) }), 0);
}

function capacityBytes(row) {
  if (!row || !Number.isFinite(row.value) || row.value < 0) return 0;
  const key = String(row.key || "").toLowerCase();
  if (/byte/.test(key)) return Math.round(row.value);
  if (/\bkb\b|kbyte|kbytes/.test(key)) return Math.round(row.value * 1024);
  if (/\bgb\b|gbyte|gbytes/.test(key)) return Math.round(row.value * 1024 ** 3);
  // XM StorageInfo commonly reports capacity in MiB. Very large values are
  // already byte counts, so keep those unchanged.
  return Math.round(row.value < 1_000_000_000 ? row.value * 1024 ** 2 : row.value);
}

function storageType(positionResult) {
  const config = unwrapConfig(positionResult, "StoragePosition");
  const value = Array.isArray(config) ? config[0] || {} : config;
  if (value.SD === true) return "SD 卡";
  if (value.SATA === true) return "存储卡";
  if (value.USB === true) return "USB 存储";
  if (value.DVD === true) return "光盘存储";
  return "本地存储";
}

function storageAttached(positionResult) {
  const config = unwrapConfig(positionResult, "StoragePosition");
  const value = Array.isArray(config) ? config[0] || {} : config;
  return value.SD === true || value.SATA === true || value.USB === true || value.DVD === true;
}

function scheduleEnabled(config) {
  const entries = walkEntries(config);
  const enabled = entries.find((entry) => /^(Enable|Enabled)$/i.test(entry.key));
  if (enabled && (enabled.value === true || Number(enabled.value) === 1)) return true;
  const mask = entries.find((entry) => /(Record|SnapShot)Mask$/i.test(entry.key));
  if (mask && !/^0x0+$/i.test(String(mask.value)) && Number(mask.value) !== 0) return true;
  const section = entries.find((entry) => /TimeSection$/i.test(entry.key) && String(entry.value).trim());
  return !!section;
}

function encodeSummary(encodeResult) {
  const configValue = unwrapConfig(encodeResult, "Encode");
  const configs = Array.isArray(configValue) ? configValue : [configValue];
  const config = configs.find((item) => item && typeof item === "object" && item.MainFormat)
    || configs.find((item) => item && typeof item === "object")
    || {};
  const mainFormat = Array.isArray(config.MainFormat) ? config.MainFormat[0] : config.MainFormat;
  const mainVideoValue = mainFormat && mainFormat.Video;
  const mainVideo = Array.isArray(mainVideoValue) ? mainVideoValue[0] : mainVideoValue;
  if (mainVideo && typeof mainVideo === "object") {
    return {
      resolution: String(mainVideo.Resolution || mainVideo.Format || ""),
      fps: Number.isFinite(Number(mainVideo.FPS ?? mainVideo.FrameRate))
        ? Number(mainVideo.FPS ?? mainVideo.FrameRate)
        : 0,
      codec: String(mainVideo.Compression || mainVideo.Codec || mainVideo.VideoFormat || ""),
    };
  }
  const entries = walkEntries(config);
  const resolution = entries.find((entry) => /(Resolution|Format)$/i.test(entry.key));
  const fps = entries.find((entry) => /(FPS|FrameRate)$/i.test(entry.key));
  const codec = entries.find((entry) => /(Compression|Codec|VideoFormat)$/i.test(entry.key));
  return {
    resolution: resolution ? String(resolution.value) : "",
    fps: fps && Number.isFinite(Number(fps.value)) ? Number(fps.value) : 0,
    codec: codec ? String(codec.value) : "",
  };
}

function buildDeviceSettingsSummary({ storageInfo, storagePosition, record, snapshot, encode } = {}) {
  const storageEntries = walkEntries(unwrapConfig(storageInfo, "StorageInfo"));
  const totalBytes = sumNumbers(storageEntries, [/^TotalSpace$/i, /^Capacity$/i]);
  const freeBytes = sumNumbers(storageEntries, [/^(Remain|Free)Space$/i]);
  const explicitUsedBytes = sumNumbers(storageEntries, [/^UsedSpace$/i]);
  const usedBytes = explicitUsedBytes || Math.max(0, totalBytes - freeBytes);
  const statusRow = storageEntries.find((entry) => /^(Status|State)$/i.test(entry.key));
  const recordConfig = unwrapConfig(record, "Record");
  const recordEntries = walkEntries(recordConfig);
  const packetLength = firstNumber(recordEntries, [/PacketLength/i]);
  const preRecord = firstNumber(recordEntries, [/PreRecord/i]);

  return {
    storage: {
      type: storageType(storagePosition),
      available: totalBytes > 0 || storageAttached(storagePosition),
      totalBytes,
      usedBytes: Math.min(totalBytes || usedBytes, usedBytes),
      freeBytes: Math.min(totalBytes || freeBytes, freeBytes),
      status: statusRow ? String(statusRow.value) : "",
    },
    recording: {
      continuous: scheduleEnabled(recordConfig),
      snapshotEnabled: scheduleEnabled(unwrapConfig(snapshot, "Snapshot")),
      packetMinutes: packetLength ? packetLength.value : 0,
      preRecordSeconds: preRecord ? preRecord.value : 0,
    },
    picture: encodeSummary(encode),
  };
}

module.exports = { buildDeviceSettingsSummary, capacityBytes, walkEntries };
