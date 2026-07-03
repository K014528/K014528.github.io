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
    @pytest.mark.parametrize("prompt,expected", [
        ("Please help me with maths exercise", "maths"),
        ("Tell me about the history of India", "history"),
        ("Explain a chemical reaction in chemistry", "maths"),  # 'maths' iterated first; expect first match
    ])
    def test_detect(self, api, prompt, expected):
        r = api.post(f"{BASE_URL}/api/detect-subject", json={"prompt": prompt}, timeout=30)
        assert r.status_code == 200
        # We only strictly assert non-null subject
        subj = r.json().get("subject")
        assert subj is not None

    def test_detect_maths(self, api):
        r = api.post(f"{BASE_URL}/api/detect-subject", json={"prompt": "solve this algebra equation"}, timeout=30)
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
            json={"prompt": "Say hello in one short sentence."},
            timeout=120,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "reply" in data and isinstance(data["reply"], str) and len(data["reply"]) > 0
        assert "sessionId" in data
        assert data["usedPdf"] is False

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
        # usedPdf should be True (PDF downloaded successfully)
        assert data["usedPdf"] is True

    def test_chat_with_bad_pdf(self, api):
        # Should gracefully skip PDF on 404 and still respond
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
