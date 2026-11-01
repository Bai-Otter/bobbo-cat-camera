"""Install ten gentle instrumentals for eating; independent of story music."""
import argparse
from pathlib import Path

from install_story_music import install

PICKS = [
    ('Carefree', '暖暖日常 · 尤克里里、马林巴和钟琴，轻快安心'),
    ('Daily Beetle', '可爱吃饭 · 尤克里里、音乐盒和玩具钢琴，小小的雀跃'),
    ('Life of Riley', '满足惬意 · 钟琴与尤克里里，中速明亮'),
    ('Easy Lemon', '轻柔陪伴 · 吉他、钢片琴与马林巴，放松不催促'),
    ('Fretless', '甜甜日常 · 吉他、尤克里里与音乐盒，温和明亮'),
    ('Teddy Bear Waltz', '摇摇晃晃 · 木管与钟琴，慢悠悠的小熊舞步'),
    ('Cheery Monday', '开心开饭 · 轻巧钢琴与钟琴，明亮的小节奏'),
    ('Rainbows', '清新治愈 · 马林巴与尤克里里，轻盈的日常感'),
    ('Sunshine (version 2)', '午后暖阳 · 慢速钢琴与吉他，安安静静陪着吃'),
    ('Morning', '安静陪伴 · 古典吉他、竖琴与长笛，柔软的清晨感'),
]

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True,
                        help='Use <service-data-dir>/music-eating for automatic discovery')
    args = parser.parse_args()
    install(args.destination, PICKS, 'cat-eating-healing-v1')
