import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Platform,
  Image,
  useWindowDimensions,
  Modal,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useAuth } from "@/src/auth/AuthProvider";
import { colors, spacing, radius, fontSize } from "@/src/theme";
import {
  addMessage,
  createChatSession,
  subscribeMessages,
  subscribeSessions,
  setMessageFeedback,
  ChatMessage,
  seedBooksRegistryIfEmpty,
} from "@/src/firebase/data";
import { logOut } from "@/src/firebase/config";
import { tessChat } from "@/src/api/tess";
import { createRecognizer } from "@/src/speech/recognizer";
import { speak, stop as stopTts } from "@/src/speech/tts";
import { Markdown } from "@/src/components/Markdown";

const SIDEBAR_WIDTH = 280;
const MAX_CHAT_WIDTH = 768;

export default function ChatScreen() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const { width } = useWindowDimensions();
  const isWide = width >= 900;

  const [sidebarOpen, setSidebarOpen] = useState(isWide);
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [ttsMsgId, setTtsMsgId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const recognizerRef = useRef(createRecognizer());

  // Redirect if not signed in
  useEffect(() => {
    if (!user) router.replace("/auth");
    else if (!profile) router.replace("/onboarding");
  }, [user, profile, router]);

  useEffect(() => {
    setSidebarOpen(isWide);
  }, [isWide]);

  // Seed books registry (safe: no-op if not empty)
  useEffect(() => {
    seedBooksRegistryIfEmpty().catch(() => {});
  }, []);

  // Sessions subscription
  useEffect(() => {
    if (!user) return;
    const unsub = subscribeSessions(user.uid, setSessions);
    return () => unsub();
  }, [user]);

  // Messages subscription
  useEffect(() => {
    if (!user || !sessionId) {
      setMessages([]);
      return;
    }
    const unsub = subscribeMessages(user.uid, sessionId, (msgs) => {
      setMessages(msgs);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    });
    return () => unsub();
  }, [user, sessionId]);

  const startNewChat = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setPrompt("");
    setAttachedImage(null);
    if (!isWide) setSidebarOpen(false);
  }, [isWide]);

  const onPickImage = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.7,
      });
      if (!res.canceled && res.assets && res.assets[0]) {
        const a = res.assets[0];
        if (a.base64) {
          const mime = a.mimeType || "image/jpeg";
          setAttachedImage(`data:${mime};base64,${a.base64}`);
        } else if (a.uri) {
          setAttachedImage(a.uri);
        }
      }
    } catch (e) {
      console.warn("image pick err", e);
    }
  };

  const onOpenCamera = async () => {
    try {
      // Request camera permission contextually (mobile only; web opens picker).
      if (Platform.OS !== "web") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          console.warn("Camera permission denied");
          return;
        }
      }
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.7,
      });
      if (!res.canceled && res.assets && res.assets[0]) {
        const a = res.assets[0];
        if (a.base64) {
          const mime = a.mimeType || "image/jpeg";
          setAttachedImage(`data:${mime};base64,${a.base64}`);
        } else if (a.uri) {
          setAttachedImage(a.uri);
        }
      }
    } catch (e) {
      console.warn("camera err", e);
    }
  };

  const toggleMic = () => {
    const rec = recognizerRef.current;
    if (!rec.isSupported) return;
    if (recording) {
      rec.stop();
      setRecording(false);
      return;
    }
    rec.onResult((text, isFinal) => setPrompt(text));
    rec.onEnd(() => setRecording(false));
    rec.onError(() => setRecording(false));
    rec.start();
    setRecording(true);
  };

  const send = async () => {
    if (!user || !profile) return;
    const text = prompt.trim();
    if (!text && !attachedImage) return;
    setSending(true);
    let sidLocal: string | null = sessionId;
    try {
      if (!sidLocal) {
        const title = text.slice(0, 60) || "New chat";
        sidLocal = await createChatSession(user.uid, title);
        setSessionId(sidLocal);
      }

      // Store user message. Subject/PDF resolution now happens on the backend.
      await addMessage(user.uid, sidLocal, {
        role: "user",
        text,
        imageBase64: attachedImage,
      });

      // Snapshot the prior conversation to send as memory to Gemini
      const history = messages
        .filter((m) => !!m.text)
        .map((m) => ({ role: m.role, text: m.text }));

      // Clear input immediately
      const currentImage = attachedImage;
      setPrompt("");
      setAttachedImage(null);

      // Call backend — backend handles metadata extraction, intent detection,
      // Firestore lookup, PDF download, and text extraction internally.
      const resp = await tessChat({
        prompt: text,
        imageBase64: currentImage,
        sessionId: sidLocal,
        currentClass: profile.currentClass ?? null,
        role: profile.role,
        history,
      });

      await addMessage(user.uid, sidLocal, {
        role: "ai",
        text: resp.reply,
        detectedSubject: resp.detectedSubject ?? null,
        pdfUrl: resp.usedPdf ? "used" : null,
      });
    } catch (e) {
      console.warn("chat send err", e);
      // Silent error: never expose raw API errors to user
      try {
        if (user && sidLocal) {
          await addMessage(user.uid, sidLocal, {
            role: "ai",
            text: "⚠️ Server is currently busy. Please wait a moment and try again!",
          });
        }
      } catch {
        /* ignore */
      }
    } finally {
      setSending(false);
    }
  };

  const onSpeak = (m: ChatMessage) => {
    if (!m.id) return;
    if (ttsMsgId === m.id) {
      stopTts();
      setTtsMsgId(null);
    } else {
      speak(m.text);
      setTtsMsgId(m.id);
    }
  };

  const onFeedback = async (m: ChatMessage, dir: "up" | "down") => {
    if (!user || !sessionId || !m.id) return;
    try {
      await setMessageFeedback(user.uid, sessionId, m.id, dir);
    } catch (e) {
      console.warn("feedback err", e);
    }
  };

  const suggested = useMemo(() => {
    if (profile?.role === "teacher") {
      return [
        "Prepare a 10-minute intro to Newton's 3 laws for Class 9.",
        "Give me 5 exam questions from Chapter 3 of Class 8 History.",
        "Explain photosynthesis with a small activity idea.",
      ];
    }
    return [
      "Help me solve Maths Exercise 4B question 3.",
      "Explain page 61 of my History book.",
      "Give me 5 quick revision questions on cells (Biology).",
    ];
  }, [profile?.role]);

  return (
    <View style={styles.root} testID="chat-screen">
      {/* Sidebar */}
      {isWide ? (
        sidebarOpen && (
          <View style={styles.sidebar} testID="sidebar">
            <Sidebar
              onNewChat={startNewChat}
              onSelect={(sid) => setSessionId(sid)}
              activeSessionId={sessionId}
              sessions={sessions}
              onSignOut={() => logOut()}
              userEmail={user?.email || ""}
              onCollapse={() => setSidebarOpen(false)}
            />
          </View>
        )
      ) : (
        <Modal
          visible={sidebarOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setSidebarOpen(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setSidebarOpen(false)}>
            <Pressable style={styles.drawer} onPress={() => {}}>
              <Sidebar
                onNewChat={() => { startNewChat(); setSidebarOpen(false); }}
                onSelect={(sid) => { setSessionId(sid); setSidebarOpen(false); }}
                activeSessionId={sessionId}
                sessions={sessions}
                onSignOut={() => logOut()}
                userEmail={user?.email || ""}
                onCollapse={() => setSidebarOpen(false)}
              />
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* Main content */}
      <View style={styles.main}>
        <View style={styles.header}>
          <Pressable
            testID="sidebar-toggle-button"
            onPress={() => setSidebarOpen(!sidebarOpen)}
            style={styles.iconBtn}
          >
            <Ionicons name="menu" size={22} color={colors.onSurface} />
          </Pressable>
          <View style={styles.headerCenter}>
            <View style={styles.logoSm}><Text style={styles.logoSmText}>T</Text></View>
            <Text style={styles.headerTitle}>TESS AI</Text>
            {profile?.role === "student" && profile.currentClass ? (
              <View style={styles.classBadge}>
                <Text style={styles.classBadgeText}>Class {profile.currentClass}</Text>
              </View>
            ) : profile?.role === "teacher" ? (
              <View style={styles.classBadge}><Text style={styles.classBadgeText}>Teacher</Text></View>
            ) : null}
          </View>
          <Pressable testID="new-chat-header-button" onPress={startNewChat} style={styles.iconBtn}>
            <Ionicons name="create-outline" size={22} color={colors.onSurface} />
          </Pressable>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "translate-with-padding"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 60 : 0}
        >
          <ScrollView
            ref={scrollRef}
            style={styles.stream}
            contentContainerStyle={styles.streamContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.streamInner}>
              {messages.length === 0 ? (
                <View style={styles.empty} testID="chat-empty-state">
                  <Text style={styles.emptyTitle}>Hi{user?.displayName ? `, ${user.displayName.split(" ")[0]}` : ""} 👋</Text>
                  <Text style={styles.emptySub}>How can I help you learn today?</Text>
                  <View style={styles.chipsWrap}>
                    {suggested.map((s, i) => (
                      <Pressable
                        key={i}
                        testID={`suggested-prompt-${i}`}
                        onPress={() => setPrompt(s)}
                        style={styles.suggestChip}
                      >
                        <Text style={styles.suggestText}>{s}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : (
                messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    onSpeak={() => onSpeak(m)}
                    speaking={ttsMsgId === m.id}
                    onFeedback={(d) => onFeedback(m, d)}
                  />
                ))
              )}
              {sending && (
                <View style={styles.thinking} testID="ai-thinking">
                  <ActivityIndicator color={colors.brand} />
                  <Text style={styles.thinkingText}>TESS is thinking…</Text>
                </View>
              )}
            </View>
          </ScrollView>

          {/* Floating input area */}
          <View style={styles.inputArea}>
            <View style={styles.inputInner}>
              {attachedImage && (
                <View style={styles.attachmentRow}>
                  <Image source={{ uri: attachedImage }} style={styles.attachmentThumb} />
                  <Pressable testID="remove-attachment-btn" onPress={() => setAttachedImage(null)} style={styles.removeAttach}>
                    <Ionicons name="close" size={16} color="#fff" />
                  </Pressable>
                </View>
              )}
              <View
                style={[
                  styles.inputBar,
                  inputFocused && styles.inputBarFocused,
                ]}
              >
                <Pressable testID="attach-image-btn" onPress={onPickImage} style={styles.inputIcon}>
                  <Ionicons name="image-outline" size={22} color={colors.onSurfaceTertiary} />
                </Pressable>
                <Pressable testID="camera-btn" onPress={onOpenCamera} style={styles.inputIcon}>
                  <Ionicons name="camera-outline" size={22} color={colors.onSurfaceTertiary} />
                </Pressable>
                <Pressable
                  testID="mic-btn"
                  onPress={toggleMic}
                  style={styles.inputIcon}
                >
                  <Ionicons
                    name={recording ? "mic" : "mic-outline"}
                    size={22}
                    color={recording ? colors.brand : colors.onSurfaceTertiary}
                  />
                </Pressable>
                <TextInput
                  testID="chat-input"
                  value={prompt}
                  onChangeText={setPrompt}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  placeholder="Ask TESS anything…"
                  placeholderTextColor={colors.muted}
                  style={styles.textInput}
                  multiline
                  onSubmitEditing={send}
                  returnKeyType="send"
                />
                <Pressable
                  testID="send-btn"
                  onPress={send}
                  disabled={sending || (!prompt.trim() && !attachedImage)}
                  style={[
                    styles.sendBtn,
                    (sending || (!prompt.trim() && !attachedImage)) && { opacity: 0.5 },
                  ]}
                >
                  {sending ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Ionicons name="arrow-up" size={18} color="#fff" />
                  )}
                </Pressable>
              </View>
              <Text style={styles.subCaption} testID="hallucinate-notice">
                ✨ TESS AI can hallucinate. Cross-check with your Tesslcrum textbook PDF.
              </Text>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </View>
  );
}

function Sidebar({
  sessions,
  onNewChat,
  onSelect,
  activeSessionId,
  onSignOut,
  userEmail,
  onCollapse,
}: {
  sessions: any[];
  onNewChat: () => void;
  onSelect: (sid: string) => void;
  activeSessionId: string | null;
  onSignOut: () => void;
  userEmail: string;
  onCollapse: () => void;
}) {
  return (
    <View style={{ flex: 1, padding: spacing.lg, backgroundColor: colors.surfaceSecondary }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <View style={sbStyles.logo}><Text style={sbStyles.logoText}>T</Text></View>
          <Text style={sbStyles.brand}>TESS AI</Text>
        </View>
        <Pressable onPress={onCollapse} testID="sidebar-collapse" style={sbStyles.collapseBtn}>
          <Ionicons name="chevron-back" size={18} color={colors.onSurfaceTertiary} />
        </Pressable>
      </View>

      <Pressable testID="new-chat-btn" onPress={onNewChat} style={sbStyles.newChat}>
        <Ionicons name="add" size={18} color="#fff" />
        <Text style={sbStyles.newChatText}>New Chat</Text>
      </Pressable>

      <Text style={sbStyles.section}>Recent</Text>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        {sessions.length === 0 ? (
          <Text style={sbStyles.emptyHint}>Your recent chats will appear here.</Text>
        ) : (
          sessions.map((s) => (
            <Pressable
              key={s.id}
              testID={`session-${s.id}`}
              onPress={() => onSelect(s.id)}
              style={[sbStyles.sessionRow, activeSessionId === s.id && sbStyles.sessionRowActive]}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.onSurfaceTertiary} />
              <Text numberOfLines={1} style={sbStyles.sessionText}>{s.title || "Untitled"}</Text>
            </Pressable>
          ))
        )}
      </ScrollView>

      <View style={sbStyles.userRow}>
        <View style={sbStyles.avatar}>
          <Text style={sbStyles.avatarText}>{(userEmail?.[0] || "U").toUpperCase()}</Text>
        </View>
        <Text numberOfLines={1} style={sbStyles.userEmail}>{userEmail}</Text>
        <Pressable testID="signout-btn" onPress={onSignOut} style={sbStyles.signOut}>
          <Ionicons name="log-out-outline" size={18} color={colors.onSurfaceTertiary} />
        </Pressable>
      </View>
    </View>
  );
}

function MessageBubble({
  message,
  onSpeak,
  speaking,
  onFeedback,
}: {
  message: ChatMessage;
  onSpeak: () => void;
  speaking: boolean;
  onFeedback: (dir: "up" | "down") => void;
}) {
  if (message.role === "user") {
    return (
      <View style={styles.userRow} testID="user-message">
        <View style={styles.userBubble}>
          {message.imageBase64 && (
            <Image source={{ uri: message.imageBase64 }} style={styles.userImage} />
          )}
          {!!message.text && <Text style={styles.userText}>{message.text}</Text>}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.aiRow} testID="ai-message">
      <View style={styles.aiAvatar}><Text style={styles.aiAvatarText}>T</Text></View>
      <View style={{ flex: 1 }}>
        <Markdown text={message.text} />
        {!!message.detectedSubject && (
          <View style={styles.pdfChip} testID="detected-subject-chip">
            <Ionicons name="book-outline" size={12} color={colors.brand} />
            <Text style={styles.pdfChipText}>Referenced: {message.detectedSubject}</Text>
          </View>
        )}
        <View style={styles.aiActions}>
          <Pressable
            testID={`thumbs-up-${message.id}`}
            onPress={() => onFeedback("up")}
            style={styles.aiActionBtn}
          >
            <Ionicons
              name={message.feedback === "up" ? "thumbs-up" : "thumbs-up-outline"}
              size={16}
              color={message.feedback === "up" ? colors.brand : colors.onSurfaceTertiary}
            />
          </Pressable>
          <Pressable
            testID={`thumbs-down-${message.id}`}
            onPress={() => onFeedback("down")}
            style={styles.aiActionBtn}
          >
            <Ionicons
              name={message.feedback === "down" ? "thumbs-down" : "thumbs-down-outline"}
              size={16}
              color={message.feedback === "down" ? colors.error : colors.onSurfaceTertiary}
            />
          </Pressable>
          <Pressable
            testID={`speak-btn-${message.id}`}
            onPress={onSpeak}
            style={styles.aiActionBtn}
          >
            <Ionicons
              name={speaking ? "stop-circle" : "volume-medium-outline"}
              size={16}
              color={speaking ? colors.brand : colors.onSurfaceTertiary}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface, flexDirection: "row" },
  sidebar: { width: SIDEBAR_WIDTH, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.surfaceSecondary },
  main: { flex: 1, backgroundColor: colors.surface },
  header: {
    height: 60,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
  },
  headerCenter: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  logoSm: { width: 26, height: 26, borderRadius: 8, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  logoSmText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  headerTitle: { fontSize: fontSize.lg, fontWeight: "700", color: colors.onSurface },
  classBadge: { marginLeft: spacing.sm, backgroundColor: colors.brandTertiary, paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.pill },
  classBadgeText: { color: colors.brand, fontWeight: "600", fontSize: fontSize.sm },
  iconBtn: { width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  stream: { flex: 1 },
  streamContent: { alignItems: "center", paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.xl },
  streamInner: { width: "100%", maxWidth: MAX_CHAT_WIDTH },
  empty: { alignItems: "flex-start", paddingVertical: spacing.xxl },
  emptyTitle: { fontSize: 34, fontWeight: "700", color: colors.brand },
  emptySub: { fontSize: fontSize.xl, color: colors.muted, marginTop: spacing.sm, marginBottom: spacing.xl },
  chipsWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  suggestChip: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    maxWidth: 320,
    borderWidth: 1,
    borderColor: colors.border,
  },
  suggestText: { color: colors.onSurface, fontSize: fontSize.base },
  userRow: { flexDirection: "row", justifyContent: "flex-end", marginVertical: spacing.md },
  userBubble: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    maxWidth: "85%",
  },
  userText: { color: colors.onSurface, fontSize: fontSize.lg, lineHeight: 24 },
  userImage: { width: 200, height: 140, borderRadius: radius.md, marginBottom: spacing.sm, resizeMode: "cover" },
  aiRow: { flexDirection: "row", gap: spacing.md, marginVertical: spacing.lg, alignItems: "flex-start" },
  aiAvatar: { width: 28, height: 28, borderRadius: 8, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center", marginTop: 2 },
  aiAvatarText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  aiActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  aiActionBtn: { width: 30, height: 30, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  pdfChip: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, marginTop: spacing.sm, backgroundColor: colors.brandTertiary, paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill },
  pdfChipText: { color: colors.brand, fontSize: fontSize.sm, fontWeight: "600" },
  thinking: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginVertical: spacing.lg },
  thinkingText: { color: colors.muted },
  inputArea: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, paddingTop: spacing.sm, backgroundColor: colors.surface },
  inputInner: { width: "100%", maxWidth: MAX_CHAT_WIDTH, alignSelf: "center" },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 28,
    paddingLeft: spacing.sm,
    paddingRight: 6,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "transparent",
  },
  inputBarFocused: { backgroundColor: colors.surface, borderColor: colors.borderStrong },
  inputIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  textInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    fontSize: fontSize.lg,
    color: colors.onSurface,
    paddingHorizontal: spacing.sm,
    paddingVertical: Platform.OS === "web" ? 10 : 8,
    ...(Platform.OS === "web" ? { outlineWidth: 0 as any } : {}),
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  subCaption: { color: colors.muted, fontSize: fontSize.sm, textAlign: "center", marginTop: spacing.sm, marginBottom: spacing.xs },
  attachmentRow: { flexDirection: "row", marginBottom: spacing.sm },
  attachmentThumb: { width: 60, height: 60, borderRadius: radius.sm, resizeMode: "cover" },
  removeAttach: {
    position: "absolute",
    top: -6,
    left: 46,
    backgroundColor: "rgba(0,0,0,0.7)",
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  drawer: { width: 300, height: "100%", backgroundColor: colors.surfaceSecondary },
});

const sbStyles = StyleSheet.create({
  logo: { width: 30, height: 30, borderRadius: 8, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  logoText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  brand: { color: colors.onSurface, fontWeight: "700", fontSize: fontSize.lg },
  collapseBtn: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  newChat: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    marginTop: spacing.lg,
  },
  newChatText: { color: "#fff", fontWeight: "600", fontSize: fontSize.base },
  section: { color: colors.muted, fontWeight: "600", fontSize: fontSize.sm, marginTop: spacing.xl, marginBottom: spacing.sm, textTransform: "uppercase" },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  sessionRowActive: { backgroundColor: colors.brandTertiary },
  sessionText: { flex: 1, color: colors.onSurface, fontSize: fontSize.base },
  emptyHint: { color: colors.muted, fontSize: fontSize.sm, marginTop: spacing.md },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.md,
  },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.brandTertiary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.brand, fontWeight: "700" },
  userEmail: { flex: 1, color: colors.onSurface, fontSize: fontSize.sm },
  signOut: { padding: spacing.sm },
});
