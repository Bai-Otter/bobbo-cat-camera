from pathlib import Path
import os
import runpy
import subprocess
import sys
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('saved_narration', [False, True])
def test_launcher_selects_private_data_before_server_import(tmp_path, monkeypatch, saved_narration):
    calls = []
    private_store = tmp_path / "independent"
    if saved_narration:
        import json
        private_store.mkdir()
        key = tmp_path / 'fixture.key'
        key.write_text('test-only')
        (private_store/'narration-runtime.json').write_text(json.dumps(
            {'version':1,'enabled':True,'api_key_file':str(key)}), encoding='utf-8')
        for name in ('MUKBANG_BREEZE_ENABLED','BREEZE_API_KEY','BREEZE_API_KEY_FILE'):
            monkeypatch.delenv(name, raising=False)
    original_import = __import__
    sentinel = object()
    def importing(name, *args, **kwargs):
        if name == "mukbang.server":
            assert Path(os.environ["MUKBANG_APP_DATA_DIR"]) == private_store
            if saved_narration:
                assert os.environ['MUKBANG_BREEZE_ENABLED'] == '1'
                assert os.environ['BREEZE_API_KEY_FILE'] == str(key)
            calls.append("import")
            return SimpleNamespace(app=sentinel)
        return original_import(name, *args, **kwargs)
    monkeypatch.setenv("MUKBANG_APP_DATA_DIR", "sentinel-must-be-overridden")
    monkeypatch.setattr("builtins.__import__", importing)
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(run=lambda app, **kwargs: calls.append((app, kwargs))))
    monkeypatch.setattr(sys, "argv", ["run_daily.py", "--port", "8880", "--data-dir", str(private_store)])
    runpy.run_path(str(ROOT / "run_daily.py"), run_name="__main__")
    assert calls == ["import", (sentinel, {"host": "127.0.0.1", "port": 8880, "log_level": "info"})]
    assert private_store.exists() is saved_narration  # No creation/copy of legacy data.


def test_asgi_import_respects_preview_store_without_opening_legacy_data(tmp_path):
    environment = {**os.environ, "MUKBANG_APP_DATA_DIR": str(tmp_path / "preview"),
                   "MUKBANG_VISION_USE_CODEX_PROVIDER": "0", "MUKBANG_VISION_BASE_URL": "https://example.com/v1",
                   "MUKBANG_VISION_MODEL": "test-only", "MUKBANG_VISION_API_KEY": ""}
    script = ("import mukbang.server as s; from pathlib import Path; "
              "print(s.app.state.manager.jobs_dir.resolve()); "
              "s.app.state.manager.executor.shutdown(wait=True)")
    result = subprocess.run([sys.executable, "-c", script], cwd=ROOT, env=environment,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str((tmp_path / "preview" / "jobs").resolve())


def test_launcher_rejects_nonlocal_port_range(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["run_daily.py", "--port", "65536"])
    with pytest.raises(SystemExit, match="2"):
        runpy.run_path(str(ROOT / "run_daily.py"), run_name="__main__")
