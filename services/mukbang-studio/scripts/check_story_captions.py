"""Build a local caption QA sheet from the delivered video; makes no AI request."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mukbang import media


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("job_dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = json.loads((args.job_dir / "story-result.json").read_text(encoding="utf-8"))
    if result.get("status") != "ready" or not result.get("inner_monologues"):
        raise ValueError("A real completed captioned story is required")
    args.output.mkdir(parents=True, exist_ok=True)
    cues = result["inner_monologues"]
    info = media.probe(args.job_dir / "interaction-story.mp4")
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    tile_width, tile_height = 640, round(video["height"] * 640 / video["width"])
    row_height = tile_height + 64
    board = Image.new("RGB", (tile_width * 2, row_height * math.ceil(len(cues) / 2)), "#fffaf2")
    draw = ImageDraw.Draw(board)
    font_path = next((p for p in (Path("C:/Windows/Fonts/msyh.ttc"), Path("C:/Windows/Fonts/simhei.ttf")) if p.exists()), None)
    label_font = ImageFont.truetype(str(font_path), 18) if font_path else media._font(18)
    caption_font = ImageFont.truetype(str(font_path), 19) if font_path else media._font(19)
    for index, cue in enumerate(cues):
        moment = min(cue["output_start"] + .6, (cue["output_start"] + cue["output_end"]) / 2)
        image_path = args.output / f"caption-{index+1:02}.png"
        media.run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-ss", str(moment), "-i",
                   str(args.job_dir / "interaction-story.mp4"), "-frames:v", "1", "-vf", "scale=640:-1", str(image_path)])
        x, y = index % 2 * tile_width, index // 2 * row_height
        draw.text((x+12, y+6), f"成片 {cue['output_start']:.2f}–{cue['output_end']:.2f}s / 原片 {cue['source_start']:.2f}–{cue['source_end']:.2f}s", font=label_font, fill="#302e29")
        draw.text((x+12, y+32), cue["text"], font=caption_font, fill="#302e29")
        with Image.open(image_path) as frame:
            board.paste(frame.convert("RGB"), (x, y+64))
    destination = args.output / "story-caption-sheet.jpg"
    board.save(destination, quality=94)
    print(json.dumps({"sheet": str(destination.resolve()), "caption_count": len(cues), "extra_ai_calls": 0}, ensure_ascii=False))


if __name__ == "__main__":
    main()
