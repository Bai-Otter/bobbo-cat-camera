"""Fail closed if a test accidentally uses a real HTTPX provider transport.

MockTransport and Starlette's in-process TestClient transport remain available.
This guards both sync and async paths when production network code changes.
"""
import httpx
import pytest


@pytest.fixture(autouse=True)
def block_real_provider_network(monkeypatch):
    def blocked_sync(*args, **kwargs):
        raise AssertionError("Offline tests must inject MockTransport, not contact a real provider")

    async def blocked_async(*args, **kwargs):
        raise AssertionError("Offline tests must inject MockTransport, not contact a real provider")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", blocked_sync)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked_async)
