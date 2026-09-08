# Publication checks — 2026-09-08

- Source snapshot: `3879af3` from the active development checkout.
- All 64 non-test core files in `vision/src`, `vision-v32/src`, and the server
  feedAnalysis, foodcast and videoFilters directories match the source bytes.
- Python vision unit tests: **180 passed**, with both repository root and
  `vision/` on PYTHONPATH. This is not a new real-camera acceptance test.
- Portable Node suite: **1,096 passed / 0 failed**, using
  `node scripts/test-public.cjs`. Its seven production-only test-file exclusions
  are listed explicitly in the runner; the original tests are retained.
- Initial complete Node test run: **1,113 passed / 22 failed**, 1,135 total.
  Failures are export/environment checks: production domain, private project
  configs, vendor SDK, deployment workflows, bundled model binaries and the
  original seven-song BGM catalog. These assets/configs intentionally are not
  included in a public checkout. No claim is made that the full original
  production suite is green on this dependency-free export.
- Gitleaks scan: production credential findings in the old mini-program README
  were removed. The remaining finding is the documented vendor signature test
  vector in `server/src/jf/crypto.test.js`, not a configured production key.
- Original `.git` history, private .env, personal media, account databases,
  runtime device registries and SSH credentials are not part of this export.
- No production deployment workflow is enabled. The existing live service and
  source repository remain unchanged.

Core algorithms were not rewritten to make the public export pass checks.

The original snapshot contains inherited trailing whitespace. It was not
globally reformatted, in order to preserve the frozen algorithm source bytes.
