# TESS AI — Product Requirements

## Overview
TESS AI (by Tesslcrum) is a Gemini-inspired educational chat companion for Indian school students (Grades 6-12) and teachers. It uses Firebase for auth/data/storage and Google Gemini (via emergentintegrations) for AI answers grounded in the user's own class textbook PDFs.

## Core features
1. **Firebase Authentication** — Email/Password + Google OAuth (via Firebase JS SDK).
2. **Onboarding** — Role picker (Teacher / Student). Students pick class 6-12. Profile persisted in Firestore `users/{uid}`.
3. **Textbook-aware chat** — When a student sends a message, backend detects the subject and the frontend queries Firestore `books_registry` for `{class, subject}` to fetch the PDF from Firebase Storage. The PDF is passed to Gemini 2.5 Flash as multimodal file input.
4. **Gemini-style UI** — Pure white canvas, light grey user bubbles (right), plain-text AI responses (left), collapsible sidebar with New Chat + Recent History.
5. **Multi-modal input bar** — Camera/image upload, mic (Web Speech API), send button. Focus states switch #F0F4F9 → white with blue border.
6. **AI response actions** — Thumbs up/down (logged to Firestore `feedback` + on message doc), Text-to-Speech (Web SpeechSynthesis on web / expo-speech on native).
7. **Chat history** — Sessions and messages stored under `chats/{uid}/sessions/{sid}/messages`.
8. **Books registry seeding** — Auto-seeds a class × subject grid pointing to `school_textbooks/class_${cls}/${subject}.pdf` on first visit.

## Data model (Firestore)
- `users/{uid}`: { uid, email, role, currentClass, createdAt }
- `books_registry/{docId}`: { class, subject, pdfPath, pdfUrl?, title }
- `chats/{uid}/sessions/{sid}`: { title, createdAt, updatedAt }
- `chats/{uid}/sessions/{sid}/messages/{mid}`: { role, text, imageBase64?, pdfUrl?, detectedSubject?, feedback?, createdAt }
- `feedback/{fid}`: { uid, sessionId, msgId, feedback, createdAt }

## Backend endpoints (FastAPI)
- `GET /api/health` — key status + model
- `POST /api/detect-subject` — { prompt } → { subject }
- `POST /api/tess/chat` — { prompt, pdfUrl?, imageBase64?, sessionId, currentClass?, role?, detectedSubject? } → { reply, sessionId, usedPdf, detectedSubject }
- `POST /api/tess/chat-stream` — SSE streaming variant

## Env
- Backend: `GEMINI_API_KEY`, `GEMINI_MODEL` (default gemini-2.5-flash), `MONGO_URL`, `DB_NAME`
- Frontend: `EXPO_PUBLIC_FIREBASE_*` (7 keys), `EXPO_PUBLIC_BACKEND_URL`

## Known caveats
- Speech-to-Text uses browser Web Speech API — works on Chrome/Edge desktop; falls back silently on unsupported browsers/native.
- Firebase Storage rules must allow read of `school_textbooks/**` for signed-in users (owner should configure).
- `books_registry` seed writes only when collection is empty. Real PDFs must be uploaded to the corresponding storage paths.
