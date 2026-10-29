import shutil
import pytest

from mukbang import media,story_music


def test_missing_music_does_not_claim_success(tmp_path):
    with pytest.raises(ValueError,match='BGM文件'):
        story_music.mix(tmp_path/'input.mp4',tmp_path/'output.mp4',[],
                        {'music_file':str(tmp_path/'missing.wav'),'music_sha256':'0'*64})


@pytest.mark.skipif(not shutil.which('ffmpeg'),reason='FFmpeg unavailable')
def test_real_bgm_loops_ducks_and_preserves_video_bitstream(tmp_path):
    source,music=tmp_path/'source.mp4',tmp_path/'music.wav'
    media.run(['ffmpeg','-v','error','-f','lavfi','-i','color=size=160x90:rate=10:duration=3',
               '-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=3',
               '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',str(source)])
    media.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=660:duration=1',str(music)])
    profile={'music_file':str(music),'music_sha256':media.sha256(music),'music_label':'test','music_rights':'local_preview_only'}
    report=story_music.mix(source,tmp_path/'final.mp4',[{'output_start':.5,'audio_duration':1.5}],profile)
    assert report['bgm_added'] and report['video_bitstream_unchanged'] and report['full_decode_pass']
    assert report['actual_container_duration_seconds']==pytest.approx(3,abs=.1)
    assert report['speech_duck_windows'][0]['music_gain_during_voice']==.35
    assert report['rights_status']=='local_preview_only'
