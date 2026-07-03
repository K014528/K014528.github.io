import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/auth/AuthProvider";
import { saveUserProfile } from "@/src/firebase/data";
import { colors, spacing, radius, fontSize } from "@/src/theme";

const CLASSES = [6, 7, 8, 9, 10, 11, 12];

export default function OnboardingScreen() {
  const router = useRouter();
  const { user, refreshProfile } = useAuth();
  const [role, setRole] = useState<"teacher" | "student" | null>(null);
  const [selectedClass, setSelectedClass] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canContinue = role === "teacher" || (role === "student" && !!selectedClass);

  const submit = async () => {
    if (!user || !role) return;
    if (role === "student" && !selectedClass) return;
    setSaving(true);
    setError(null);
    try {
      await saveUserProfile({
        uid: user.uid,
        email: user.email,
        role,
        currentClass: role === "student" ? selectedClass : null,
      });
      await refreshProfile();
      router.replace("/chat");
    } catch (e: any) {
      setError(e?.message || "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.root} testID="onboarding-screen">
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.container}>
          <View style={styles.brandRow}>
            <View style={styles.logo}><Text style={styles.logoText}>T</Text></View>
            <Text style={styles.brandTitle}>TESS AI</Text>
          </View>
          <Text style={styles.h1}>Who are you?</Text>
          <Text style={styles.sub}>We&apos;ll personalize TESS for you.</Text>

          <Pressable
            testID="role-teacher-card"
            onPress={() => { setRole("teacher"); setSelectedClass(null); }}
            style={[styles.roleCard, role === "teacher" && styles.roleCardActive]}
          >
            <View style={styles.roleIcon}>
              <Ionicons name="school-outline" size={28} color={role === "teacher" ? colors.brand : colors.onSurface} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.roleTitle}>Teacher</Text>
              <Text style={styles.roleDesc}>Access all classes and subjects; help students effectively.</Text>
            </View>
            {role === "teacher" && <Ionicons name="checkmark-circle" size={22} color={colors.brand} />}
          </Pressable>

          <Pressable
            testID="role-student-card"
            onPress={() => setRole("student")}
            style={[styles.roleCard, role === "student" && styles.roleCardActive]}
          >
            <View style={styles.roleIcon}>
              <Ionicons name="book-outline" size={28} color={role === "student" ? colors.brand : colors.onSurface} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.roleTitle}>Student</Text>
              <Text style={styles.roleDesc}>Pick your class to unlock your textbooks and personalized help.</Text>
            </View>
            {role === "student" && <Ionicons name="checkmark-circle" size={22} color={colors.brand} />}
          </Pressable>

          {role === "student" && (
            <View style={styles.classSection}>
              <Text style={styles.classLabel}>Select your class</Text>
              <View style={styles.grid}>
                {CLASSES.map((c) => {
                  const active = selectedClass === c;
                  return (
                    <Pressable
                      key={c}
                      testID={`class-option-${c}`}
                      onPress={() => setSelectedClass(c)}
                      style={[styles.classChip, active && styles.classChipActive]}
                    >
                      <Text style={[styles.classChipText, active && styles.classChipTextActive]}>
                        {c}<Text style={styles.suffix}>{ordinalSuffix(c)}</Text>
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            testID="onboarding-continue-button"
            onPress={submit}
            disabled={!canContinue || saving}
            style={[styles.cta, (!canContinue || saving) && { opacity: 0.5 }]}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>Continue</Text>}
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function ordinalSuffix(n: number) {
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  container: { width: "100%", maxWidth: 560 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.xl },
  logo: { width: 36, height: 36, borderRadius: radius.md, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  logoText: { color: "#fff", fontWeight: "800", fontSize: 18 },
  brandTitle: { fontSize: fontSize.xl, fontWeight: "700", color: colors.onSurface },
  h1: { fontSize: 32, fontWeight: "700", color: colors.onSurface, marginTop: spacing.sm },
  sub: { color: colors.muted, marginTop: spacing.sm, marginBottom: spacing.xl },
  roleCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 2,
    borderColor: "transparent",
    marginBottom: spacing.md,
  },
  roleCardActive: { borderColor: colors.brand, backgroundColor: colors.brandTertiary },
  roleIcon: { width: 48, height: 48, borderRadius: radius.md, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  roleTitle: { fontSize: fontSize.lg, fontWeight: "700", color: colors.onSurface },
  roleDesc: { color: colors.muted, marginTop: 2, fontSize: fontSize.base },
  classSection: { marginTop: spacing.lg },
  classLabel: { color: colors.onSurface, fontWeight: "600", marginBottom: spacing.md },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  classChip: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  classChipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  classChipText: { fontSize: 22, fontWeight: "700", color: colors.onSurface },
  classChipTextActive: { color: "#fff" },
  suffix: { fontSize: 12, fontWeight: "500" },
  cta: { marginTop: spacing.xl, backgroundColor: colors.brand, borderRadius: radius.pill, paddingVertical: spacing.md + 4, alignItems: "center" },
  ctaText: { color: "#fff", fontWeight: "700", fontSize: fontSize.lg },
  error: { color: colors.error, marginTop: spacing.md, fontSize: fontSize.base },
});
