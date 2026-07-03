import { Platform } from "react-native";
import * as Speech from "expo-speech";

let webUtterance: any = null;

export function speak(text: string) {
  stop();
  if (Platform.OS === "web") {
    const w: any = typeof window !== "undefined" ? window : {};
    if (!w.speechSynthesis) return;
    const clean = text.replace(/[*_`#>]/g, "");
    webUtterance = new w.SpeechSynthesisUtterance(clean);
    webUtterance.rate = 1;
    webUtterance.pitch = 1;
    w.speechSynthesis.speak(webUtterance);
    return;
  }
  Speech.speak(text.replace(/[*_`#>]/g, ""), { rate: 1.0, pitch: 1.0 });
}

export function stop() {
  if (Platform.OS === "web") {
    const w: any = typeof window !== "undefined" ? window : {};
    if (w.speechSynthesis) w.speechSynthesis.cancel();
    webUtterance = null;
    return;
  }
  Speech.stop();
}

export function isSpeaking(): boolean {
  if (Platform.OS === "web") {
    const w: any = typeof window !== "undefined" ? window : {};
    return !!(w.speechSynthesis && w.speechSynthesis.speaking);
  }
  return false;
}
