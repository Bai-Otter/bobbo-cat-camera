"""Read-only production audit plus a local cue-boundary contact sheet. No AI/TTS."""
import argparse
import json
from pathlib import Path
import sys
from urllib.parse import unquote

from PIL import Image, ImageDraw

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from mukbang import media


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--job-dir',type=Path,required=True)
    args=parser.parse_args()
    job=args.job_dir.resolve()
    record=json.loads((job/'job.json').read_text(encoding='utf-8'))
    story=record['result']['story']
    if record['status']!='completed' or story['status']!='ready':
        raise RuntimeError('Only audit completed production results')
    prefix=f'/api/jobs/{job.name}/files/'
    if not story['video_url'].startswith(prefix):
        raise ValueError('Not an artifact of this job')
    video=(job/unquote(story['video_url'][len(prefix):])).resolve()
    if not video.is_relative_to(job):
        raise ValueError('Video outside job')
    out=job/'production-qa'
    out.mkdir(exist_ok=False)
    cues=story['inner_monologues']
    board=Image.new('RGB',(1280,400*len(cues)),'#faf5ea')
    draw=ImageDraw.Draw(board)
    for i,cue in enumerate(cues):
        for col,moment in enumerate((cue['output_start']+.25,cue['output_end']-.15)):
            frame=out/f'cue-{i+1:02d}-{col}.jpg'
            media.run(['ffmpeg','-v','error','-nostdin','-ss',str(moment),*media.SAFE_INPUT_OPTIONS,
                       '-i',str(video),'-frames:v','1','-vf','scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',str(frame)])
            with Image.open(frame) as im:
                board.paste(im,(col*640,i*400+35))
            draw.text((col*640+10,i*400+10),f"{cue['id']} {moment:.2f}s",fill='#222222')
    board.save(out/'cue-boundaries.jpg',quality=94)
    # No private voice IDs or filesystem paths in the printable audit.
    audit={'job_id':job.name,'status':record['status'],'visual_api_calls':record['ai']['call_count'],
           'duration':story['video_duration'],'style':story.get('style_version'),
           'voice_label':story.get('narration',{}).get('voice_label'),
           'voice_kind':story.get('narration',{}).get('voice_kind'),
           'narration_added':story['validation'].get('narration_added'),
           'bgm_added':story['validation'].get('bgm_added'),
           'music_rights':story.get('bgm',{}).get('rights_status'),
           'subtitle_layout':story.get('subtitle_layout'),'warnings':story.get('warnings',[]),
           'video_url':story['video_url'],'cues':[{'text':c['text'],'start':c['output_start'],'end':c['output_end']} for c in cues]}
    media.write_json(out/'audit.json',audit)
    print(json.dumps(audit,ensure_ascii=False))


if __name__=='__main__':
    main()
