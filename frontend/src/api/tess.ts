const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

export type ChatApiRequest = {
  prompt: string;
  pdfUrl?: string | null;
  imageBase64?: string | null;
  sessionId: string;
  currentClass?: number | null;
  role?: string | null;
  detectedSubject?: string | null;
  history?: { role: "user" | "ai"; text: string }[];
};

export type ChatApiResponse = {
  reply: string;
  sessionId: string;
  usedPdf: boolean;
  detectedSubject?: string | null;
};

export async function tessChat(req: ChatApiRequest): Promise<ChatApiResponse> {
  const res = await fetch(`${BACKEND_URL}/api/tess/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat request failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function detectSubject(prompt: string): Promise<string | null> {
  const res = await fetch(`${BACKEND_URL}/api/detect-subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.subject ?? null;
}
