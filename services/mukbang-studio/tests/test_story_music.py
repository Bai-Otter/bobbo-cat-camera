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


@pytest.mark.skipif(not shutil.which('ffmpeg'),reason='FFmpeg unavailable')
def test_library_mix_records_real_track_and_credits_without_changing_picture(tmp_path):
    import json
    source, music = tmp_path/'source.mp4', tmp_path/'track.mp3'
    media.run(['ffmpeg','-v','error','-f','lavfi','-i','color=size=160x90:rate=10:duration=3',
               '-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=3',
               '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',str(source)])
    media.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=660:duration=1',str(music)])
    track = {'id':'usuan1400037','title':'Test Track','artist':'Kevin MacLeod','file':music.name,
             'sha256':media.sha256(music),'license':'CC-BY-4.0',
             'license_url':'https://creativecommons.org/licenses/by/4.0/',
             'source_url':'https://incompetech.com/','style_note':'fixture','attribution':'Test credit'}
    media.write_json(tmp_path/'library.json',{'version':'test','tracks':[track]})
    from mukbang import story_mood
    recognized = story_mood.validate({'category':'warm','confidence':.9,'reason':'人轻摸猫头',
                                      'evidence_frame_ids':['F0001']}, {'F0001'})
    result = story_music.mix(source,tmp_path/'final.mp4',[{'output_start':.5,'audio_duration':1.5}],
                             {'music_library_file':str(tmp_path/'library.json'),'music_selection_policy':'story_mood_v1'},
                             classification=recognized)
    assert result['label'] == 'Test Track' and result['rights_status'] == 'cc_by_4_0'
    assert result['video_bitstream_unchanged'] and result['full_decode_pass']
    assert result['attribution_required'] and result['selection_mode'] == 'story_mood_per_job'
    assert result['match']['classification'] == recognized and result['match']['label'] == '温馨亲昵'
    assert result['speech_duck_windows'][0]['music_gain_during_voice'] == .35
    assert (tmp_path/'story-music-credits.txt').read_text() == 'Test credit'
    info = media.probe(tmp_path/'final.mp4')
    assert info['format']['tags']['comment'] == 'Test credit'
