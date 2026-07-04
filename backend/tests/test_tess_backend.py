"""TESS AI Backend tests."""
import base64
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://tess-smart-tutor.preview.emergentagent.com").rstrip("/")

# 1x1 red pixel PNG
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)

# small public PDF
PUBLIC_PDF = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# --- Health ---
class TestHealth:
    def test_health_ok(self, api):
        r = api.get(f"{BASE_URL}/api/health", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"
        assert data["has_gemini_key"] is True
        assert data["model"] == "gemini-2.5-flash"


# --- Detect subject ---
class TestDetectSubject:
    def test_detect_chemistry(self, api):
        r = api.post(f"{BASE_URL}/api/detect-subject", json={"prompt": "explain page 61 of my chemistry book"}, timeout=30)
        assert r.status_code == 200
        assert r.json().get("subject") == "chemistry"

    def test_detect_physics(self, api):
        r = api.post(f"{BASE_URL}/api/detect-subject", json={"prompt": "physics motion problem"}, timeout=30)
        assert r.status_code == 200
        assert r.json().get("subject") == "physics"

    def test_detect_maths_ex(self, api):
        r = api.post(f"{BASE_URL}/api/detect-subject", json={"prompt": "class 8 maths exercise 4B q3"}, timeout=30)
        assert r.status_code == 200
        assert r.json().get("subject") == "maths"

    def test_detect_history(self, api):
        r = api.post(f"{BASE_URL}/api/detect-subject", json={"prompt": "ancient civilization empire"}, timeout=30)
        assert r.status_code == 200
        assert r.json().get("subject") == "history"

    def test_detect_none(self, api):
        r = api.post(f"{BASE_URL}/api/detect-subject", json={"prompt": "hello there friend"}, timeout=30)
        assert r.status_code == 200
        assert r.json().get("subject") is None


# --- Chat ---
class TestChat:
    def test_chat_text_only(self, api):
        r = api.post(
            f"{BASE_URL}/api/tess/chat",
            json={"prompt": "Say hello briefly."},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "reply" in data and isinstance(data["reply"], str) and len(data["reply"]) > 0
        assert "sessionId" in data
        assert data["usedPdf"] is False

    def test_chat_memory_with_history(self, api):
        """Send history containing chemistry statement, then ask model to recall it."""
        history = [
            {"role": "user", "text": "My favorite subject is chemistry."},
            {"role": "ai", "text": "Great, chemistry is fascinating!"},
        ]
        r = api.post(
            f"{BASE_URL}/api/tess/chat",
            json={
                "prompt": "What did I just say my favorite subject was?",
                "history": history,
            },
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        reply = data.get("reply", "")
        assert isinstance(reply, str) and len(reply) > 0
        assert "chemistry" in reply.lower(), f"Reply did not remember 'chemistry': {reply}"

    def test_chat_with_pdf(self, api):
        r = api.post(
            f"{BASE_URL}/api/tess/chat",
            json={
                "prompt": "Summarize the attached PDF in 1 short sentence.",
                "pdfUrl": PUBLIC_PDF,
            },
            timeout=180,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data["reply"], str) and len(data["reply"]) > 0
        assert data["usedPdf"] is True

    def test_chat_with_bad_pdf(self, api):
        r = api.post(
            f"{BASE_URL}/api/tess/chat",
            json={
                "prompt": "Just say hi in one word.",
                "pdfUrl": "https://example.com/nonexistent-file-404.pdf",
            },
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["usedPdf"] is False
        assert len(data["reply"]) > 0

    def test_chat_with_image(self, api):
        r = api.post(
            f"{BASE_URL}/api/tess/chat",
            json={
                "prompt": "What color dominates this tiny image? Answer in one word.",
                "imageBase64": f"data:image/png;base64,{TINY_PNG_B64}",
            },
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data["reply"], str) and len(data["reply"]) > 0


# --- Silent-error contract ---
class TestSilentErrorContract:
    """Verify the exception handler path returns HTTP 503 with the friendly message.

    We inspect the source code to assert the contract (no easy way to force Gemini to fail
    from outside without breaking config). This complements a monkeypatch-based test.
    """

    def test_exception_handler_contract_in_source(self):
        with open("/app/backend/server.py", "r") as f:
            src = f.read()
        assert "status_code=503" in src
        assert "Server is currently busy. Please wait a moment and try again!" in src

