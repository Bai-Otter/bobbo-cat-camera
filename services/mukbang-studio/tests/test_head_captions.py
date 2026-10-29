from copy import deepcopy
import math

import pytest

from mukbang import head_captions, story_subtitles, vision


def placement(box=(.4, .45, .65, .8), confidence=.9, ident="F0005"):
    return {"mode":"head_top", "anchors":[{"frame_id":ident,"head_box":list(box),"confidence":confidence}]}


def normalized(raw):
    return head_captions.validate_placement(raw, {"start":4.,"end":6.5}, {"start":3.,"end":9.},
        {f"F{i+1:04d}":{"id":f"F{i+1:04d}","time":float(i)} for i in range(12)})


def test_valid_boxes_keep_real_frame_time_and_do_not_mutate_input():
    raw=placement(); before=deepcopy(raw)
    result=normalized(raw)
    assert result["anchors"][0]["source_time"]==4.
    assert result["mode"]=="head_top" and raw==before


@pytest.mark.parametrize("raw", [None, [], {"mode":"safe","anchors":[]}, placement(confidence=.2),
    placement(ident="F9999"), placement(ident="F0002"), placement(ident="F0011"),
    placement(box=(-.2,.3,.6,.9)), placement(box=(.5,.3,.2,.9)),
    placement(box=(float('nan'),.3,.6,.9)), placement(box=(True,.3,.6,.9))])
def test_bad_anchor_falls_back_without_retry_or_story_failure(raw):
    result=normalized(raw)
    assert result["mode"]=="safe" and not result["anchors"]


@pytest.mark.parametrize("width,height", [(2560,1440),(1280,720),(720,1280)])
def test_auto_layout_is_above_head_in_bounds_and_nonoverlapping(width,height):
    cue={"text":"给咪的？咪就知道。","caption_placement":normalized(placement())}
    layout=head_captions.layout_caption(cue,width,height)
    assert layout["mode"]=="head_top"
    left,top,right,bottom=layout["text_box"]
    assert 0<=left<right<=width and 0<=top<bottom<=height
    assert bottom<.45*height


def test_top_edge_uses_side_or_safe_fallback_instead_of_covering_cat():
    cue={"text":"咪先尝尝。","caption_placement":normalized(placement(box=(.35,.01,.8,.7)))}
    result=head_captions.layout_caption(cue,1280,720)
    assert result["mode"] in {"head_side","safe"}
    assert all(math.isfinite(v) for v in result["text_box"])


def test_ass_injection_remains_rejected(tmp_path):
    cue={"text":"{\\pos(1,1)}","output_start":1.,"output_end":3.,"caption_placement":normalized(placement())}
    with pytest.raises(Exception):
        story_subtitles.write_subtitles(tmp_path,[cue],{"width":1280,"height":720})


def test_writer_uses_program_generated_tags_and_records_layout(tmp_path):
    cue={"id":"m1","text":"给咪的？咪就知道。","output_start":1.,"output_end":3.4,"caption_placement":normalized(placement())}
    files=story_subtitles.write_subtitles(tmp_path,[cue],{"width":1280,"height":720})
    text=files['ass'].read_text(encoding='utf-8')
    assert "\\pos(" in text and "\\fad(" in text and "\\t(" in text
    assert (tmp_path/'story-caption-layout.json').is_file()
    assert files['srt'].read_text(encoding='utf-8').count('给咪的')==1


def test_contract_is_added_to_same_vision_prompt_only_for_inner_monologue():
    options={"target_duration":40,"min_duration":30,"max_duration":50,"story_enabled":True,"story_mode":"inner_monologue"}
    sampling={"frames":[],"interval":1,"frame_count":0,"sheet_count":0}
    result=vision.build_prompts(options,{"duration":120},sampling)
    assert 'caption_placement' in result['system'] and 'head_box' in result['system']
    options['story_mode']='interaction'
    assert 'caption_placement' not in vision.build_prompts(options,{'duration':120},sampling)['system']


def test_next_sample_guards_against_cat_approaching_between_samples():
    current = normalized(placement())
    current['anchors'].append({'frame_id':'F0008','source_time':7.,'head_box':[.1,.01,.9,.9],'confidence':.9})
    cue={'text':'咪来啦。','source_start':4.,'source_end':6.5,'caption_placement':current}
    layout=head_captions.layout_caption(cue,1280,720)
    assert layout['mode'] in {'safe','head_side'} and layout['anchor_count']==2


def test_distant_future_anchor_is_not_used_for_current_caption():
    current=normalized(placement())
    current['anchors'].append({'frame_id':'F0010','source_time':9.,'head_box':[.1,.01,.9,.9],'confidence':.9})
    layout=head_captions.layout_caption({'text':'咪来啦。','source_start':4.,'source_end':6.5,
                                        'caption_placement':current},1280,720)
    assert layout['mode']=='head_top' and layout['anchor_count']==1


def test_slightly_smaller_caption_stays_over_closeup_head():
    cue={'text':'本咪先替你尝尝。','caption_placement':normalized(placement(box=(.25,.13,.68,.86)))}
    layout=head_captions.layout_caption(cue,2560,1440)
    assert layout['mode']=='head_top'
    assert 86<=layout['font_size']<108
    assert layout['text_box'][1]>=36


def test_long_caption_wrapping_stays_inside_portrait_frame():
    cue={'text':'一'*36,'caption_placement':normalized(placement(box=(.4,.7,.6,.9)))}
    layout=head_captions.layout_caption(cue,720,1280)
    assert len(layout['lines'])>1
    left,top,right,bottom=layout['text_box']
    assert 0<=left<right<=720 and 0<=top<bottom<=1280
