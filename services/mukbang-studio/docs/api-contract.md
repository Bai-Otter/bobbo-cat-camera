# Integration contract

Service root: `services/mukbang-studio/`. Plain FastAPI backend, static vanilla frontend. URLs below are same-origin. All displayed text is Chinese. Provider credentials are never returned or persisted in public task artifacts. Private local configuration is excluded from Git.

## HTTP API

### Optional daily dual-video mode

- `GET /daily` or `/daily/` serves `web/daily.html`; `/` remains the existing debugger. Both understand `?job=<12 hex ID>` for read-only opening of one existing record. Static assets remain `/static/daily.*`.
- Config adds `features:{dual_video:true,story_inner_monologue:true,story_max_duration:60,photos:true,photo_gallery:true}`. Eating defaults and published active Prompt resolution do not change.
- The existing multipart `POST /api/jobs` accepts optional `story_enabled` (strict JSON boolean, default false) and `story_target_duration` (finite 3–60 seconds, default30). The phone page submits `story_enabled:true,use_active_prompt:true`. Disabled default story fields are omitted from frozen effective options, preserving historical request identities.
- The existing single vision POST appends an independent system contract, returning the original five eating fields plus `interaction_story`. There is no separate story inference, resampling or automatic retry.
- Ready model story: `{status:"ready",episode_id,title,summary,clips:[{id,episode_id,start,end,title,reason,frame_ids,co_visible_frame_ids}],events:[{id,clip_id,start,end,phase:"setup"|"action"|"reaction",human_action,pet_action,human_visible:true,pet_visible:true,frame_ids,reacts_to_event_id?}],warnings:[]}`. Explicit absence: `{status:"not_found",reason,clips:[],events:[],warnings:[]}`. Missing/invalid is not absence.
- Every story reference is an actual in-interval source ID; every in-clip sampled frame must appear in co-visibility coverage. Clips/events are chronological, non-overlapping and from one declared episode. Require visible action then linked reaction; finish on reaction. Hand/body counts as human only when visibly present with pet. Total source intervals <=60s; target is aspirational, no padding or forced crop.
- Dual results retain existing eating fields, adding `highlight_status:"ready"|"not_found"|"invalid"|"failed"`, `highlight_reason`, real `poster_url`, `dual_video:true`, and `story:{status,title,summary,reason?,video_url?,video_duration,poster_url?,clips,events,warnings,validation?}`. No eating output means `video_url:null,video_duration:0`, not a fake player. Story and eating failures are independent; both absent is completed analysis with zero videos, both undeliverable with errors is failed. Legacy results remain unchanged and do not acquire fictional story metadata.
- Story events retain original model `start/end` and `requested_source_start/end`, and add authoritative inward-clipped `source_start/end`, `output_start/end`, `source_times:[{frame_id,time,sample_manifest_time,output_time}]`. `time` is recomputed from native PTS, not guessed from ID. Story clips expose actual native-PTS boundaries and original `requested_start/end`; inward adjustments and original changed evidence lists are auditable.
- Artifacts add `story-decision.json`, `story-timeline.json`, `interaction-story.mp4`, `story-technical-validation.json`, `story-result.json`. Existing safe file/range routes serve them. Timings add `render_story` and its measured media substeps; one shared `ai_request` is not counted twice.
- Without `photos_enabled`, existing independent eating GIF/MP4 memes remain the only image-like outputs, not mislabeled as portraits or new ugly-cute photos. Visibility is a sampled-model declaration, not an independent semantic proof of all source frames; see [method and limits](daily-dual-videos.md).

#### Optional native photos in the same request (legacy single mode)

- `photos_enabled` is a strict JSON boolean, default false, and requires `story_enabled:true`. False is omitted from effective frozen options to preserve existing request identities. The phone page submits true; historical calls/results are not reinterpreted.
- Additive `prompts/daily-photos-system-appendix.txt` requests `daily_photos:{portrait:pick,ugly_cute:pick}` in the **same** vision JSON. Each pick is `{status:"ready",frame_id,time,title,reason,pet_face_visible:true,clear_enough:true,no_major_occlusion:true}`. Portrait also requires `human_face_visible:true`; ugly-cute adds1–3 distinct `traits` from `extreme_closeup,big_nose,silly_full_face,tongue_out,tiny_teeth,funny_expression`. No picture is `{status:"not_found",reason}` without a frame/time. Missing or invalid structure is `invalid`, not absence. Two categories cannot repeat the same source frame; duplicated ugly-cute is invalid rather than silently replaced.
- Frame ID must belong to this task; finite time must match that sample within1 microsecond. Local source-PTS/frame-index checks are authoritative. Both categories independently search all supplied frames, not just eating/story picks. Model visibility/quality statements are evidence declarations, not independent semantic proof.
- Result adds `photos:{portrait:photo,ugly_cute:photo}` with independent `ready/not_found/invalid/failed` states. Ready includes `image_url`, `sample_url`, `sheet_id`, native `width/height`, original rationale and `source:{source_frame_index,source_pts,time_base,source_time,sample_time}`. `validation` records source/image SHA256, bytes, native size, no crop/no image generation/zero additional visual calls. No fake photo appears in historical jobs.
- Saved artifacts: `photo-decision.json`, `photo-result.json`, `photos/portrait.png`, `photos/ugly_cute.png`. One FFmpeg pass exports the selected exact sampled source frames as full-resolution PNG, no enhancement or thumbnail upscaling. Local failures do not discard successful videos; successful photos remain deliverable even if both videos fail. All products absent is a valid completed analysis, but zero success plus an error is failed.
- Timing adds `export_photos`, with native-frame extraction and per-photo checks. Offline recovery revalidates the saved photo decisions and exports them with zero AI calls; no automatic selection retry. See [photo method](daily-photos-2026-10-29.md).

#### Gallery mode: relaxed portrait plus 4–6 ugly-cute photos

- `photo_mode:"single"|"gallery"` defaults to `single`; omit the default from frozen options. Ignore gallery selection when photos are disabled. The current phone page explicitly sends `photos_enabled:true,photo_mode:"gallery"`; require `features.photo_gallery:true` before allowing uploads. Old tasks remain readable.
- Gallery replaces only the photo appendix with `prompts/daily-photo-gallery-system-appendix.txt`. Existing eating/story prompt prefixes are unchanged. Still one vision request; no automatic retry or extra visual validation call.
- `daily_photos.portrait` ready: `{status:"ready",frame_id,time,title,reason,human_visible:true,pet_visible:true,human_presence:"face"|"hand"|"leg"|"body"}`. Pick the best available co-visible frame; no face/composition quality gate. Absence requires `{status:"not_found",reason,human_present:false,reviewed_all_samples:true}`. Reject absence that contradicts declared human-visible story events. Actual lack of co-visible material must never be fabricated into a portrait.
- `daily_photos.ugly_cute`: `{status:"ready"|"not_found",reviewed_all_samples:true,shortfall_reason,items:[pick]}`. Each item retains legacy ugly-cute evidence plus nonempty `difference`. Normally4–6; fewer than4 requires a concrete shortfall; zero implies `not_found`. Reject more than6, invalid references and duplicate source indices (including the portrait). Prompt requests visibly different expressions/angles rather than neighboring duplicates; this is not an independent image-similarity guarantee.
- Result retains the grouped shape. `ugly_cute.count_goal` is `{minimum:4,maximum:6,actual,met,shortfall_reason}`; actual counts successful exports, not merely selected items. Local failures mark individual photos failed and cannot masquerade as four delivered images. Invalid groups retain an explicit reason. Videos remain independent.
- Flatten internally for one native-frame decoding pass, then regroup in model order. Artifacts: `photos/portrait.png`, `photos/ugly_cute_01.png` through `_06.png`, grouped `photo-decision.json` / `photo-result.json`. Recovery traverses individual picks, revalidates saved evidence and adds zero AI calls. See [gallery method](photo-gallery-2026-10-29.md).

#### Existing story upgraded with inner-monologue subtitles

- Optional `story_mode:"interaction"|"inner_monologue"` defaults to legacy `interaction`. Legacy effective options/fingerprints omit that default. The phone page explicitly submits `inner_monologue` and defaults its story target to35 seconds; API target default remains30 for compatibility. There is still only one `result.story` and one story MP4.
- New mode appends `prompts/story-inner-monologue-system-appendix.txt` in the same visual request. Eating contract and active reusable Prompt remain unchanged. Search all supplied sheets for related interaction beats in one shared activity; preserve every sampled human/pet co-visibility requirement.
- Ready story additionally requires `narrative_arc`, `reviewed_full_video:true`, `shortfall_reason` and `inner_monologues:[{id,clip_id,event_id,start,end,frame_ids,text}]`. These are source timestamps; caption starts inside its referenced event, ends inside the same clip and cites that event's in-caption evidence. Full review means all supplied samples, not every source frame. Fictional thoughts are separate from factual events, not an animal-emotion diagnosis.
- Preferred duration band is target±5 seconds within3–60. A shorter story needs explicit material-shortfall evidence; output `duration_goal:{target,minimum,maximum,met,shortfall_reason}` reports actual conformance after inward PTS alignment. No duplicate footage, slowdown, unrelated padding or automatic AI retry.
- Captions are plain visible text,1–36 characters,1.4–5.5 seconds and at least characters/5 seconds per cue. Final-timeline gaps >=1.5s, total visibility <=55%, count <=ceil(duration/5). Invalid captions fail the story only; eating remains independent.
- Output `story.story_mode="inner_monologue"`, `subtitle_kind="fictional_inner_monologue"`, mapped `inner_monologues` including `source_start/end`, `output_start/end`, `source_times`; `subtitle_url` points to SRT and `subtitle_timeline_url` to `story-inner-monologues.json`. `interaction-story.ass` is burned in the existing single render pass. `validation` adds subtitle hash/count/burned flag and duration-goal status. Source audio stays; narration/BGM flags are false.
- Old records stay unchanged and display as historical versions without subtitles. Local recovery reuses frozen model decisions and captions without inference. A separately recorded manual pre-delivery restyle may expose `story.local_postprocess:{kind:"subtitle_style_only",seconds,additional_ai_calls:0,...}`; its time is displayed separately and never folded into the frozen initial job timings.

- `GET /api/config` → `{configured:boolean, provider:{base_url,model,api_style:"chat_completions"|"responses",key_configured:boolean,timeout_seconds:number,configuration_source:"codex"|"manual",client_compatibility:"none"|"codex_cli_rs/0.156.1",transport_warning:string}, defaults:{sample_interval:1,frames_per_sheet:60,target_duration:40,min_duration:30,max_duration:50}, prompt_template:string, limits:{max_upload_mb:512,max_duration_seconds:600}, legacy_available:boolean}`. The bundled environment example selects `gpt-6.1-sol`; each installation must configure its own compatible provider. Optional explicitly opted-in Codex import reads the existing local provider and credential without copying it to project files. Display any transport warning independently of save-success messages.
- `PUT /api/config` JSON `{base_url,model,api_style,api_key?}` → same public config; blank/omitted api_key preserves current memory/env key. No secrets in browser local/session storage. Browser may remember non-secret options only.
- `POST /api/jobs` multipart `file` plus `options` JSON string `{target_duration,min_duration,max_duration,sample_interval,prompt,use_active_prompt?}` → 202 `{id,status,...}`. `use_active_prompt:true` freezes the server's current active standard, replacing stale form Prompt text; false/absent preserves a nonempty custom Prompt for backwards compatibility. Empty Prompt also resolves to active. New webpage uploads default to active; opening old tasks does not silently adopt new standards. `frames_per_sheet` fixed 60. Defaults above. Clamp nothing silently; validate finite positive values, `min<=target<=max`, min>=1/max<=120, interval 0.25–3 sec, max 600 sec source. Show selected ranges in sent Prompt.
- `GET /api/jobs` → `{jobs:[job_summary...]}` newest first.
- `GET /api/jobs/{id}` → job record below. Poll every ~1.2 seconds until terminal. Missing optional fields mean not ready, not errors.
- `GET /api/jobs/{id}/feedback` → `{version,annotations:[{frame_id,label:"like"|"dislike",reason}],note}`. Terminal job with reusable sampling only. An unsaved child draft inherits its frozen submitted feedback, with local `version:0`; no ancestor remerge.
- `PUT /api/jobs/{id}/feedback` JSON `{expected_version,annotations,note}` → saved draft with version + 1. Complete replacement, including explicit clears. Version is a strict nonnegative integer. Unknown/duplicate frame IDs are rejected. Stale versions return 409 without overwriting either draft. Saves never call AI; current credential is redacted before persistence.
- `GET /api/jobs/{id}/iterations` → `{root_job_id,jobs:[{id,round,parent_job_id,status,filename,created_at}]}` sorted by family-unique round ascending.
- `POST /api/jobs/{id}/revise` JSON `{expected_version,request_id,options?}` → 202 new child job or the existing job for this request ID. `request_id` is 16–64 letters/digits/underscore/hyphen. Freeze full saved feedback and options; require a nonempty annotation or overall note. Reuse source/PTS/samples/original sheets, with unchanged sampling interval. Different content under the same ID returns 409. Same-content manual retry returns the existing task even after the draft changes; there is no automatic model retry. Old task results are never overwritten.
- `POST /api/jobs/{id}/cancel` → current job; cancellation cooperative. No automatic model retry/restart.
- `GET /api/jobs/{id}/files/{relative_path}` → safe artifact, correct MIME and video range support. Paths must stay inside this job. No directory listing.
- `GET /api/legacy` → `{runs:[{id,title,notice,video_url?,sheets:[{id,title,original_url,annotated_url,count,selected_count}],selected_frames:[{id,time,title,reason,url?,sheet_id?}],timeline:[...]}]}`. Clearly historical.
- `GET /api/health` → `{ok,ffmpeg,ffprobe}`.

### Reusable Prompt library

- `GET /api/prompt-library` → `{revision,active_version_id,versions:[{id,name,text,created_at,parent_version_id,source_proposal_id?,summary,diff}],proposals:[summary...]}`. Initialize immutable `P0001` from bundled default without inference. Global revision starts at 0; every publish/activate increments it, including rollback, to prevent ABA.
- `GET /api/config` additionally returns `prompt_library:{revision,active_version_id,active:version}`; `prompt_template` is now the active reusable Prompt, not necessarily the bundled original.
- `POST /api/prompt-library/versions` → 201 library; body `{expected_revision,request_id,text,name:"",proposal_id?}`. Full text <=40,000 chars, name <=100. Explicit confirmation publishes a new immutable version and activates it, no AI. With proposal_id require a completed proposal on the current baseline; user may edit its candidate before confirmation. True full-text diff is computed by the program. Stale revision or changed body under same request_id returns 409; local editor must retain its draft.
- `POST /api/prompt-library/activate` → library; body `{expected_revision,request_id,version_id}`. Switch active pointer to existing version, retain all history, no AI. All publish/activate IDs use 16–64 letters/digits/underscore/hyphen; versions use `P0001`-style IDs.
- `POST /api/prompt-proposals` → 202 suggestion task; body `{expected_revision,request_id,sources:[{job_id,feedback_version}],note:""}`. Strict integer revisions, 1–12 unique terminal source jobs with saved nonempty feedback at the requested versions; note <=4,000 chars. The server freezes only saved annotations/notes and separately labeled old AI text, never accepts browser-supplied evidence content or paths. Maximum combined 480 annotations / 80,000 source JSON characters; otherwise reject before model request with a request to choose fewer sources.
- `GET /api/prompt-proposals/{id}` → suggestion record below. Same-content request_id recovery returns the original task before revalidating changed drafts/provider; changed content conflicts. One explicit suggestion creates at most one text-only model POST with zero images, no implicit publish or retry. Poll until completed/failed/interrupted. Restart marks unfinished tasks interrupted rather than resubmitting.

Text-only suggestion record: `{id,status,stage?,progress?,created_at,updated_at,base_revision,base_version_id,base_prompt,sources,note,prompt:{system,user},ai:{model?,call_count,text_call_count,visual_call_count:0,raw_response?,usage?},candidate_prompt?,summary?,changes?,warnings?,diff?,timings,error?}`. Actual text input/raw response and timing remain inspectable on failure. Timing scope is independent `prompt_tuning`, not video HTTP upload time.

Model suggestion result: `{candidate_prompt,summary,changes:[{before,after,reason,evidence:[{job_id,frame_id?}]}],warnings}`. Validate exact text anchors and evidence ownership; program-generated diff, not model explanation, is the source of truth for what changed. Candidate full text cannot contain local frame/job IDs, source filenames, paths or source timecodes. Instance evidence stays in provenance only. Without explicit human reasons/notes, do not infer a visual preference from old model descriptions. A candidate never becomes active without a separate user confirmation.

Errors `{detail:"human-readable Chinese message"}` (HTTP errors); worker failures also remain in job record.

### Satisfied-round visual generalization

- `POST /api/prompt-proposals/satisfied-round` → 202 proposal; body `{expected_revision,request_id,job_id}`. The job must be a completed, evidence-complete round. The server freezes that exact round's actual template, original input sheets, selected samples and already-applied feedback, not its later mutable draft or a different family round. Request/revision validation is strict; same-request recovery returns the original proposal before re-reading changed evidence or provider credentials.
- The proposal uses `source_mode:"satisfied_round"`, separate `tuning_base_prompt` (the round template) and `base_prompt` (the current global standard), plus `satisfied_round`, `round_inputs`, `request_manifest`, actual `prompt`, raw response, usage and timings. Original sheet hashes are rechecked immediately before inference.
- One explicit visual proposal makes at most one multi-image POST, with separately reported image/visual/text call counts. It does not resample, rerender, automatically retry or publish. Unavailable or inconsistent evidence fails closed; absent historical records are not fabricated.
- Poll using the existing `GET /api/prompt-proposals/{id}`. Publish through `POST /api/prompt-library/versions` with its `proposal_id` after explicit user review. Candidate validation and publication retain the technical clauses from both the round and global baselines; global revision conflicts return 409. Existing jobs and templates are unchanged.
- The original multi-source text-only proposal endpoint remains zero-image. Generalization is a separate debugging operation, not part of a video's one-call budget and not model-weight training.

## Job public record

```
{
 id, filename, status, stage, progress, message, created_at, updated_at,
 options:{target_duration,min_duration,max_duration,sample_interval,prompt},
 source?:{duration,width,height,fps,video_url,audio_sample_rate?,audio_channels?},
 sampling?:{
   interval, frames_per_sheet:60, frame_count, sheet_count,
   sheets:[{id,index,url,annotated_url?,count,width,height,sha256?,frames:[frame...]}],
   frames:[{id,time,sheet_id,row,col,box:[x,y,w,h],url,selected?,meme_selected?,score?,reason?}]
 },
 prompt?:{system,user},
 prompt_standard?:{mode:"global"|"custom",version_id?,revision?,name?,sha256},
 timings?:{schema_version:1,available:true,status,total_seconds,started_at,finished_at,
   scope:"server_request_to_terminal"|"pipeline_execution",is_partial,active_stage,failed_stage,note,
   stages:[{id,label,seconds:number|null,status,percent:number|null,
     details?:[{id,label,seconds:number,status,percent:number}]}]},
 iteration?:{root_job_id,parent_job_id,round,reused_sampling:true,request_id,request_fingerprint,request_identity_fingerprint?},
 feedback?:{version,annotations:[{frame_id,label,reason}],note},
 comparison?:{parent_job_id,added_frame_ids,removed_frame_ids,kept_frame_ids,
   liked_selected_ids,liked_omitted_ids,disliked_selected_ids,disliked_removed_ids},
 ai?:{model,provider,api_style,call_count,usage?,elapsed_seconds?,raw_response?,parsed?,request_manifest?},
 result?:{
   video_url, video_duration,
   clips:[{id,start,end,title,reason,score,frame_ids,output_start,output_end,...}],
   memes:[{id,start,end,title,reason,frame_ids,gif_url,video_url,...}],
   selected_frames:[{id,time,title?,score,reason,url,sheet_id,...}],
   adjustments:[...], warnings:[string...], validation:{...}
 },
 error?:string
}
```

Status: queued, preparing, analyzing, rendering, completed, failed, cancelled. Progress 0–100. `stage` short user-facing Chinese text. `message` longer status. `ai.call_count` increments before the one outbound model request, even on failure. No mocks in production route.

### Timing contract

Use monotonic time, with mutually exclusive stages and accumulated re-entry. Start the HTTP scope before multipart parsing, end at terminal processing; include receiving/saving and queue time. Exclude pre-arrival/browser selection/polling delay. AI time includes payload encoding, network transfer, wait and response receipt, not frame preparation. `ai.elapsed_seconds` remains for compatibility, while `timings` is the detailed record.

Stages: `upload`, `queue`, `reuse_inputs` (revision only), `source_probe`, `extract_frames`, `build_sheets`, `prepare_request`, `ai_request`, `selection`, `annotate_sheets`, `render_highlight`, `export_memes`, `final_validation`, and `overhead`. Stage status: pending/running/completed/failed/cancelled/interrupted/skipped. Unexecuted seconds are null, not zero. Aggregate stage seconds equal total up to rounding. Total freezes on completed/failed/cancelled; restart interruption freezes only the last persisted observation with `is_partial:true`, never counts unknown downtime. Old jobs without timings remain unchanged and render as unrecorded.

Persist atomic `timings.json` before the job can advertise it. GET includes a live snapshot while running; downloading the JSON returns the most recently persisted snapshot, not a live clock. Completed jobs return the frozen snapshot. Publish terminal job/timing states under the same lock.

Optional `stage.details` contains sequential measured operations already included in the parent stage, not additional stages. Do not add them to the total or reweight the top-level breakdown. A detail's percent is relative to its parent, not the job total. Source indexing can report metadata / actual-frame indexing / digest; output rendering can report encode, output metadata, one combined frame-count/PTS scan, strict complete decode, and GIF checking. Labels distinguish meme numbers. Durations of failed/cancelled operations remain recorded. Old tasks have no fabricated detail history. Detail totals may be less than the parent because bookkeeping and quantization are not all separately instrumented.

Full ffprobe frame-time scans use `MUKBANG_FFPROBE_THREADS` (strict integer 0–32, default 4; 0 restores automatic decoder threads). This is an input decoder setting only, not an encoder quality/preset change. Source indexing and output PTS validation both still decode every frame. A single output scan supplies count and PTS; a separate strict audio/video decode remains mandatory. Meme MP4 and GIF are encoded from two branches of the same native source decode, never by using a lossy MP4 as the GIF's source.

### Feedback contract

The frame-feedback/revise endpoints remain same-video calibration, not training. Cross-video reuse is handled only through separately confirmed reusable Prompt versions; do not copy local frame IDs to new videos. Save = zero model calls; one explicit video revision = at most one outbound multimodal model POST and a new independent render. The separate suggestion action costs at most one zero-image text POST. User texts are data, not system instructions. Current complete snapshot replaces prior labels; unmarked frames are neutral. Likes are prioritized and omissions shown. Dislikes cannot occur in `selected_frames` or any `frame_ids` evidence; violations retain raw response/comparison and fail visibly, without silent edits or a second request. This is not whole-window exclusion or manual timeline editing.

New revisions also persist only a SHA-256 `request_identity_fingerprint` of the original structured request. Use it to confirm the same request even if a mistakenly pasted credential was redacted and credentials later disappear/rotate. Keep the original redacted `request_fingerprint` as a compatibility fallback for historical jobs; never persist the sensitive original body just for idempotency.

Comparison describes raw model-selected evidence, not taste accuracy or exact footage additions/removals. `disliked_removed_ids` includes all disliked IDs absent this round, including those never chosen previously. Like omissions remain visible even if model supplies no explanation. Each family retains every version, Prompt, original response, submitted feedback, comparison, products and timings. Cache reuse verifies IDs/PTS/hashes and fails closed, with no hidden resampling fallback. Historical missing source/frame digests are explicitly disclosed in provenance; newly created jobs establish a full input-integrity manifest.

## Python pipeline contract

```
from mukbang.pipeline import run_pipeline
run_pipeline(job_dir: Path, source_path: Path, options: dict, model_config: dict,
             emit: Callable[[dict],None], cancelled: Callable[[],bool],
             timings=None, revision=None) -> dict
```

`model_config={base_url,model,api_style,api_key,timeout_seconds:600,stream?:boolean,store?:boolean,trusted_http_base_url?:string|null,codex_client_compat?:boolean}`. Private, never sent through emit/persisted. `MUKBANG_VISION_TIMEOUT_SECONDS` sets a finite request deadline, 30–1800 seconds, default 600; invalid values are rejected, not silently clamped. The effective nonsecret timeout is visible in public provider config and request manifests. The trusted HTTP exception is server-only, derived solely from the explicitly imported complete existing GPT base URL; no browser-supplied flag or new remote host/path is accepted. The current relay uses Responses `stream:true/store:false`; consume one SSE response through an explicit completed terminal event, never retry with different settings. Streaming is a transport option, not an additional model call. The request manifest may expose stream/store but not the private trusted exception field or credentials. Server guarantees config exists and valid, one worker. Pipeline snapshots it once. `emit` receives shallow job-field updates; include entire nested sampling/ai structures when updated. Return final public fields (`status:"completed"`, source/sampling/prompt/ai/result...). Emit request input artifacts before AI call so even model failure is debuggable. Save raw text before parsing.

`MUKBANG_VISION_CODEX_CLIENT_COMPAT` is a default-off server-only opt-in (`1`, `true`, `yes`). It is effective only for the initially imported complete Codex `(base_url, model, api_style)` while the configuration source remains `codex` and the format is Responses, including HTTPS imports. A real manual address/model/style/key update disables it until restart; a no-op save does not. The private derived boolean is not accepted by the browser settings schema. When enabled, the shared fixed-label helper adds exactly `User-Agent: codex_cli_rs/0.156.1` and `originator: codex_cli_rs`. `request_manifest.client_headers` records exactly these nonsecret labels, otherwise `{}`, and excludes Authorization. Request bodies and credentials are unchanged. No cookies, session/account identifiers, signatures, alternate endpoints, retries or CLI invocations are added. These labels are a local-version compatibility candidate, not authentication or a guarantee of provider permission. The known official-client-only HTTP 403 is reported explicitly and remains one failed POST with redacted raw evidence.

Six-argument pipeline callers remain compatible. With supplied timings, the manager owns finalization: do not emit an early completed state. Standalone calls create/finalize their own `pipeline_execution` clock. Internal `revision={reuse_from:Path,parent_job_id,root_job_id,round,feedback,previous_selected_frames}` is generated on the server, never accepted as a browser-supplied directory. Whitelist current feedback fields; do not recursively embed old jobs or Prompts.

Relative artifacts inside job_dir. Build artifact URLs `/api/jobs/{job_dir.name}/files/{path.as_posix()}`. Job filenames are generated identifiers, not user-supplied paths. Server/config modules own job management and credentials; pipeline/media/vision/selection modules own inference and rendering. Pipeline tests must inject provider callable/mock at test layer only; live route never creates pretend AI selections. Media exports use FFmpeg arrays and no shell.

## Model result schema

```
{
 summary:string,
 selected_frames:[{frame_id:"F0001",score:0..100,reason:string,labels:[string]}],
 highlight_clips:[{id:"c01",start:number,end:number,context_start:number,context_end:number,title:string,reason:string,score:0..100,frame_ids:["F0001"]}],
 memes:[{id:"m01",start:number,end:number,title:string,reason:string,score:0..100,frame_ids:["F0001"]}],
 warnings:[string]
}
```

Prompt must include frame ID→source timestamp map, actual video duration, actual target/min/max, sampling interval, all images in one request, no forced categories, natural lead-in/out, 1–4 distinct meme loops (0.7–4s within source), and clips whose non-overlapping total meets requested range if possible. Context handles are model-approved optional expansion bounds, never arbitrary unrelated video. Validate identity/ranges and preserve original AI decision separately from algorithm-adjusted render timeline.

### Audited reference convergence

`validate_result` is strict: every highlight reference must be inside its exact half-open approved context, every meme reference inside its exact half-open clip, and at least one original reference must be inside each clip. `validate_and_adjust` can remove redundant references outside those existing bounds, but only after validating their known/selected membership and all other fields. It never moves boundaries, adds evidence, changes raw `selected_frames`, or makes a model request. Context handles inside a highlight's approved context remain valid even outside its initial clip. The converged result is strictly revalidated before normal duration adjustment and native-frame quantization; the latter still requires actual retained evidence.

Each removal is exposed in `result.adjustments` as `{type:"drop_out_of_interval_references",collection:"highlight_clips"|"memes",clip_id,before:[frame_id...],after:[frame_id...],interval:[start,end],removed:[{frame_id,time}],reason}` and as a readable `result.warnings` entry. These describe reference cleanup, not footage additions/removals, a new aesthetic judgment, or recovery of an excluded action peak. Raw response, parsed decisions, selected frames, reasons and timestamps remain available independently. Raw dislike checks precede convergence; unknown/unselected/malformed references and clips without original in-clip support still fail. No epsilon or rounded sampling times are used to admit evidence.

Offline recovery may additionally accept a `selection` failure with mutually consistent completed AI response, prompts and manifest. It preflights the saved decision against native cached PTS before creating the target, then still verifies all input integrity and mappings and revalidates before rendering. Unsupported or incomplete evidence and feedback iterations remain rejected. It creates a separate job with zero current AI calls; original artifacts are never overwritten.
