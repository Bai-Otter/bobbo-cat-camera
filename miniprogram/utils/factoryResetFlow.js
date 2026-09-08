async function runStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    if (error && !error.stage) error.stage = stage;
    throw error;
  }
}

async function resetUnbindAndRemoveDevice(options = {}) {
  const resetDevice = options.resetDevice;
  const unbindDevice = options.unbindDevice;
  const removeDevice = options.removeDevice;
  if (typeof resetDevice !== "function") throw new Error("RESET_DEVICE_REQUIRED");
  if (typeof unbindDevice !== "function") throw new Error("UNBIND_DEVICE_REQUIRED");
  if (typeof removeDevice !== "function") throw new Error("REMOVE_DEVICE_REQUIRED");

  await runStage("reset", resetDevice);
  await runStage("unbind", unbindDevice);
  await runStage("remove", removeDevice);
  return { ok: true };
}

module.exports = { resetUnbindAndRemoveDevice };
