import json

import pytest

from mukbang import config


@pytest.fixture
def codex_home(tmp_path, monkeypatch):
    for name in ("MUKBANG_VISION_BASE_URL", "MUKBANG_VISION_MODEL", "MUKBANG_VISION_API_STYLE",
                 "MUKBANG_VISION_API_KEY", "DASHSCOPE_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY",
                 "MUKBANG_VISION_USE_CODEX_PROVIDER", "MUKBANG_CODEX_HOME",
                 "MUKBANG_VISION_TIMEOUT_SECONDS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(config, "ROOT", tmp_path / "project")
    home = tmp_path / "codex"
    home.mkdir()
    (home / "config.toml").write_text(
        'model = "gpt-6.1-sol"\nmodel_provider = "existing-relay"\n'
        '[model_providers.existing-relay]\nbase_url = "http://relay.example"\n'
        'wire_api = "responses"\nrequires_openai_auth = true\n', encoding="utf-8")
    (home / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "FAKE_CURRENT_RELAY_KEY"}), encoding="utf-8")
    monkeypatch.setenv("MUKBANG_CODEX_HOME", str(home))
    return home


def test_current_relay_requires_explicit_opt_in(codex_home):
    provider = config.ProviderConfig()
    assert not provider.public()["configured"]
    assert provider.public()["provider"]["model"] == "qwen-vl-max"


def test_local_env_loads_probe_decoder_thread_setting(codex_home, monkeypatch):
    # Register a teardown value before .env parsing mutates the real mapping.
    monkeypatch.setenv("MUKBANG_FFPROBE_THREADS", "0")
    monkeypatch.delenv("MUKBANG_FFPROBE_THREADS", raising=False)
    config.ROOT.mkdir()
    (config.ROOT / ".env").write_text("MUKBANG_FFPROBE_THREADS=4\n", encoding="utf-8")
    config.ProviderConfig()
    assert config.os.environ["MUKBANG_FFPROBE_THREADS"] == "4"


def test_exact_current_relay_model_and_key_are_imported_without_copy(codex_home, monkeypatch):
    monkeypatch.setenv("MUKBANG_VISION_USE_CODEX_PROVIDER", "1")
    provider = config.ProviderConfig()
    public = provider.public()
    assert public["configured"]
    assert public["provider"]["model"] == "gpt-6.1-sol"
    assert public["provider"]["api_style"] == "responses"
    assert public["provider"]["configuration_source"] == "codex"
    assert "HTTP" in public["provider"]["transport_warning"]
    assert "FAKE_CURRENT_RELAY_KEY" not in json.dumps(public)
    private = provider.private()
    assert private["api_key"] == "FAKE_CURRENT_RELAY_KEY"
    assert private["trusted_http_base_url"] == "http://relay.example"
    assert private["stream"] is True and private["store"] is False
    assert not (config.ROOT / ".env").exists()


def test_imported_http_exception_does_not_allow_different_path_host_or_port(codex_home, monkeypatch):
    monkeypatch.setenv("MUKBANG_VISION_USE_CODEX_PROVIDER", "true")
    provider = config.ProviderConfig()
    provider.update({"base_url": "http://relay.example/"})
    for base in ("http://other.example", "http://relay.example/v1", "http://relay.example:81",
                 "http://relay.example.attacker.example", "http://relay.example?key=x"):
        with pytest.raises(ValueError):
            provider.update({"base_url": base})
    provider.update({"base_url": "https://different.example/v1"})
    assert not provider.public()["configured"]
    assert provider.public()["provider"]["configuration_source"] == "manual"
    assert not provider.public()["provider"]["transport_warning"]


def test_explicit_requested_model_does_not_silently_change(codex_home, monkeypatch):
    monkeypatch.setenv("MUKBANG_VISION_USE_CODEX_PROVIDER", "1")
    monkeypatch.setenv("MUKBANG_VISION_MODEL", "gpt-6.1-sol")
    path = codex_home / "config.toml"
    path.write_text(path.read_text(encoding="utf-8").replace('model = "gpt-6.1-sol"', 'model = "different-default"'), encoding="utf-8")
    assert config.ProviderConfig().public()["provider"]["model"] == "gpt-6.1-sol"


def test_missing_relay_credentials_fail_without_unrelated_provider_fallback(codex_home, monkeypatch):
    monkeypatch.setenv("MUKBANG_VISION_USE_CODEX_PROVIDER", "1")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "UNRELATED_KEY_NEVER_USED")
    (codex_home / "auth.json").write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="凭证") as error:
        config.ProviderConfig()
    assert "UNRELATED_KEY_NEVER_USED" not in str(error.value)


def test_codex_settings_and_auth_are_never_modified(codex_home, monkeypatch):
    before = {path.name: path.read_bytes() for path in codex_home.iterdir()}
    monkeypatch.setenv("MUKBANG_VISION_USE_CODEX_PROVIDER", "1")
    provider = config.ProviderConfig()
    provider.update({"model": "gpt-6.1-sol"})
    assert before == {path.name: path.read_bytes() for path in codex_home.iterdir()}


@pytest.mark.parametrize("use_codex", [False, True])
def test_timeout_defaults_are_public_and_private(codex_home, monkeypatch, use_codex):
    monkeypatch.setenv("MUKBANG_VISION_USE_CODEX_PROVIDER", str(int(use_codex)))
    monkeypatch.setenv("MUKBANG_VISION_BASE_URL", "http://localhost:9999/v1")
    provider = config.ProviderConfig()
    assert provider.private()["timeout_seconds"] == 600
    assert provider.public()["provider"]["timeout_seconds"] == 600


@pytest.mark.parametrize("seconds", ["30", "900", "1800", "600.5"])
def test_timeout_environment_is_used_without_240_second_clamp(codex_home, monkeypatch, seconds):
    monkeypatch.setenv("MUKBANG_VISION_BASE_URL", "http://localhost:9999/v1")
    monkeypatch.setenv("MUKBANG_VISION_TIMEOUT_SECONDS", seconds)
    provider = config.ProviderConfig()
    assert provider.private()["timeout_seconds"] == float(seconds)
    assert provider.public()["provider"]["timeout_seconds"] == float(seconds)


@pytest.mark.parametrize("seconds", ["0", "29.99", "1800.01", "inf", "nan", "banana", ""])
def test_invalid_timeout_environment_is_rejected(codex_home, monkeypatch, seconds):
    monkeypatch.setenv("MUKBANG_VISION_TIMEOUT_SECONDS", seconds)
    with pytest.raises(ValueError, match="30.*1800"):
        config.ProviderConfig()


def test_timeout_can_be_loaded_from_local_env_and_process_env_takes_precedence(codex_home, monkeypatch):
    config.ROOT.mkdir()
    (config.ROOT / ".env").write_text(
        "MUKBANG_VISION_BASE_URL=http://localhost:9999/v1\nMUKBANG_VISION_TIMEOUT_SECONDS=900\n",
        encoding="utf-8")
    assert config.ProviderConfig().private()["timeout_seconds"] == 900
    monkeypatch.setenv("MUKBANG_VISION_TIMEOUT_SECONDS", "750")
    assert config.ProviderConfig().private()["timeout_seconds"] == 750
