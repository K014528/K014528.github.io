import React from "react";
import { Text, View, StyleSheet } from "react-native";
import { colors, fontSize, spacing } from "@/src/theme";

// Very lightweight markdown renderer supporting headings (# ##), bold (**text**),
// italics (*text*), inline code (`x`), bullet lists (- / *) and numbered lists.
export function Markdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const nextKey = () => `md-${key++}`;

  while (i < lines.length) {
    const line = lines[i];
    // Blank line
    if (!line.trim()) {
      blocks.push(<View key={nextKey()} style={{ height: spacing.sm }} />);
      i++;
      continue;
    }
    // Heading
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const style = level === 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3;
      blocks.push(
        <Text key={nextKey()} style={style}>
          {renderInline(h[2])}
        </Text>
      );
      i++;
      continue;
    }
    // Bullet list group
    if (/^\s*[-*]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*[-*]\s+/, "");
        items.push(
          <View key={nextKey()} style={styles.li}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.liText}>{renderInline(item)}</Text>
          </View>
        );
        i++;
      }
      blocks.push(<View key={nextKey()}>{items}</View>);
      continue;
    }
    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const m = /^\s*(\d+)\.\s+(.*)$/.exec(lines[i])!;
        items.push(
          <View key={nextKey()} style={styles.li}>
            <Text style={styles.bullet}>{m[1]}.</Text>
            <Text style={styles.liText}>{renderInline(m[2])}</Text>
          </View>
        );
        i++;
      }
      blocks.push(<View key={nextKey()}>{items}</View>);
      continue;
    }
    // Paragraph (accumulate until blank)
    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <Text key={nextKey()} style={styles.p}>
        {renderInline(paraLines.join(" "))}
      </Text>
    );
  }
  return <View>{blocks}</View>;
}

function renderInline(t: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = regex.exec(t)) !== null) {
    if (m.index > last) parts.push(t.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(<Text key={`b${k++}`} style={styles.bold}>{tok.slice(2, -2)}</Text>);
    } else if (tok.startsWith("`")) {
      parts.push(<Text key={`c${k++}`} style={styles.code}>{tok.slice(1, -1)}</Text>);
    } else if (tok.startsWith("*")) {
      parts.push(<Text key={`i${k++}`} style={styles.italic}>{tok.slice(1, -1)}</Text>);
    }
    last = m.index + tok.length;
  }
  if (last < t.length) parts.push(t.slice(last));
  return parts;
}

const styles = StyleSheet.create({
  h1: { fontSize: 22, fontWeight: "700", color: colors.onSurface, marginTop: spacing.md, marginBottom: spacing.xs },
  h2: { fontSize: 19, fontWeight: "700", color: colors.onSurface, marginTop: spacing.md, marginBottom: spacing.xs },
  h3: { fontSize: 16, fontWeight: "700", color: colors.onSurface, marginTop: spacing.sm },
  p: { fontSize: fontSize.lg, lineHeight: 24, color: colors.onSurface, marginBottom: spacing.xs },
  li: { flexDirection: "row", gap: spacing.sm, marginVertical: 2 },
  bullet: { color: colors.brand, fontWeight: "700", fontSize: fontSize.lg, minWidth: 14 },
  liText: { flex: 1, fontSize: fontSize.lg, lineHeight: 24, color: colors.onSurface },
  bold: { fontWeight: "700", color: colors.onSurface },
  italic: { fontStyle: "italic" },
  code: {
    fontFamily: "monospace",
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 4,
    borderRadius: 4,
    fontSize: fontSize.base,
  },
});
