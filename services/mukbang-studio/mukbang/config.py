"""Write-only provider credentials, never saved with public job artifacts."""
from __future__ import annotations

import ipaddress
import json
import math
import os
from pathlib import Path
import re
from threading import RLock
from urllib.parse import urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {"sample_interval": 1.0, "frames_per_sheet": 60,
            "target_duration": 40.0, "min_duration": 30.0, "max_duration": 50.0}
LIMITS = {"max_upload_mb": 512, "max_duration_seconds": 600}
DEFAULT_TIMEOUT_SECONDS = 600.0
MIN_TIMEOUT_SECONDS = 30.0
MAX_TIMEOUT_SECONDS = 1800.0
CODEX_CLIENT_COMPAT_PROFILE = "codex_cli_rs/0.156.1"


def validate_timeout_seconds(value) -> float:
    """One bounded timeout contract for environment and direct transport users."""
    message = "AI请求总时限必须为30–1800秒的有限数值，请检查 MUKBANG_VISION_TIMEOUT_SECONDS"
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(message)
    try:
        seconds = float(value)
    except (ValueError, OverflowError):
        raise ValueError(message) from None
    if not math.isfinite(seconds) or not MIN_TIMEOUT_SECONDS <= seconds <= MAX_TIMEOUT_SECONDS:
        raise ValueError(message)
    return seconds


def validate_base_url(value: str, *, trusted_http_base_url: str | None = None) -> str:
    value = value.strip().rstrip("/")
    if len(value) > 1000 or any(ord(c) < 33 for c in value):
        raise ValueError("模型地址格式不正确")
    try:
        parts = urlsplit(value)
        hostname = parts.hostname or ""
        _ = parts.port
    except ValueError:
        raise ValueError("模型地址格式不正确") from None
    if not hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("模型地址不能包含账号、密码、查询参数或片段")
    loopback = hostname.lower() == "localhost"
    try:
        ip = ipaddress.ip_address(hostname)
        loopback = ip.is_loopback
        if not loopback and not ip.is_global:
            raise ValueError("不能将图片发送到内网或元数据地址；本地模型请使用 localhost")
    except ValueError as exc:
        if str(exc).startswith("不能"):
            raise
    if parts.scheme not in {"http", "https"}:
        raise ValueError("模型地址必须使用 HTTPS；本地模型也可使用 HTTP")
    # Only a server-side, explicitly imported existing GPT endpoint may use
    # remote HTTP. Browser settings cannot add an exception or change its path.
    imported_http = trusted_http_base_url and value == trusted_http_base_url.strip().rstrip("/")
    if parts.scheme == "http" and not loopback and not imported_http:
        raise ValueError("远程模型必须使用 HTTPS，避免明文发送图片和密钥")
    if parts.path.endswith(("/chat/completions", "/responses")):
        raise ValueError("请填服务的基础地址，例如 https://服务地址/v1，不含 /chat/completions 或 /responses")
    return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


def _origin(url: str) -> tuple:
    parts = urlsplit(url)
    return parts.scheme, parts.hostname, parts.port


def _load_local_env() -> None:
    """Optional user-created .env, no shell expansion or implicit remote files."""
    path = ROOT / ".env"
    if not path.is_file():
        return
    allowed = {"MUKBANG_VISION_BASE_URL", "MUKBANG_VISION_MODEL", "MUKBANG_VISION_API_STYLE",
               "MUKBANG_VISION_API_KEY", "DASHSCOPE_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY",
               "MUKBANG_VISION_USE_CODEX_PROVIDER", "MUKBANG_CODEX_HOME",
               "MUKBANG_VISION_TIMEOUT_SECONDS", "MUKBANG_FFPROBE_THREADS",
               "MUKBANG_VISION_CODEX_CLIENT_COMPAT"}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() in allowed and key.strip() not in os.environ:
            os.environ[key.strip()] = value.strip().strip("\"'")


def _current_gpt_connection() -> dict:
    """Read the opted-in current provider and its key; never modify or copy it."""
    try:
        import tomllib
    except ImportError:
        raise ValueError("复用当前GPT配置需要 Python 3.11 或更新版本") from None
    home = Path(os.getenv("MUKBANG_CODEX_HOME") or os.getenv("CODEX_HOME") or Path.home() / ".codex")
    try:
        settings = tomllib.loads((home / "config.toml").read_text(encoding="utf-8-sig"))
        provider = settings.get("model_providers", {}).get(settings.get("model_provider"), {})
        base = str(provider.get("base_url", "")).strip().rstrip("/")
        model = os.getenv("MUKBANG_VISION_MODEL") or settings.get("model")
        wire = provider.get("wire_api", "responses")
        if not base or not isinstance(model, str) or not model:
            raise ValueError
        style = {"responses": "responses", "chat": "chat_completions", "chat_completions": "chat_completions"}.get(wire)
        if style is None:
            raise ValueError
        env_name = provider.get("env_key")
        key = os.getenv(env_name, "") if isinstance(env_name, str) and env_name else ""
        if not key and not env_name:
            auth = home / "auth.json"
            if auth.is_file():
                key = json.loads(auth.read_text(encoding="utf-8-sig")).get("OPENAI_API_KEY", "")
            if not key:
                key = os.getenv("OPENAI_API_KEY", "")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("未找到当前GPT中转的API凭证；不会回退使用其他服务的密钥")
        return {"base_url": base, "model": model, "api_style": style, "api_key": key}
    except (OSError, ValueError, TypeError, AttributeError, KeyError) as exc:
        if isinstance(exc, ValueError) and str(exc).startswith("未找到当前GPT"):
            raise
        raise ValueError("无法读取当前GPT中转配置或凭证，请检查指定的本地配置目录") from None


class ProviderConfig:
    def __init__(self) -> None:
        _load_local_env()
        self._lock = RLock()
        self._trusted_http_base = None
        self._configuration_source = "manual"
        self._responses_stream = False
        self._codex_client_binding = None
        self._codex_client_compat_requested = os.getenv(
            "MUKBANG_VISION_CODEX_CLIENT_COMPAT", "").lower() in {"1", "true", "yes"}
        self._timeout_seconds = validate_timeout_seconds(
            os.getenv("MUKBANG_VISION_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)))
        if os.getenv("MUKBANG_VISION_USE_CODEX_PROVIDER", "").lower() in {"1", "true", "yes"}:
            current = _current_gpt_connection()
            base = current["base_url"]
            self._trusted_http_base = base if urlsplit(base).scheme == "http" else None
            self._base = validate_base_url(base, trusted_http_base_url=self._trusted_http_base)
            self._model = current["model"]
            self._style = current["api_style"]
            self._key = current["api_key"]
            self._configuration_source = "codex"
            self._responses_stream = self._style == "responses"
            self._codex_client_binding = (self._base, self._model, self._style)
            return
        explicit_base = os.getenv("MUKBANG_VISION_BASE_URL") or os.getenv("OPENAI_BASE_URL")
        base = explicit_base or "https://dashscope.aliyuncs.com/compatible-mode/v1"
        self._base = validate_base_url(base)
        self._model = os.getenv("MUKBANG_VISION_MODEL", "qwen-vl-max")
        self._style = os.getenv("MUKBANG_VISION_API_STYLE", "chat_completions")
        self._key = os.getenv("MUKBANG_VISION_API_KEY", "")
        hostname = (urlsplit(base).hostname or "").lower()
        if not self._key and (hostname == "aliyuncs.com" or hostname.endswith(".aliyuncs.com")):
            self._key = os.getenv("DASHSCOPE_API_KEY", "")
        elif not self._key and (explicit_base or urlsplit(base).hostname == "api.openai.com"):
            self._key = os.getenv("OPENAI_API_KEY", "")

    def _codex_client_compat_active(self) -> bool:
        # The binding is independent of the HTTP-only transport exception:
        # HTTPS imports need the same complete provider/model/style boundary.
        return (self._codex_client_compat_requested and self._configuration_source == "codex"
                and self._style == "responses"
                and self._codex_client_binding == (self._base, self._model, self._style))

    def public(self) -> dict:
        with self._lock:
            hostname = urlsplit(self._base).hostname
            local = hostname in {"localhost", "127.0.0.1", "::1"}
            warning = ""
            if urlsplit(self._base).scheme == "http" and not local:
                warning = "HTTP 未加密：正在复用你指定的现有GPT中转地址，图片、文本和凭证存在被传输链路读取的风险；建议服务商提供HTTPS后切换。"
            return {"configured": bool(self._key) or local,
                    "provider": {"base_url": self._base, "model": self._model,
                                 "api_style": self._style, "key_configured": bool(self._key),
                                 "timeout_seconds": self._timeout_seconds,
                                 "configuration_source": self._configuration_source,
                                 "client_compatibility": (CODEX_CLIENT_COMPAT_PROFILE
                                                          if self._codex_client_compat_active() else "none"),
                                 "transport_warning": warning}}

    def update(self, values: dict) -> dict:
        with self._lock:
            base = validate_base_url(values.get("base_url", self._base), trusted_http_base_url=self._trusted_http_base)
            model = str(values.get("model", self._model)).strip()
            style = str(values.get("api_style", self._style))
            key = values.get("api_key")
            if not re.fullmatch(r"[\w.\-/:]{1,150}", model):
                raise ValueError("模型名称不能为空，且只能包含字母、数字、点、横线、斜线或冒号")
            if style not in {"chat_completions", "responses"}:
                raise ValueError("请选择支持的模型接口格式")
            if key and (len(key) > 2000 or any(ord(c) < 33 or ord(c) > 126 for c in key)):
                raise ValueError("API Key 只能使用可见 ASCII 字符，不能包含换行或空格")
            # Never accidentally send an old provider's credential to a new host.
            if _origin(base) != _origin(self._base) and not key:
                self._key = ""
            if ((base, model, style) != (self._base, self._model, self._style)
                    or (key and key != self._key)):
                self._configuration_source = "manual"
            if _origin(base) != _origin(self._base):
                self._responses_stream = False
            if key:
                self._key = key
            self._base, self._model, self._style = base, model, style
            return self.public()

    def private(self) -> dict:
        with self._lock:
            if not self.public()["configured"]:
                raise ValueError("请先在“模型连接”填写视觉模型的 API Key；密钥只保留在本地服务内存中")
            return {"base_url": self._base, "model": self._model, "api_style": self._style,
                    "api_key": self._key, "timeout_seconds": self._timeout_seconds,
                    "stream": self._responses_stream and self._style == "responses", "store": False,
                    "codex_client_compat": self._codex_client_compat_active(),
                    "trusted_http_base_url": self._trusted_http_base}
