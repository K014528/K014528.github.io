import os
import uuid
import base64
import logging
import tempfile
from pathlib import Path
from typing import Optional, List

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

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

app = FastAPI(title="TESS AI Backend")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("tess")

SYSTEM_MESSAGE = (
    "You are TESS AI, an educational tutor for Indian school students (Grades 6-12), "
    "built by Tesslcrum. You are warm, encouraging, and pedagogical. Follow these rules strictly:\n\n"
    "1. If a textbook PDF is provided in the attachments, treat it as the AUTHORITATIVE source. "
    "Locate the exact exercise/question/page the student refers to inside the PDF and answer using its content.\n"
    "2. Solutions must be step-by-step, using the same terminology and notation as the textbook.\n"
    "3. For theory pages, explain point-to-point in engaging, clear language a student can understand.\n"
    "4. Add small encouragements (e.g., 'Great question!', 'You've got this!') but don't overdo it.\n"
    "5. If the user is just chatting casually (greetings, personal talk), respond warmly WITHOUT forcing academic content.\n"
    "6. If a PDF is attached but the requested exercise/page isn't found, say so clearly and offer to help another way.\n"
    "7. Use markdown formatting (headings, bullet lists, **bold**) for clarity.\n"
    "8. Never invent textbook content; only use what's in the attached PDF for textbook-specific answers.\n"
)


class HistoryTurn(BaseModel):
    role: str  # "user" | "ai"
    text: str


class ChatRequest(BaseModel):
    prompt: str
    pdfUrl: Optional[str] = None
    imageBase64: Optional[str] = None
    sessionId: str = Field(default_factory=lambda: str(uuid.uuid4()))
    currentClass: Optional[int] = None
    role: Optional[str] = None
    detectedSubject: Optional[str] = None
    history: Optional[List[HistoryTurn]] = None


class ChatResponse(BaseModel):
    reply: str
    sessionId: str
    usedPdf: bool = False
    detectedSubject: Optional[str] = None


class SubjectDetectRequest(BaseModel):
    prompt: str


# Simple keyword map for subject detection (lightweight, no LLM needed)
SUBJECT_KEYWORDS = {
    "maths": ["math", "maths", "mathematics", "algebra", "geometry", "trigonometry", "calculus", "arithmetic", "equation"],
    "physics": ["physics", "motion", "force", "gravity", "electricity", "magnetism", "optics", "phy"],
    "chemistry": ["chemistry", "chemical", "reaction", "acid", "base", "compound", "molecule", "element", "periodic", "chem"],
    "biology": ["biology", "cell", "organism", "plant", "animal", "human body", "ecosystem", "evolution", "bio"],
    "history": ["history", "historical", "empire", "war", "civilization", "revolution", "ancient", "medieval"],
    "geography": ["geography", "map", "climate", "continent", "country", "river", "mountain", "population"],
    "english": ["english", "grammar", "poem", "poetry", "essay", "literature", "comprehension"],
    "hindi": ["hindi", "vyakaran", "kavita"],
    "civics": ["civics", "constitution", "democracy", "government", "parliament"],
    "economics": ["economics", "economy", "gdp", "supply", "demand", "market"],
    "computer": ["computer", "coding", "programming", "software", "hardware", "algorithm"],
    "sst": ["social studies", "sst", "social science"],
    "science": ["science"],
}


def detect_subject(prompt: str) -> Optional[str]:
    p = prompt.lower()
    # Prioritize exact single-word subjects appearing in prompt
    for subject, keywords in SUBJECT_KEYWORDS.items():
        for kw in keywords:
            if kw in p:
                return subject
    return None


@api_router.get("/")
async def root():
    return {"message": "TESS AI Backend running", "model": GEMINI_MODEL}


@api_router.get("/health")
async def health():
    return {"status": "ok", "has_gemini_key": bool(GEMINI_API_KEY), "model": GEMINI_MODEL}


@api_router.post("/detect-subject")
async def api_detect_subject(req: SubjectDetectRequest):
    return {"subject": detect_subject(req.prompt)}


async def _download_pdf_to_tempfile(url: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            r = await client.get(url)
            if r.status_code != 200:
                logger.warning(f"PDF download failed status={r.status_code} url={url[:80]}")
                return None
            fd, path = tempfile.mkstemp(suffix=".pdf")
            with os.fdopen(fd, "wb") as f:
                f.write(r.content)
            return path
    except Exception as e:
        logger.exception(f"PDF download error: {e}")
        return None


def _decode_image_to_tempfile(data_b64: str) -> Optional[tuple]:
    """Return (path, mime) or None."""
    try:
        # Support data URI or raw base64
        mime = "image/jpeg"
        raw = data_b64
        if data_b64.startswith("data:"):
            header, raw = data_b64.split(",", 1)
            if "png" in header:
                mime = "image/png"
            elif "webp" in header:
                mime = "image/webp"
            elif "jpeg" in header or "jpg" in header:
                mime = "image/jpeg"
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
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured on server")

    detected = req.detectedSubject or detect_subject(req.prompt)
    file_contents: List[FileContentWithMimeType] = []
    used_pdf = False
    temp_paths: List[str] = []

    # Attach PDF if URL provided
    if req.pdfUrl:
        pdf_path = await _download_pdf_to_tempfile(req.pdfUrl)
        if pdf_path:
            temp_paths.append(pdf_path)
            file_contents.append(FileContentWithMimeType(file_path=pdf_path, mime_type="application/pdf"))
            used_pdf = True

    # Attach image if provided
    if req.imageBase64:
        result = _decode_image_to_tempfile(req.imageBase64)
        if result:
            img_path, mime = result
            temp_paths.append(img_path)
            file_contents.append(FileContentWithMimeType(file_path=img_path, mime_type=mime))

    system_msg = SYSTEM_MESSAGE
    if req.currentClass:
        system_msg += f"\n\nThe current student is in Class {req.currentClass}."
    if detected:
        system_msg += f"\nDetected subject from prompt: {detected}."
    if req.role == "teacher":
        system_msg += "\nThe user is a TEACHER; be more concise and pedagogically detailed."

    # Inject prior conversation history so Gemini has memory of earlier turns.
    if req.history:
        # Limit to last 20 turns to keep prompt size reasonable.
        prior = req.history[-20:]
        transcript_lines = []
        for turn in prior:
            speaker = "Student" if turn.role == "user" else "TESS"
            transcript_lines.append(f"{speaker}: {turn.text}")
        transcript = "\n".join(transcript_lines)
        system_msg += (
            "\n\n---\nPRIOR CONVERSATION (for your memory; do not repeat, use only as context):\n"
            + transcript
            + "\n---\n"
        )

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
            detectedSubject=detected,
        )
    except Exception as e:
        logger.exception(f"Gemini call failed: {e}")
        raise HTTPException(status_code=503, detail="Server is currently busy. Please wait a moment and try again!")
    finally:
        # Cleanup temp files
        for p in temp_paths:
            try:
                os.remove(p)
            except Exception:
                pass


@api_router.post("/tess/chat-stream")
async def tess_chat_stream(req: ChatRequest):
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured on server")

    detected = req.detectedSubject or detect_subject(req.prompt)
    file_contents: List[FileContentWithMimeType] = []
    temp_paths: List[str] = []

    if req.pdfUrl:
        pdf_path = await _download_pdf_to_tempfile(req.pdfUrl)
        if pdf_path:
            temp_paths.append(pdf_path)
            file_contents.append(FileContentWithMimeType(file_path=pdf_path, mime_type="application/pdf"))

    if req.imageBase64:
        result = _decode_image_to_tempfile(req.imageBase64)
        if result:
            img_path, mime = result
            temp_paths.append(img_path)
            file_contents.append(FileContentWithMimeType(file_path=img_path, mime_type=mime))

    system_msg = SYSTEM_MESSAGE
    if req.currentClass:
        system_msg += f"\n\nThe current student is in Class {req.currentClass}."
    if detected:
        system_msg += f"\nDetected subject: {detected}."

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
            yield f"data: [ERROR] {str(e)[:200]}\n\n"
        finally:
            for p in temp_paths:
                try:
                    os.remove(p)
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
