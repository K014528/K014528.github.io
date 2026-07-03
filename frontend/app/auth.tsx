import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { signInWithGoogle, signInEmail, signUpEmail } from "@/src/firebase/config";
import { colors, spacing, radius, fontSize } from "@/src/theme";

export default function AuthScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!email || !password) {
      setError("Please enter email and password.");
      return;
    }
    setLoading(true);
    try {
      if (mode === "signin") {
        await signInEmail(email, password);
      } else {
        await signUpEmail(email, password);
      }
      router.replace("/");
    } catch (e: any) {
      setError(prettyError(e?.code) || e?.message || "Auth failed");
    } finally {
      setLoading(false);
    }
  };

  const google = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithGoogle();
      router.replace("/");
    } catch (e: any) {
      setError(prettyError(e?.code) || e?.message || "Google sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.root}
      testID="auth-screen"
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <View style={styles.brandRow}>
            <View style={styles.logo}>
              <Text style={styles.logoText}>T</Text>
            </View>
            <Text style={styles.brandTitle}>TESS AI</Text>
          </View>
          <Text style={styles.subtitle}>by Tesslcrum · Your personal study companion</Text>

          <View style={styles.tabs}>
            <Pressable
              testID="tab-signin"
              onPress={() => setMode("signin")}
              style={[styles.tab, mode === "signin" && styles.tabActive]}
            >
              <Text style={[styles.tabText, mode === "signin" && styles.tabTextActive]}>Sign In</Text>
            </Pressable>
            <Pressable
              testID="tab-signup"
              onPress={() => setMode("signup")}
              style={[styles.tab, mode === "signup" && styles.tabActive]}
            >
              <Text style={[styles.tabText, mode === "signup" && styles.tabTextActive]}>Sign Up</Text>
            </Pressable>
          </View>

          <TextInput
            testID="auth-email-input"
            placeholder="Email"
            placeholderTextColor={colors.muted}
            style={styles.input}
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <TextInput
            testID="auth-password-input"
            placeholder="Password"
            placeholderTextColor={colors.muted}
            style={styles.input}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          {error && (
            <Text style={styles.error} testID="auth-error-text">
              {error}
            </Text>
          )}

          <Pressable
            testID="auth-submit-button"
            onPress={submit}
            style={[styles.primaryBtn, loading && { opacity: 0.7 }]}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>{mode === "signin" ? "Sign In" : "Create Account"}</Text>
            )}
          </Pressable>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>

          <Pressable testID="auth-google-button" onPress={google} style={styles.googleBtn} disabled={loading}>
            <Ionicons name="logo-google" size={18} color={colors.onSurface} />
            <Text style={styles.googleBtnText}>Continue with Google</Text>
          </Pressable>

          <Text style={styles.foot}>
            By continuing, you agree to Tesslcrum&apos;s Terms &amp; Privacy.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function prettyError(code?: string) {
  if (!code) return null;
  const map: Record<string, string> = {
    "auth/invalid-email": "That doesn't look like a valid email.",
    "auth/invalid-credential": "Invalid email or password.",
    "auth/wrong-password": "Wrong password.",
    "auth/user-not-found": "No account for that email. Try Sign Up.",
    "auth/email-already-in-use": "An account already exists with that email.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/popup-blocked": "Popup was blocked. Please allow popups and retry.",
    "auth/network-request-failed": "Network error. Please check your connection.",
  };
  return map[code] ?? null;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  card: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  logo: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { color: "#fff", fontWeight: "800", fontSize: 20 },
  brandTitle: { fontSize: fontSize.xxl, fontWeight: "700", color: colors.onSurface },
  subtitle: { color: colors.muted, marginTop: spacing.sm, marginBottom: spacing.xl },
  tabs: {
    flexDirection: "row",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.pill,
    padding: 4,
    marginBottom: spacing.xl,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: spacing.md, borderRadius: radius.pill },
  tabActive: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  tabText: { color: colors.muted, fontWeight: "600" },
  tabTextActive: { color: colors.brand },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: Platform.OS === "web" ? 14 : spacing.md,
    marginBottom: spacing.md,
    fontSize: fontSize.lg,
    color: colors.onSurface,
    ...(Platform.OS === "web" ? { outlineWidth: 0 as any } : {}),
  },
  primaryBtn: {
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    paddingVertical: spacing.md + 2,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: fontSize.lg },
  dividerRow: { flexDirection: "row", alignItems: "center", marginVertical: spacing.xl, gap: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.muted, fontSize: fontSize.sm },
  googleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: spacing.md + 2,
  },
  googleBtnText: { color: colors.onSurface, fontWeight: "600", fontSize: fontSize.lg },
  error: { color: colors.error, marginBottom: spacing.md, fontSize: fontSize.base },
  foot: { color: colors.muted, fontSize: fontSize.sm, textAlign: "center", marginTop: spacing.xl },
});
