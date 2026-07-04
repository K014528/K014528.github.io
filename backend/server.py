import os
import re
import uuid
import base64
import logging
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Optional, List, Tuple
from urllib.parse import quote

import httpx
from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from emergentintegrations.llm.chat import (
    LlmChat,
    UserMessage,
    FileContentWithMimeType,
    TextDelta,
    StreamDone,
)

from pypdf import PdfReader

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "")
FIREBASE_WEB_API_KEY = os.environ.get("FIREBASE_WEB_API_KEY", "")
FIREBASE_STORAGE_BUCKET = os.environ.get("FIREBASE_STORAGE_BUCKET", "")

# Directory where local PDF textbooks live. Filenames should follow the pattern:
#   NCERT-books-for-class-{class}-{subject}.pdf
# Case-insensitive; see resolve_local_pdf() for the full matching logic.
LOCAL_BOOKS_DIR = Path(os.environ.get("LOCAL_BOOKS_DIR", str(ROOT_DIR / "local_books")))
LOCAL_BOOKS_DIR.mkdir(parents=True, exist_ok=True)

BUSY_MSG = "Server is currently busy. Please wait a moment and try again!"

app = FastAPI(title="TESS AI Backend")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("tess")


# ---------- Models ----------
class HistoryTurn(BaseModel):
    role: str
    text: str


class ChatRequest(BaseModel):
    prompt: str
    imageBase64: Optional[str] = None
    sessionId: str = Field(default_factory=lambda: str(uuid.uuid4()))
    currentClass: Optional[int] = None
    role: Optional[str] = None
    history: Optional[List[HistoryTurn]] = None
    # Optional overrides (used mostly for testing); the backend infers all of these itself otherwise.
    pdfUrl: Optional[str] = None
    detectedSubject: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    sessionId: str
    usedPdf: bool = False
    detectedSubject: Optional[str] = None
    detectedClass: Optional[int] = None
    detectedPage: Optional[int] = None
    detectedExercise: Optional[str] = None
    detectedQuestion: Optional[str] = None
    academicIntent: bool = False
    pdfFound: bool = False


class SubjectDetectRequest(BaseModel):
    prompt: str


# ---------- Subject / metadata extraction ----------
SUBJECT_KEYWORDS = {
    "maths": ["math", "maths", "mathematics", "algebra", "geometry", "trigonometry", "calculus", "arithmetic", "equation"],
    "physics": ["physics", "phy"],
    "chemistry": ["chemistry", "chemical", "acid", "base", "compound", "molecule", "element", "periodic", "chem"],
    "biology": ["biology", "cell", "organism", "photosynthesis", "ecosystem", "bio"],
    "history": ["history", "historical", "empire", "war", "civilization", "revolution", "ancient", "medieval"],
    "geography": ["geography", "map", "climate", "continent", "river", "mountain"],
    "english": ["english", "grammar", "poem", "poetry", "essay", "literature", "comprehension"],
    "hindi": ["hindi", "vyakaran", "kavita"],
    "civics": ["civics", "constitution", "democracy", "government", "parliament"],
    "economics": ["economics", "economy", "gdp", "supply", "demand", "market"],
    "computer": ["computer", "coding", "programming", "software", "algorithm"],
    "sst": ["social studies", "sst", "social science"],
    "science": ["science"],
}

ACADEMIC_MARKERS = re.compile(
    r"\b(class\s*\d+|grade\s*\d+|chapter|exercise|ex\.?\s*\d|question\s*\d|q\s*\d|page|pg\.?|textbook|book|solve|explain|derive|theorem|lesson|topic|paragraph)\b",
    re.IGNORECASE,
)


def detect_subject(prompt: str) -> Optional[str]:
    p = prompt.lower()
    for subject, keywords in SUBJECT_KEYWORDS.items():
        for kw in keywords:
            if re.search(rf"\b{re.escape(kw)}\b", p):
                return subject
    return None


def extract_metadata(prompt: str, profile_class: Optional[int]) -> dict:
    p = prompt.lower()

    # Class: try "class 8", "grade 8", "8th class/standard/grade"
    class_num: Optional[int] = None
    m = re.search(r"\bclass\s*(\d{1,2})\b", p) or re.search(r"\bgrade\s*(\d{1,2})\b", p)
    if not m:
        m = re.search(r"\b(\d{1,2})\s*(?:th|st|nd|rd)\s*(?:class|grade|standard)\b", p)
    if m:
        try:
            class_num = int(m.group(1))
        except Exception:
            class_num = None
    if class_num is None:
        class_num = profile_class

    subject = detect_subject(prompt)

    # Page number
    page: Optional[int] = None
    m_p = re.search(r"\bpage\s*(?:no\.?|number)?\s*(\d{1,4})\b", p) or re.search(r"\bpg\.?\s*(\d{1,4})\b", p)
    if m_p:
        try:
            page = int(m_p.group(1))
        except Exception:
            page = None

    # Exercise (e.g., "exercise 4B", "ex. 4b", "exercise 4.2")
    exercise: Optional[str] = None
    m_e = re.search(r"\bexercise\s*([0-9]+[a-z]?(?:\.\d+)?)\b", p) or re.search(r"\bex\.?\s*([0-9]+[a-z]?(?:\.\d+)?)\b", p)
    if m_e:
        exercise = m_e.group(1).upper()

    # Question number
    question: Optional[str] = None
    m_q = re.search(r"\bquestion\s*(?:no\.?\s*)?(\d{1,3})\b", p) or re.search(r"\bq\s*(?:no\.?\s*)?(\d{1,3})\b", p)
    if m_q:
        question = m_q.group(1)

    return {"class": class_num, "subject": subject, "page": page, "exercise": exercise, "question": question}


def is_academic_intent(prompt: str, metadata: dict) -> bool:
    """Only trigger PDF pipeline for study-related queries."""
    if metadata.get("subject") or metadata.get("page") or metadata.get("exercise") or metadata.get("question"):
        return True
    if ACADEMIC_MARKERS.search(prompt):
        return True
    return False


# ---------- Local PDF resolver ----------
# Preferred filename convention:
#   NCERT-books-for-class-{class}-{subject}.pdf
# We also try common variants and, as a final fallback, fuzzy substring match on
# any file in LOCAL_BOOKS_DIR that mentions both the class number and subject word.
SUBJECT_ALIASES = {
    "maths": ["maths", "math", "mathematics"],
    "science": ["science"],
    "physics": ["physics"],
    "chemistry": ["chemistry"],
    "biology": ["biology", "bio"],
    "history": ["history"],
    "geography": ["geography", "geo"],
    "english": ["english"],
    "hindi": ["hindi"],
    "civics": ["civics", "polity", "political"],
    "economics": ["economics", "economy"],
    "computer": ["computer", "computing", "informatics"],
    "sst": ["sst", "social"],
}


def resolve_local_pdf(class_num: int, subject: str) -> Optional[Path]:
    """Return the Path of a locally stored textbook PDF matching {class_num, subject}, or None."""
    if not class_num or not subject:
        return None
    aliases = SUBJECT_ALIASES.get(subject, [subject])
    # 1) Try exact convention filenames first.
    candidates: List[Path] = []
    for alias in aliases:
        candidates.append(LOCAL_BOOKS_DIR / f"NCERT-books-for-class-{class_num}-{alias}.pdf")
        candidates.append(LOCAL_BOOKS_DIR / f"ncert-books-for-class-{class_num}-{alias}.pdf")
        candidates.append(LOCAL_BOOKS_DIR / f"class-{class_num}-{alias}.pdf")
        candidates.append(LOCAL_BOOKS_DIR / f"class_{class_num}_{alias}.pdf")
        candidates.append(LOCAL_BOOKS_DIR / f"{alias}-class-{class_num}.pdf")
    for c in candidates:
        if c.is_file():
            return c

    # 2) Case-insensitive fuzzy scan: any .pdf that contains both the class token and any alias.
    class_tokens = [f"class-{class_num}", f"class_{class_num}", f"class {class_num}", f"cls{class_num}"]
    try:
        for f in LOCAL_BOOKS_DIR.iterdir():
            if not f.is_file() or f.suffix.lower() != ".pdf":
                continue
            name = f.name.lower()
            if any(tok in name for tok in class_tokens) and any(a in name for a in aliases):
                return f
    except Exception as e:
        logger.warning(f"Local book scan error: {e}")
    return None


def read_local_pdf_bytes(path: Path) -> Optional[bytes]:
    try:
        return path.read_bytes()
    except Exception as e:
        logger.warning(f"read_local_pdf_bytes({path}) failed: {e}")
        return None


# ---------- Firebase (REST) helpers ----------
async def firestore_find_book(class_num: int, subject: str) -> Optional[dict]:
    """Query books_registry via Firestore REST runQuery API. Returns {pdfPath, pdfUrl?} or None."""
    if not FIREBASE_PROJECT_ID or not FIREBASE_WEB_API_KEY:
        return None
    url = (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents:runQuery?key={FIREBASE_WEB_API_KEY}"
    )
    body = {
        "structuredQuery": {
            "from": [{"collectionId": "books_registry"}],
            "where": {
                "compositeFilter": {
                    "op": "AND",
                    "filters": [
                        {"fieldFilter": {"field": {"fieldPath": "class"}, "op": "EQUAL",
                                          "value": {"integerValue": str(class_num)}}},
                        {"fieldFilter": {"field": {"fieldPath": "subject"}, "op": "EQUAL",
                                          "value": {"stringValue": subject}}},
                    ],
                }
            },
            "limit": 1,
        }
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(url, json=body)
            if r.status_code != 200:
                logger.warning(f"Firestore query failed status={r.status_code} body={r.text[:200]}")
                return None
            data = r.json()
            for row in data:
                doc = row.get("document")
                if not doc:
                    continue
                fields = doc.get("fields", {})
                pdf_path = fields.get("pdfPath", {}).get("stringValue")
                pdf_url = fields.get("pdfUrl", {}).get("stringValue")
                if pdf_path or pdf_url:
                    return {"pdfPath": pdf_path, "pdfUrl": pdf_url}
    except Exception as e:
        logger.warning(f"Firestore query error: {e}")
    return None


def storage_media_url(path: str) -> str:
    encoded = quote(path, safe="")
    return f"https://firebasestorage.googleapis.com/v0/b/{FIREBASE_STORAGE_BUCKET}/o/{encoded}?alt=media"


async def download_pdf_bytes(url: str) -> Optional[bytes]:
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            r = await client.get(url)
            if r.status_code != 200:
                logger.warning(f"PDF download {r.status_code} @ {url[:100]}")
                return None
            return r.content
    except Exception as e:
        logger.warning(f"PDF download error: {e}")
        return None


# ---------- PDF text extraction ----------
def extract_relevant_text(
    pdf_bytes: bytes,
    page: Optional[int],
    exercise: Optional[str],
    question: Optional[str],
) -> Tuple[str, int]:
    """Return (context_text, total_pages). Slice around requested page and/or exercise/question."""
    try:
        reader = PdfReader(BytesIO(pdf_bytes))
    except Exception as e:
        logger.warning(f"PdfReader failed: {e}")
        return ("", 0)
    total = len(reader.pages)
    if total == 0:
        return ("", 0)

    def read_page(i: int) -> str:
        try:
            return reader.pages[i].extract_text() or ""
        except Exception:
            return ""

    parts: List[str] = []

    # 1) If page specified, take a window: [page-1, page, page+1] (1-indexed input).
    if page and 1 <= page <= total:
        start = max(0, page - 2)
        end = min(total, page + 1)
        for i in range(start, end):
            parts.append(f"[Page {i + 1}]\n{read_page(i)}")

    # 2) If exercise/question, scan whole (bounded) doc for the marker and slice around it.
    if exercise or question:
        # Bounded scan: up to first 200 pages to keep runtime sane.
        scan_end = min(total, 200)
        full_text_pieces = []
        for i in range(scan_end):
            full_text_pieces.append((i, read_page(i)))
        joined = "\n\n".join(f"[Page {i + 1}]\n{t}" for i, t in full_text_pieces)

        markers: List[str] = []
        if exercise:
            markers.append(rf"exercise\s*{re.escape(exercise)}\b")
            markers.append(rf"ex\.?\s*{re.escape(exercise)}\b")
        if question:
            markers.append(rf"question\s*(?:no\.?\s*)?{re.escape(question)}\b")
            markers.append(rf"q\s*(?:no\.?\s*)?{re.escape(question)}\b")

        for pat in markers:
            m = re.search(pat, joined, re.IGNORECASE)
            if m:
                s = max(0, m.start() - 400)
                e = min(len(joined), m.start() + 5000)
                parts.append(f"[Exercise/Question match]\n{joined[s:e]}")
                break

    # 3) If nothing specified, take the first ~15 pages as a general context.
    if not parts:
        for i in range(min(total, 15)):
            parts.append(f"[Page {i + 1}]\n{read_page(i)}")

    context = "\n\n".join(parts)
    # Hard cap on injected characters to keep the prompt bounded.
    if len(context) > 60000:
        context = context[:60000] + "\n\n[... truncated ...]"
    return context, total


# ---------- System prompts ----------
def build_academic_system(meta: dict, pdf_context: str, total_pages: int) -> str:
    header = (
        "You are TESS AI, an educational tutor for Indian school students (Grades 6-12), built by Tesslcrum.\n"
        "STRICT RULES for this reply:\n"
        "1. Answer ONLY using the TEXTBOOK CONTEXT provided below. Do NOT use your pre-trained general knowledge to invent textbook content.\n"
        "2. If the specific page/exercise/question the student asked about is NOT present in the context, respond exactly with:\n"
        "   \"I couldn't locate that in your textbook. Please double-check the page/exercise number.\"\n"
        "3. Quote or paraphrase directly from the textbook text; keep terminology and notation identical.\n"
        "4. Provide step-by-step solutions for numerical problems; explain theory point-to-point in clear, engaging language.\n"
        "5. Use markdown formatting (headings, bullet lists, **bold**).\n"
    )
    meta_str = (
        f"\nStudent context: class={meta.get('class')}, subject={meta.get('subject')}, "
        f"page={meta.get('page')}, exercise={meta.get('exercise')}, question={meta.get('question')}. "
        f"Total pages in PDF: {total_pages}.\n"
    )
    return header + meta_str + "\n===== TEXTBOOK CONTEXT (from Firebase) =====\n" + pdf_context + "\n===== END TEXTBOOK CONTEXT =====\n"


def build_casual_system(meta: dict) -> str:
    return (
        "You are TESS AI, a warm, friendly study companion for Indian school students, built by Tesslcrum.\n"
        "This message appears to be casual conversation (greeting or general chat), NOT a textbook question.\n"
        "Respond briefly and warmly. Do not force academic content. If the user wants study help, they can ask about "
        "a specific chapter, page, or exercise.\n"
        f"Known student profile: class={meta.get('class')}."
    )


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "TESS AI Backend running", "model": GEMINI_MODEL}


@api_router.get("/health")
async def health():
    local_pdfs = []
    try:
        local_pdfs = sorted([f.name for f in LOCAL_BOOKS_DIR.iterdir() if f.is_file() and f.suffix.lower() == ".pdf"])
    except Exception:
        local_pdfs = []
    return {
        "status": "ok",
        "has_gemini_key": bool(GEMINI_API_KEY),
        "model": GEMINI_MODEL,
        "has_firebase_config": bool(FIREBASE_PROJECT_ID and FIREBASE_WEB_API_KEY),
        "local_books_dir": str(LOCAL_BOOKS_DIR),
        "local_books_count": len(local_pdfs),
        "local_books_sample": local_pdfs[:10],
    }


@api_router.get("/local-books")
async def list_local_books():
    files = []
    try:
        for f in sorted(LOCAL_BOOKS_DIR.iterdir()):
            if f.is_file() and f.suffix.lower() == ".pdf":
                files.append({"name": f.name, "size_bytes": f.stat().st_size})
    except Exception as e:
        logger.warning(f"list_local_books err: {e}")
    return {"dir": str(LOCAL_BOOKS_DIR), "files": files}


@api_router.post("/detect-subject")
async def api_detect_subject(req: SubjectDetectRequest):
    return {"subject": detect_subject(req.prompt)}


@api_router.post("/extract-metadata")
async def api_extract_metadata(req: SubjectDetectRequest):
    """Debug helper: shows what the backend would extract from a prompt."""
    meta = extract_metadata(req.prompt, None)
    return {"metadata": meta, "academic": is_academic_intent(req.prompt, meta)}


def _decode_image_to_tempfile(data_b64: str) -> Optional[Tuple[str, str]]:
    try:
        mime = "image/jpeg"
        raw = data_b64
        if data_b64.startswith("data:"):
            header, raw = data_b64.split(",", 1)
            if "png" in header:
                mime = "image/png"
            elif "webp" in header:
                mime = "image/webp"
        img_bytes = base64.b64decode(raw)
        suffix = ".png" if mime == "image/png" else ".jpg"
        fd, path = tempfile.mkstemp(suffix=suffix)
        with os.fdopen(fd, "wb") as f:
            f.write(img_bytes)
        return path, mime
    except Exception as e:
        logger.exception(f"Image decode error: {e}")
        return None


@api_router.post("/tess/chat", response_model=ChatResponse)
async def tess_chat(req: ChatRequest):
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail=BUSY_MSG)

    # 1) Extract metadata from prompt (Class, Subject, Page, Exercise, Question)
    meta = extract_metadata(req.prompt, req.currentClass)
    if req.detectedSubject and not meta["subject"]:
        meta["subject"] = req.detectedSubject
    academic = is_academic_intent(req.prompt, meta)

    # 2) Handle image attachment (multimodal) — image goes as file to Gemini regardless.
    image_file: Optional[FileContentWithMimeType] = None
    temp_img_path: Optional[str] = None
    if req.imageBase64:
        result = _decode_image_to_tempfile(req.imageBase64)
        if result:
            temp_img_path, mime = result
            image_file = FileContentWithMimeType(file_path=temp_img_path, mime_type=mime)

    pdf_found = False
    used_pdf = False
    pdf_context = ""
    total_pages = 0
    not_found_reason: Optional[str] = None

    # 3) If academic AND we have class+subject → retrieve PDF (LOCAL FIRST, Firebase fallback)
    if academic and meta.get("class") and meta.get("subject"):
        pdf_bytes: Optional[bytes] = None
        source: Optional[str] = None

        if req.pdfUrl:
            # Optional direct override (backward compat / tests).
            pdf_bytes = await download_pdf_bytes(req.pdfUrl)
            if pdf_bytes:
                pdf_found = True
                source = "override_url"
            else:
                not_found_reason = "pdf_unreachable"
        else:
            # (a) Try LOCAL first: /app/backend/local_books/NCERT-books-for-class-{cls}-{subj}.pdf
            local_path = resolve_local_pdf(meta["class"], meta["subject"])
            if local_path is not None:
                pdf_bytes = read_local_pdf_bytes(local_path)
                if pdf_bytes:
                    pdf_found = True
                    source = f"local:{local_path.name}"
                else:
                    not_found_reason = "pdf_unreachable"

            # (b) Fallback: Firebase Firestore + Storage (only if local miss).
            if not pdf_bytes:
                book = await firestore_find_book(meta["class"], meta["subject"])
                if book:
                    pdf_found = True
                    if book.get("pdfUrl"):
                        pdf_bytes = await download_pdf_bytes(book["pdfUrl"])
                    if not pdf_bytes and book.get("pdfPath"):
                        pdf_bytes = await download_pdf_bytes(storage_media_url(book["pdfPath"]))
                    if pdf_bytes:
                        source = "firebase"
                    else:
                        not_found_reason = "pdf_unreachable"
                elif not not_found_reason:
                    not_found_reason = "no_registry_entry"

        if pdf_bytes:
            pdf_context, total_pages = extract_relevant_text(
                pdf_bytes, meta.get("page"), meta.get("exercise"), meta.get("question")
            )
            if pdf_context.strip():
                used_pdf = True
                logger.info(f"PDF context injected from {source}: {len(pdf_context)} chars, {total_pages} pages")
            else:
                not_found_reason = not_found_reason or "pdf_extract_empty"

    # 4) Build system message based on intent + PDF availability
    if academic and used_pdf:
        system_msg = build_academic_system(meta, pdf_context, total_pages)
    elif academic and not used_pdf and meta.get("subject") and meta.get("class"):
        # Academic query but no PDF — return a clear, friendly not-found note.
        expected_name = f"NCERT-books-for-class-{meta['class']}-{meta['subject']}.pdf"
        reason_txt = {
            "no_registry_entry": (
                f"I couldn't find a Class {meta['class']} {meta['subject']} textbook in the local library. "
                f"Please drop `{expected_name}` into `backend/local_books/` and try again."
            ),
            "pdf_unreachable": f"I found the Class {meta['class']} {meta['subject']} entry but couldn't open the PDF right now.",
            "pdf_extract_empty": f"I opened the Class {meta['class']} {meta['subject']} PDF but couldn't extract readable text from it (it may be a scanned/image-only PDF).",
        }.get(not_found_reason or "", "I couldn't access your textbook right now.")
        return ChatResponse(
            reply=f"⚠️ {reason_txt}",
            sessionId=req.sessionId,
            usedPdf=False,
            detectedSubject=meta.get("subject"),
            detectedClass=meta.get("class"),
            detectedPage=meta.get("page"),
            detectedExercise=meta.get("exercise"),
            detectedQuestion=meta.get("question"),
            academicIntent=True,
            pdfFound=pdf_found,
        )
    else:
        system_msg = build_casual_system(meta)

    # 5) Attach prior conversation (memory)
    if req.history:
        prior = req.history[-20:]
        transcript = "\n".join(
            f"{('Student' if t.role == 'user' else 'TESS')}: {t.text}" for t in prior
        )
        system_msg += (
            "\n\n---\nPRIOR CONVERSATION (context, do not repeat):\n" + transcript + "\n---\n"
        )

    file_contents: List[FileContentWithMimeType] = []
    if image_file:
        file_contents.append(image_file)

    try:
        chat = LlmChat(
            api_key=GEMINI_API_KEY,
            session_id=req.sessionId,
            system_message=system_msg,
        ).with_model("gemini", GEMINI_MODEL)

        user_msg = UserMessage(text=req.prompt, file_contents=file_contents if file_contents else None)
        reply_text = await chat.send_message(user_msg)

        return ChatResponse(
            reply=str(reply_text),
            sessionId=req.sessionId,
            usedPdf=used_pdf,
            detectedSubject=meta.get("subject"),
            detectedClass=meta.get("class"),
            detectedPage=meta.get("page"),
            detectedExercise=meta.get("exercise"),
            detectedQuestion=meta.get("question"),
            academicIntent=academic,
            pdfFound=pdf_found,
        )
    except Exception as e:
        logger.exception(f"Gemini call failed: {e}")
        raise HTTPException(status_code=503, detail=BUSY_MSG)
    finally:
        if temp_img_path:
            try:
                os.remove(temp_img_path)
            except Exception:
                pass


@api_router.post("/tess/chat-stream")
async def tess_chat_stream(req: ChatRequest):
    """SSE variant — reuses the same pipeline as /tess/chat."""
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail=BUSY_MSG)

    meta = extract_metadata(req.prompt, req.currentClass)
    if req.detectedSubject and not meta["subject"]:
        meta["subject"] = req.detectedSubject
    academic = is_academic_intent(req.prompt, meta)

    image_file: Optional[FileContentWithMimeType] = None
    temp_img_path: Optional[str] = None
    if req.imageBase64:
        result = _decode_image_to_tempfile(req.imageBase64)
        if result:
            temp_img_path, mime = result
            image_file = FileContentWithMimeType(file_path=temp_img_path, mime_type=mime)

    pdf_context = ""
    total_pages = 0
    used_pdf = False
    if academic and meta.get("class") and meta.get("subject"):
        pdf_bytes: Optional[bytes] = None
        local_path = resolve_local_pdf(meta["class"], meta["subject"])
        if local_path is not None:
            pdf_bytes = read_local_pdf_bytes(local_path)
        if not pdf_bytes:
            book = await firestore_find_book(meta["class"], meta["subject"])
            if book:
                if book.get("pdfUrl"):
                    pdf_bytes = await download_pdf_bytes(book["pdfUrl"])
                if not pdf_bytes and book.get("pdfPath"):
                    pdf_bytes = await download_pdf_bytes(storage_media_url(book["pdfPath"]))
        if pdf_bytes:
            pdf_context, total_pages = extract_relevant_text(
                pdf_bytes, meta.get("page"), meta.get("exercise"), meta.get("question")
            )
            if pdf_context.strip():
                used_pdf = True

    system_msg = (
        build_academic_system(meta, pdf_context, total_pages)
        if academic and used_pdf
        else build_casual_system(meta)
    )
    if req.history:
        prior = req.history[-20:]
        transcript = "\n".join(
            f"{('Student' if t.role == 'user' else 'TESS')}: {t.text}" for t in prior
        )
        system_msg += "\n\n---\nPRIOR CONVERSATION (context):\n" + transcript + "\n---\n"

    file_contents: List[FileContentWithMimeType] = []
    if image_file:
        file_contents.append(image_file)

    async def event_gen():
        try:
            chat = LlmChat(
                api_key=GEMINI_API_KEY,
                session_id=req.sessionId,
                system_message=system_msg,
            ).with_model("gemini", GEMINI_MODEL)
            user_msg = UserMessage(text=req.prompt, file_contents=file_contents if file_contents else None)
            async for ev in chat.stream_message(user_msg):
                if isinstance(ev, TextDelta):
                    yield f"data: {ev.content}\n\n"
                elif isinstance(ev, StreamDone):
                    yield "data: [DONE]\n\n"
                    break
        except Exception as e:
            logger.exception(f"stream error: {e}")
            yield f"data: [ERROR] {BUSY_MSG}\n\n"
        finally:
            if temp_img_path:
                try:
                    os.remove(temp_img_path)
                except Exception:
                    pass

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
