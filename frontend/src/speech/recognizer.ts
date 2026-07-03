// Speech-to-text helper: uses Web Speech API on web; on native, returns null.
import { Platform } from "react-native";

export type Recognizer = {
  start: () => void;
  stop: () => void;
  onResult: (cb: (text: string, isFinal: boolean) => void) => void;
  onError: (cb: (err: string) => void) => void;
  onEnd: (cb: () => void) => void;
  isSupported: boolean;
};

export function createRecognizer(): Recognizer {
  if (Platform.OS !== "web") {
    return {
      start: () => {},
      stop: () => {},
      onResult: () => {},
      onError: () => {},
      onEnd: () => {},
      isSupported: false,
    };
  }
  const w: any = typeof window !== "undefined" ? window : {};
  const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!SR) {
    return {
      start: () => {},
      stop: () => {},
      onResult: () => {},
      onError: () => {},
      onEnd: () => {},
      isSupported: false,
    };
  }
  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = "en-US";
  let resultCb: ((t: string, f: boolean) => void) | null = null;
  let errorCb: ((e: string) => void) | null = null;
  let endCb: (() => void) | null = null;
  rec.onresult = (ev: any) => {
    let interim = "";
    let final = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (resultCb) resultCb(final || interim, !!final);
  };
  rec.onerror = (ev: any) => { if (errorCb) errorCb(ev.error || "error"); };
  rec.onend = () => { if (endCb) endCb(); };
  return {
    start: () => rec.start(),
    stop: () => rec.stop(),
    onResult: (cb) => { resultCb = cb; },
    onError: (cb) => { errorCb = cb; },
    onEnd: (cb) => { endCb = cb; },
    isSupported: true,
  };
}
