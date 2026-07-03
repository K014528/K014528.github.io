import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  collection,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  limit,
  writeBatch,
} from "firebase/firestore";
import { ref, getDownloadURL } from "firebase/storage";
import { db, storage } from "./config";

export type UserProfile = {
  uid: string;
  email: string | null;
  role: "teacher" | "student";
  currentClass?: number | null;
  createdAt?: any;
};

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  return snap.data() as UserProfile;
}

export async function saveUserProfile(profile: UserProfile) {
  await setDoc(
    doc(db, "users", profile.uid),
    { ...profile, createdAt: serverTimestamp() },
    { merge: true }
  );
}

export type BookEntry = {
  id?: string;
  class: number;
  subject: string; // e.g. "maths"
  pdfPath: string; // e.g. school_textbooks/class_8/maths.pdf
  pdfUrl?: string; // download URL (resolved lazily)
  title?: string;
};

export async function findBook(classNum: number, subject: string): Promise<BookEntry | null> {
  const q = query(
    collection(db, "books_registry"),
    where("class", "==", classNum),
    where("subject", "==", subject),
    limit(1)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...(d.data() as BookEntry) };
}

export async function resolveBookUrl(book: BookEntry): Promise<string | null> {
  if (book.pdfUrl) return book.pdfUrl;
  try {
    const url = await getDownloadURL(ref(storage, book.pdfPath));
    return url;
  } catch (e) {
    console.warn("Failed to resolve PDF url", book.pdfPath, e);
    return null;
  }
}

// Seed a small demo set of book registry entries if empty
export async function seedBooksRegistryIfEmpty() {
  const snap = await getDocs(query(collection(db, "books_registry"), limit(1)));
  if (!snap.empty) return;
  const subjects = ["maths", "science", "physics", "chemistry", "biology", "history", "geography", "english", "civics", "economics", "computer"];
  const batch = writeBatch(db);
  for (let cls = 6; cls <= 12; cls++) {
    for (const sub of subjects) {
      const docRef = doc(collection(db, "books_registry"));
      batch.set(docRef, {
        class: cls,
        subject: sub,
        pdfPath: `school_textbooks/class_${cls}/${sub}.pdf`,
        title: `Class ${cls} ${sub.charAt(0).toUpperCase() + sub.slice(1)}`,
      });
    }
  }
  await batch.commit();
}

// -- Chat sessions --
export type ChatMessage = {
  id?: string;
  role: "user" | "ai";
  text: string;
  imageBase64?: string | null;
  pdfUrl?: string | null;
  detectedSubject?: string | null;
  createdAt?: any;
  feedback?: "up" | "down" | null;
};

export async function createChatSession(uid: string, title: string) {
  const ref = await addDoc(collection(db, "chats", uid, "sessions"), {
    title,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function addMessage(uid: string, sessionId: string, message: ChatMessage) {
  const ref = await addDoc(collection(db, "chats", uid, "sessions", sessionId, "messages"), {
    ...message,
    createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, "chats", uid, "sessions", sessionId), { updatedAt: serverTimestamp() });
  return ref.id;
}

export function subscribeSessions(uid: string, cb: (list: any[]) => void) {
  const q = query(collection(db, "chats", uid, "sessions"), orderBy("updatedAt", "desc"), limit(50));
  return onSnapshot(q, (s) => {
    cb(s.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function subscribeMessages(uid: string, sessionId: string, cb: (list: ChatMessage[]) => void) {
  const q = query(
    collection(db, "chats", uid, "sessions", sessionId, "messages"),
    orderBy("createdAt", "asc")
  );
  return onSnapshot(q, (s) => {
    cb(s.docs.map((d) => ({ id: d.id, ...(d.data() as ChatMessage) })));
  });
}

export async function setMessageFeedback(uid: string, sessionId: string, msgId: string, feedback: "up" | "down") {
  await updateDoc(doc(db, "chats", uid, "sessions", sessionId, "messages", msgId), { feedback });
  await addDoc(collection(db, "feedback"), {
    uid,
    sessionId,
    msgId,
    feedback,
    createdAt: serverTimestamp(),
  });
}
