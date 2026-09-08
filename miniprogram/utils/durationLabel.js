function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeSeconds(seconds) {
  const value = Math.round(Number(seconds) || 0);
  return value > 0 ? value : 1;
}

function formatDurationLabel(seconds) {
  const total = normalizeSeconds(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) {
    return hours + "小时" + pad2(minutes) + "分" + pad2(remainingSeconds) + "秒";
  }

  if (minutes > 0) {
    return minutes + "分" + pad2(remainingSeconds) + "秒";
  }

  return remainingSeconds + "秒";
}

module.exports = {
  formatDurationLabel,
};
