FROM public.ecr.aws/docker/library/node:22-bookworm-slim

ENV NODE_ENV=production \
    WECHAT_CLOUD_HOSTING=true \
    HOST=0.0.0.0 \
    PORT=3000 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FOODCAST_FFMPEG_PATH=/usr/bin/ffmpeg \
    FEED_ANALYSIS_PYTHON=/opt/venv/bin/python \
    FEED_ANALYSIS_YOLO_MODEL=/app/vision/models/yolo11s.pt \
    CAT_VISION_YOLO_MODEL=/app/vision/models/yolo11s.pt \
    CAT_VISION_POSE_MODEL=/app/vision/models/vitpose-s-apt36k.onnx \
    CAT_FACE_MODEL_DIR=/app/vision/models/cat-face \
    OPENCV_HAAR_CASCADES=/usr/share/opencv4/haarcascades \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN sed -i 's|deb.debian.org|mirrors.cloud.aliyuncs.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
        opencv-data \
        python3 \
        python3-opencv \
        python3-pip \
        python3-torch \
        python3-torchvision \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package*.json ./server/
RUN npm config set registry https://mirrors.tencent.com/npm/ \
    && cd server \
    && npm ci --omit=dev

COPY vision/requirements-cloud.txt ./vision/requirements-cloud.txt
RUN python3 -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/pip config set global.index-url http://mirrors.cloud.tencent.com/pypi/simple \
    && /opt/venv/bin/pip config set global.trusted-host mirrors.cloud.tencent.com \
    && /opt/venv/bin/pip install --no-cache-dir -r vision/requirements-cloud.txt \
    && /opt/venv/bin/pip install --no-cache-dir --no-deps ultralytics==8.4.104 \
    && /opt/venv/bin/pip install --no-cache-dir --no-deps rtmlib==0.0.15

COPY server ./server
COPY vision ./vision
COPY vision-v32 ./vision-v32
RUN cd /app/vision/models && sha256sum -c yolo11s.pt.sha256
RUN cd /app/vision/models && sha256sum -c behavior-models.sha256
RUN /opt/venv/bin/python -c "import numpy as np; from ultralytics import YOLO; YOLO('/app/vision/models/yolo11s.pt').predict(np.zeros((64, 64, 3), dtype=np.uint8), imgsz=64, device='cpu', verbose=False)"
RUN cd /app/vision && /opt/venv/bin/python -c "from src.animal_pose import load_animal_pose_model; from src.cat_face import load_cat_face_models; load_animal_pose_model(); load_cat_face_models()"
COPY bgm ./bgm
COPY public ./public

EXPOSE 3000

CMD ["node", "server/src/server.js"]
