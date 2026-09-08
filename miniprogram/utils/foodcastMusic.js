const RANDOM_BGM_ID = "random";

function buildMusicOptions(tracks = []) {
  const safeTracks = (Array.isArray(tracks) ? tracks : [])
    .filter((track) => track && track.id && track.previewUrl)
    .map((track) => ({
      id: track.id,
      title: track.title || "",
      artist: track.artist || "",
      previewUrl: track.previewUrl,
    }));

  return [
    { id: RANDOM_BGM_ID, title: "随机音乐", artist: "", previewUrl: "" },
    ...safeTracks,
  ];
}

function createMusicPreviewController({
  createAudioContext,
  onPlayingChange = () => {},
  onError = () => {},
}) {
  let audioContext = null;
  let currentTrackId = "";
  let playingId = "";
  let currentVolume = 1;

  function setPlayingId(id) {
    const nextId = id || "";
    if (playingId === nextId) return;
    playingId = nextId;
    onPlayingChange(playingId);
  }

  function stop() {
    const context = audioContext;
    audioContext = null;
    currentTrackId = "";
    setPlayingId("");
    if (!context) return;
    context.stop();
    context.destroy();
  }

  function toggle(track) {
    if (!track || track.id === RANDOM_BGM_ID) {
      stop();
      return;
    }
    if (!track.id || !track.previewUrl) return;

    if (audioContext && currentTrackId === track.id) {
      if (playingId === track.id) {
        setPlayingId("");
        audioContext.pause();
        return;
      }
    }

    stop();
    const context = createAudioContext();
    audioContext = context;
    currentTrackId = track.id;

    context.onPlay(() => {
      if (audioContext === context) setPlayingId(track.id);
    });
    context.onPause(() => {
      if (audioContext === context) setPlayingId("");
    });
    context.onEnded(() => {
      if (audioContext === context) setPlayingId("");
    });
    context.onError((error) => {
      if (audioContext !== context) return;
      setPlayingId("");
      onError(error);
    });

    context.src = track.previewUrl;
    context.volume = currentVolume;
    setPlayingId(track.id);
    context.play();
  }

  function setVolume(value) {
    const volume = Math.max(0.2, Math.min(1, Number(value) || 0.2));
    currentVolume = volume;
    if (audioContext) audioContext.volume = volume;
    return volume;
  }

  return {
    destroy: stop,
    getPlayingId: () => playingId,
    selectRandom: stop,
    setVolume,
    stop,
    toggle,
  };
}

module.exports = {
  RANDOM_BGM_ID,
  buildMusicOptions,
  createMusicPreviewController,
};
