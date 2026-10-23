# Third-party notices

The project owner authorized publication of the commissioned BOBBO application
and algorithm source. Original project code is MIT licensed. Existing upstream
attribution in `vision/UPSTREAM.md` is retained; repository hosting ownership is
not a claim to authorship of third-party dependencies.

The JLink mini-program SDK, vendor Web player, model binaries, and music are not
redistributed here. Their licenses must be obtained and reviewed separately.
Do not interpret this repository's MIT license as covering those components.

Python dependencies include Ultralytics, RTMLib, ONNX Runtime, OpenCV, NumPy,
and LiteRT. JavaScript dependencies are listed in `server/package-lock.json`.
Each retains its own license; review the exact installed versions and model
terms for redistribution or commercial deployment. In particular, do not
assume Ultralytics code or weights are MIT licensed.

The optional local model and SDK installation layout is documented in
`docs/DEPENDENCIES.md`.

`miniprogram/common/uqrcode.js` retains its embedded MIT notice for QRCode for
JavaScript, Copyright (c) 2009 Kazuhiko Arase, and its uQRCode source attribution.

The independent `services/mukbang-studio/` service adds FastAPI, Pydantic,
Uvicorn, python-multipart, HTTPX, Pillow, and pytest as Python dependencies.
The exact installed versions retain their own licenses; see that service's
`requirements.txt` and your installed package metadata. Its frontend uses
browser APIs, with Node.js built-ins for offline tests; no bundled frontend
framework or vendor SDK is added by this import.

FFmpeg/ffprobe are externally installed, not redistributed in this repository.
Their license obligations depend on the installed build and enabled codecs
(including the libx264 encoder); do not assume the project's MIT license
covers FFmpeg binaries. Vision model/API services are user-configured and
subject to their providers' terms. No model weights, music, private videos,
generated media, provider credentials, or original fonts are added with the
studio source import.
