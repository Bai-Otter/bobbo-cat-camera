# YOLO model artifact

`yolo11s.pt` is the unmodified Ultralytics YOLO11s pretrained model used by the
existing cat detector. It is sourced from the official Ultralytics assets
release:

https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11s.pt

The adjacent `yolo11s.pt.sha256` file pins the exact bytes copied into the Cloud
Hosting image. The Docker build verifies the checksum and fails instead of
falling back to a runtime model download.

## Feeding behavior models

Cloud Hosting also bundles the exact models previously used from the local
runtime cache instead of downloading them while analyzing a recording:

- `vitpose-s-apt36k.onnx`, sourced by RTMLib from the APT-36K ViTPose-S model.
- `cat-face/cat_face_localizer.tflite` and
  `cat-face/cat_face_landmarks_full.tflite`, sourced from the
  `hugocornellier/cat_detection` model assets.

`behavior-models.sha256` pins the bytes copied from that existing local cache.
The Docker build verifies all three files and loads both model families before
the image can be published. Cloud Hosting fails closed if any bundled file is
missing; it does not silently substitute or download another weight.
