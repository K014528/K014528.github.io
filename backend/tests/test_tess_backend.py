"""TESS AI Backend tests — new pipeline (metadata extraction + intent filter + Firestore + pypdf)."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://tess-smart-tutor.preview.emergentagent.com").rstrip("/")

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
        assert data["has_firebase_config"] is True


# --- Metadata extraction ---
class TestExtractMetadata:
    def test_extract_full_academic(self, api):
        r = api.post(f"{BASE_URL}/api/extract-metadata",
                     json={"prompt": "solve class 8 maths exercise 4B question 3"}, timeout=30)
        assert r.status_code == 200
        body = r.json()
        m = body["metadata"]
        assert m["class"] == 8
        assert m["subject"] == "maths"
        assert m["exercise"] == "4B"
        assert m["question"] == "3"
        assert body["academic"] is True

    def test_extract_page_history(self, api):
        r = api.post(f"{BASE_URL}/api/extract-metadata",
                     json={"prompt": "explain page 61 of my history book"}, timeout=30)
        assert r.status_code == 200
        body = r.json()
        m = body["metadata"]
        assert m["subject"] == "history"
        assert m["page"] == 61
        assert body["academic"] is True

    def test_extract_casual(self, api):
        r = api.post(f"{BASE_URL}/api/extract-metadata",
                     json={"prompt": "hi how are you"}, timeout=30)
        assert r.status_code == 200
        body = r.json()
        m = body["metadata"]
        assert m["subject"] is None
        assert m["page"] is None
        assert m["exercise"] is None
        assert m["question"] is None
        assert body["academic"] is False


# --- Chat pipeline ---
class TestChatCasual:
    def test_casual_no_firestore(self, api):
        r = api.post(f"{BASE_URL}/api/tess/chat",
                     json={"prompt": "hi, how are you?"}, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["academicIntent"] is False
        assert d["usedPdf"] is False
        assert d["pdfFound"] is False
        assert isinstance(d["reply"], str) and len(d["reply"]) > 0


class TestChatAcademic:
    def test_academic_firestore_lookup(self, api):
        """Class 8 + maths exercise; backend hits Firestore.
        Accept either usedPdf=true (reply has content) OR a friendly not-found ⚠️ message.
        """
        r = api.post(f"{BASE_URL}/api/tess/chat",
                     json={"prompt": "Solve class 8 maths exercise 4B question 3",
                           "currentClass": 8}, timeout=180)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["academicIntent"] is True
        assert d["detectedClass"] == 8
        assert d["detectedSubject"] == "maths"
        assert isinstance(d["reply"], str) and len(d["reply"]) > 0
        # It must NEVER be a raw stack trace
        assert "Traceback" not in d["reply"]
        assert "Exception" not in d["reply"] or "⚠️" in d["reply"]
        # Either usedPdf True OR friendly warning
        if not d["usedPdf"]:
            assert "⚠️" in d["reply"] or "couldn" in d["reply"].lower()

    def test_academic_no_class_graceful(self, api):
        """No class detected + no currentClass → should degrade gracefully to casual, no raw error."""
        r = api.post(f"{BASE_URL}/api/tess/chat",
                     json={"prompt": "explain photosynthesis"}, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        assert isinstance(d["reply"], str) and len(d["reply"]) > 0
        assert "Traceback" not in d["reply"]

    def test_memory_history(self, api):
        history = [
            {"role": "user", "text": "My favorite subject is chemistry."},
            {"role": "ai", "text": "Great, chemistry is fascinating!"},
        ]
        r = api.post(f"{BASE_URL}/api/tess/chat",
                     json={"prompt": "What did I just say my favorite subject was?",
                           "history": history}, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "chemistry" in d["reply"].lower(), f"Reply lost memory: {d['reply']}"

    def test_pdf_override_extraction(self, api):
        """Use pdfUrl override with an academic prompt to prove PDF-text extraction pipeline works."""
        r = api.post(f"{BASE_URL}/api/tess/chat",
                     json={"prompt": "summarize page 1 of my class 8 maths book briefly",
                           "currentClass": 8,
                           "pdfUrl": PUBLIC_PDF}, timeout=180)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["academicIntent"] is True
        assert d["usedPdf"] is True, f"Expected usedPdf=true with override PDF: {d}"
        assert isinstance(d["reply"], str) and len(d["reply"]) > 0


# --- Silent-error contract ---
class TestSilentErrorContract:
    def test_exception_handler_contract_in_source(self):
        with open("/app/backend/server.py", "r") as f:
            src = f.read()
        assert "status_code=503" in src
        assert "Server is currently busy. Please wait a moment and try again!" in src
