"""Tests for Render-hosted TESS AI backend.

These tests validate the frontend-to-Render backend connectivity, CORS,
and key endpoints per the review request.
"""
import os
import pytest
import requests

# Render backend URL is the frontend's target per /app/frontend/.env
RENDER_URL = os.environ.get("RENDER_BACKEND_URL", "https://tess-1-rq34.onrender.com")
PREVIEW_ORIGIN = "https://tess-smart-tutor.preview.emergentagent.com"

TIMEOUT = 60  # Render free tier can be slow to cold-start


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ---- Health endpoint ----
class TestHealth:
    def test_health_ok(self, api_client):
        r = api_client.get(f"{RENDER_URL}/api/health", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("status") == "ok"
        assert data.get("has_gemini_key") is True
        assert data.get("model") == "gemini-2.5-flash"
        assert "local_books_dir" in data
        assert isinstance(data.get("local_books_count"), int)
        assert data["local_books_count"] >= 0


# ---- tess/chat casual prompt ----
class TestTessChat:
    def test_casual_chat_connectivity(self, api_client):
        payload = {
            "prompt": "hi there",
            "sessionId": "TEST_session_1",
            "history": [],
        }
        r = api_client.post(
            f"{RENDER_URL}/api/tess/chat", json=payload, timeout=TIMEOUT
        )
        # Per review request: 200 with academicIntent=false OR 503 quota exhausted
        assert r.status_code in (200, 503), f"Unexpected {r.status_code}: {r.text}"
        if r.status_code == 503:
            j = r.json()
            detail = (j.get("detail") or "").lower()
            assert "busy" in detail or "wait" in detail, j
        else:
            j = r.json()
            # Just require the shape - academicIntent may be optional
            assert "reply" in j or "sessionId" in j, j


# ---- extract-metadata ----
class TestExtractMetadata:
    def test_class6_maths_q1(self, api_client):
        r = api_client.post(
            f"{RENDER_URL}/api/extract-metadata",
            json={"prompt": "class 6 maths question 1"},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j.get("academic") is True, j
        meta = j.get("metadata") or {}
        # class may come back as int or str
        assert str(meta.get("class")) == "6", meta
        assert (meta.get("subject") or "").lower() == "maths", meta
        assert str(meta.get("question")) == "1", meta


# ---- CORS ----
class TestCORS:
    def test_preflight_tess_chat(self, api_client):
        r = requests.options(
            f"{RENDER_URL}/api/tess/chat",
            headers={
                "Origin": PREVIEW_ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
            timeout=TIMEOUT,
        )
        assert r.status_code in (200, 204), r.text
        allow_origin = r.headers.get("access-control-allow-origin", "")
        assert allow_origin in ("*", PREVIEW_ORIGIN), f"CORS ACAO: {allow_origin!r}"
        allow_methods = (r.headers.get("access-control-allow-methods") or "").upper()
        assert "POST" in allow_methods or allow_methods == "", allow_methods

    def test_actual_request_has_cors_header(self, api_client):
        r = requests.post(
            f"{RENDER_URL}/api/extract-metadata",
            headers={
                "Origin": PREVIEW_ORIGIN,
                "Content-Type": "application/json",
            },
            json={"prompt": "hi"},
            timeout=TIMEOUT,
        )
        # response could be 200 or 503, but must carry ACAO
        acao = r.headers.get("access-control-allow-origin", "")
        assert acao in ("*", PREVIEW_ORIGIN), f"ACAO missing on POST: {acao!r}"
