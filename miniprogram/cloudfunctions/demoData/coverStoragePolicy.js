function getObsoleteCoverFileId(existingCover, nextFileId) {
  const previousFileId = String((existingCover && existingCover.fileId) || "").trim();
  const normalizedNextFileId = String(nextFileId || "").trim();
  if (!previousFileId || previousFileId === normalizedNextFileId) return "";
  return previousFileId;
}

module.exports = {
  getObsoleteCoverFileId,
};
