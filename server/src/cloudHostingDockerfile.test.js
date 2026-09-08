const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const runtimeDockerfilePath = path.join(repositoryRoot, "Dockerfile");
const fullDockerfilePath = path.join(repositoryRoot, "Dockerfile.full");
const yoloModelPath = path.join(repositoryRoot, "vision", "models", "yolo11s.pt");
const yoloChecksumPath = `${yoloModelPath}.sha256`;
const behaviorModelChecksumPath = path.join(
  repositoryRoot,
  "vision",
  "models",
  "behavior-models.sha256",
);
const behaviorModels = [
  ["vitpose-s-apt36k.onnx", "2a40f76421d87f1b03f1204949d67014dbb876b7572c2bbc60ce2be45f6b4172"],
  ["cat-face/cat_face_localizer.tflite", "db0dbdc8430221cec96fcd907e7390fa0b23546e7673d08e508f1f6838ce2737"],
  ["cat-face/cat_face_landmarks_full.tflite", "c14bce135f5e005e135e3fd7d23938b4c1e9cb79ac1cfcc3b70a6df6c15265fe"],
];

test("Cloud Hosting builds the complete runtime from the public Node image mirror", () => {
  const dockerfile = fs.readFileSync(runtimeDockerfilePath, "utf8");

  assert.match(dockerfile, /^FROM public\.ecr\.aws\/docker\/library\/node:22-bookworm-slim/m);
  assert.doesNotMatch(dockerfile, /^FROM ccr\.ccs\.tencentyun\.com\//m);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends/);
  assert.match(dockerfile, /python3 -m venv --system-site-packages \/opt\/venv/);
  assert.match(dockerfile, /requirements-cloud\.txt/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /COPY server \.\/server/);
  assert.match(dockerfile, /COPY vision \.\/vision/);
  assert.match(dockerfile, /COPY bgm \.\/bgm/);
  assert.match(dockerfile, /COPY public \.\/public/);
  assert.doesNotMatch(dockerfile, /download\.pytorch\.org/);
});

test("Cloud Hosting Docker build uses domestic package mirrors", () => {
  const dockerfile = fs.readFileSync(fullDockerfilePath, "utf8");

  assert.match(dockerfile, /mirrors\.tencent\.com\/npm/);
  assert.match(dockerfile, /mirrors\.cloud\.tencent\.com\/pypi\/simple/);
});

test("Cloud Hosting image avoids build-time model downloads and unused web dependencies", () => {
  const dockerfile = fs.readFileSync(fullDockerfilePath, "utf8");
  const requirements = fs.readFileSync(
    path.join(repositoryRoot, "vision", "requirements-cloud.txt"),
    "utf8",
  );

  assert.match(dockerfile, /requirements-cloud\.txt/);
  assert.doesNotMatch(requirements, /^opencv(?:-contrib)?-python(?:-headless)?/m);
  assert.doesNotMatch(requirements, /^fastapi/m);
  assert.doesNotMatch(requirements, /^uvicorn/m);
  assert.doesNotMatch(requirements, /^scipy/m);
  assert.doesNotMatch(requirements, /^polars/m);
  assert.doesNotMatch(requirements, /^ultralytics-thop/m);
  assert.match(requirements, /^filelock>=3\.16\.1/m);
});

test("Cloud Hosting image uses Debian CPU PyTorch before installing vision dependencies", () => {
  const dockerfile = fs.readFileSync(fullDockerfilePath, "utf8");
  const requirements = fs.readFileSync(
    path.join(repositoryRoot, "vision", "requirements-cloud.txt"),
    "utf8",
  );

  assert.match(dockerfile, /python3-torch/);
  assert.match(dockerfile, /python3-torchvision/);
  assert.match(dockerfile, /python3 -m venv --system-site-packages \/opt\/venv/);
  assert.ok(
    dockerfile.indexOf("python3-torch") <
      dockerfile.indexOf("-r vision/requirements-cloud.txt"),
  );
  assert.doesNotMatch(dockerfile, /download\.pytorch\.org/);
  assert.doesNotMatch(requirements, /^torch(?:vision)?[<=>]/m);
  assert.match(requirements, /^numpy>=1\.26,<2\.0/m);
});

test("Cloud Hosting image reuses Debian OpenCV instead of installing a duplicate wheel", () => {
  const dockerfile = fs.readFileSync(fullDockerfilePath, "utf8");
  const requirements = fs.readFileSync(
    path.join(repositoryRoot, "vision", "requirements-cloud.txt"),
    "utf8",
  );

  assert.match(dockerfile, /python3-opencv/);
  assert.match(dockerfile, /opencv-data/);
  assert.match(
    dockerfile,
    /OPENCV_HAAR_CASCADES=\/usr\/share\/opencv4\/haarcascades/,
  );
  assert.doesNotMatch(requirements, /^opencv(?:-contrib)?-python(?:-headless)?/m);
  assert.match(dockerfile, /pip install --no-cache-dir --no-deps ultralytics==/);
  assert.match(dockerfile, /pip install --no-cache-dir --no-deps rtmlib==/);
});

test("Cloud Hosting image contains the pinned official YOLO11s weights", () => {
  const dockerfile = fs.readFileSync(runtimeDockerfilePath, "utf8");
  const dockerignore = fs.readFileSync(path.join(repositoryRoot, ".dockerignore"), "utf8");

  assert.equal(fs.existsSync(yoloModelPath), true, "official yolo11s.pt must be tracked");
  assert.equal(fs.existsSync(yoloChecksumPath), true, "the model checksum must be tracked");
  assert.match(dockerignore, /!vision\/models\/yolo11s\.pt/);
  assert.match(dockerfile, /FEED_ANALYSIS_YOLO_MODEL=\/app\/vision\/models\/yolo11s\.pt/);
  assert.match(dockerfile, /sha256sum -c yolo11s\.pt\.sha256/);
});

test("Cloud Hosting Dockerfiles smoke test official YOLO inference after checksum verification", () => {
  for (const dockerfilePath of [runtimeDockerfilePath, fullDockerfilePath]) {
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    const checksumIndex = dockerfile.indexOf("sha256sum -c yolo11s.pt.sha256");
    const smokeTestIndex = dockerfile.indexOf("from ultralytics import YOLO");

    assert.notEqual(checksumIndex, -1);
    assert.notEqual(smokeTestIndex, -1);
    assert.ok(checksumIndex < smokeTestIndex);
    assert.match(dockerfile, /np\.zeros\(\(64, 64, 3\), dtype=np\.uint8\)/);
    assert.match(dockerfile, /device='cpu'/);
  }
});

test("Cloud Hosting image contains the exact local feeding behavior models", () => {
  const dockerfile = fs.readFileSync(runtimeDockerfilePath, "utf8");
  const dockerignore = fs.readFileSync(path.join(repositoryRoot, ".dockerignore"), "utf8");
  const gitignore = fs.readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8");
  const checksums = fs.readFileSync(behaviorModelChecksumPath, "utf8");

  for (const [relativePath, expectedHash] of behaviorModels) {
    const modelPath = path.join(repositoryRoot, "vision", "models", ...relativePath.split("/"));
    assert.equal(fs.existsSync(modelPath), true, `${relativePath} must be tracked`);
    assert.match(checksums, new RegExp(`${expectedHash}\\s+\\*?${relativePath.replaceAll(".", "\\.")}`));
  }
  assert.match(dockerignore, /!vision\/models\/vitpose-s-apt36k\.onnx/);
  assert.match(dockerignore, /!vision\/models\/cat-face\/\*\.tflite/);
  assert.match(gitignore, /!vision\/models\/vitpose-s-apt36k\.onnx/);
  assert.match(gitignore, /!vision\/models\/cat-face\/\*\.tflite/);
  assert.match(dockerfile, /CAT_VISION_POSE_MODEL=\/app\/vision\/models\/vitpose-s-apt36k\.onnx/);
  assert.match(dockerfile, /CAT_FACE_MODEL_DIR=\/app\/vision\/models\/cat-face/);
  assert.match(dockerfile, /sha256sum -c behavior-models\.sha256/);
});

test("Cloud Hosting Dockerfiles load the bundled behavior models after checksum verification", () => {
  for (const dockerfilePath of [runtimeDockerfilePath, fullDockerfilePath]) {
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    const checksumIndex = dockerfile.indexOf("sha256sum -c behavior-models.sha256");
    const poseLoadIndex = dockerfile.indexOf("load_animal_pose_model");
    const faceLoadIndex = dockerfile.indexOf("load_cat_face_models");

    assert.notEqual(checksumIndex, -1);
    assert.ok(poseLoadIndex > checksumIndex);
    assert.ok(faceLoadIndex > checksumIndex);
  }
});
