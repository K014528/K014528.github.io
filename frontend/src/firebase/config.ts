import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  initializeAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { Platform } from "react-native";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Auth: default for web works; for native, initializeAuth with AsyncStorage persistence.
let _auth: ReturnType<typeof getAuth>;
try {
  _auth = getAuth(firebaseApp);
} catch {
  _auth = getAuth(firebaseApp);
}
export const auth = _auth;

export const db = getFirestore(firebaseApp);
export const storage = getStorage(firebaseApp);

export const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogle() {
  if (Platform.OS === "web") {
    try {
      return await signInWithPopup(auth, googleProvider);
    } catch (e: any) {
      // Fall back to redirect for popup-blocked browsers
      if (e?.code === "auth/popup-blocked" || e?.code === "auth/popup-closed-by-user") {
        await signInWithRedirect(auth, googleProvider);
        return null;
      }
      throw e;
    }
  }
  // Native platforms: popup isn't supported; use redirect (best-effort).
  return await signInWithRedirect(auth, googleProvider);
}

export async function signUpEmail(email: string, password: string) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export async function signInEmail(email: string, password: string) {
  return signInWithEmailAndPassword(auth, email, password);
}

export async function logOut() {
  return signOut(auth);
}

export function subscribeToAuth(cb: (user: User | null) => void) {
  return onAuthStateChanged(auth, cb);
}
