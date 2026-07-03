import { useEffect } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "@/src/auth/AuthProvider";
import { colors } from "@/src/theme";
import { seedBooksRegistryIfEmpty } from "@/src/firebase/data";

export default function Index() {
  const { user, profile, loading } = useAuth();

  useEffect(() => {
    // Best-effort seed on first load
    seedBooksRegistryIfEmpty().catch((e) => console.warn("seed err", e));
  }, []);

  if (loading) {
    return (
      <View style={styles.center} testID="auth-loading-screen">
        <ActivityIndicator color={colors.brand} size="large" />
      </View>
    );
  }

  if (!user) return <Redirect href="/auth" />;
  if (!profile) return <Redirect href="/onboarding" />;
  // Teachers go directly to chat as well; profile.role determines behaviour there
  return <Redirect href="/chat" />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
});
