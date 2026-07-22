from __future__ import annotations

from fastapi.testclient import TestClient
from starlette.middleware.gzip import GZipMiddleware

from app.main import app


def test_http_gzip_middleware_uses_bounded_production_settings() -> None:
    middleware = next(
        item for item in app.user_middleware if item.cls is GZipMiddleware
    )

    assert middleware.kwargs == {"minimum_size": 1024, "compresslevel": 5}


def test_large_http_json_is_gzipped_and_matches_identity_payload() -> None:
    client = TestClient(app)

    identity = client.get(
        "/openapi.json",
        headers={"Accept-Encoding": "identity"},
    )
    compressed = client.get(
        "/openapi.json",
        headers={"Accept-Encoding": "gzip"},
    )

    assert identity.status_code == compressed.status_code == 200
    assert len(identity.content) >= 1024
    assert "Content-Encoding" not in identity.headers
    assert compressed.headers["Content-Encoding"] == "gzip"
    # TestClient transparently decodes gzip; semantic JSON must stay identical.
    assert compressed.json() == identity.json()


def test_small_http_json_stays_uncompressed() -> None:
    response = TestClient(app).get(
        "/",
        headers={"Accept-Encoding": "gzip"},
    )

    assert response.status_code == 200
    assert len(response.content) < 1024
    assert "Content-Encoding" not in response.headers
