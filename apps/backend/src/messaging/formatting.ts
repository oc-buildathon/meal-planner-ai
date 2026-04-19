/**
 * Cross-platform chat-message formatting.
 *
 * The LLM emits GitHub-flavored markdown (`## headers`, `**bold**`, `-
 * bullets`, `[links](url)`, code fences). Neither Telegram nor WhatsApp
 * render that correctly out of the box:
 *
 *   - Telegram (no parse_mode): treats everything literally — users see
 *     raw asterisks and hashes.
 *   - Telegram MarkdownV2: requires escaping dozens of special chars
 *     (`.`, `!`, `(`, `)`, `-`, `=`, `|`, …) — brittle.
 *   - WhatsApp: only supports single-asterisk bold, single-underscore
 *     italic, and plain-text bullets. No headers, no double-asterisks,
 *     no `[text](url)`.
 *
 * Strategy:
 *   1. `normalizeToChatFormat(md)` squashes markdown into a MINIMAL,
 *      WhatsApp-native, plain-text dialect:
 *         bold    → *bold*
 *         italic  → _italic_
 *         bullet  → "• "
 *         header  → line bolded
 *         link    → "text (url)"
 *         fences  → unwrapped
 *      It also balances stray `*` / `_` so neither platform chokes.
 *
 *   2. WhatsApp adapter sends the normalized text AS-IS.
 *
 *   3. Telegram adapter wraps with `normalizedToTelegramHtml()` which
 *      converts `*bold*`/`_italic_` into `<b>`/<i>` and escapes `<`, `>`,
 *      `&` in the surrounding text, then sends with `parse_mode: "HTML"`.
 */

/** Normalize GitHub-flavored markdown into a cross-platform chat dialect. */
export function normalizeToChatFormat(input: string): string {
  if (!input) return "";
  let out = input.replace(/\r\n/g, "\n");

  // Strip HTML tags if the LLM emitted any — we'll re-emit HTML per-platform.
  out = out.replace(/<[^>]+>/g, "");

  // Strip code fences but KEEP the enclosed content as-is.
  out = out.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, body) => body);

  // Inline code — surround with literal backticks, WhatsApp displays as mono.
  // Already single-backtick → leave alone.

  // Headers (#, ##, ###…) → bold on their own line.
  out = out.replace(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/gm, "*$1*");

  // Double-asterisk or double-underscore bold → single-asterisk.
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  out = out.replace(/__(.+?)__/g, "*$1*");

  // Bullets — `-`, `*`, or `+` at line start (with any indent) → "• ".
  out = out.replace(/^(\s*)[-*+]\s+/gm, "$1• ");

  // Ordered lists stay as "1. item" — both platforms render them as plain text, which is fine.

  // Links `[text](url)` → "text (url)".
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Horizontal rules → em-dash line.
  out = out.replace(/^\s*[-*_]{3,}\s*$/gm, "—");

  // Blockquotes "> " → indent.
  out = out.replace(/^>\s?/gm, "  ");

  // Balance stray markers so Telegram's HTML pass doesn't produce weird
  // half-open tags. We do this PER-LINE so that long messages with a
  // single odd `*` (e.g. a multiplier) don't nuke bold across the whole
  // message — only the offending line gets neutralized.
  out = out
    .split("\n")
    .map((line) => balanceMarkersInLine(line))
    .join("\n");

  // Collapse 3+ blank lines to 2.
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

/**
 * Convert normalized chat format (`*bold*`, `_italic_`) into Telegram HTML
 * suitable for `parse_mode: "HTML"`. Escapes `<`, `>`, `&` in all non-tag
 * content so arbitrary user text can't break parsing.
 */
export function normalizedToTelegramHtml(text: string): string {
  if (!text) return "";

  // Step 1 — tokenize into (bold / italic / plain) runs so escaping
  // can't accidentally touch tag syntax.
  type Token =
    | { kind: "bold"; body: string }
    | { kind: "italic"; body: string }
    | { kind: "code"; body: string }
    | { kind: "text"; body: string };

  const tokens: Token[] = [];

  // Pattern: *bold* | _italic_ | `code` | anything else.
  // Non-greedy matchers, no crossing newlines, not capturing empty bodies.
  const re = /\*([^\n*]+?)\*|_([^\n_]+?)_|`([^\n`]+?)`/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ kind: "text", body: text.slice(lastIndex, m.index) });
    }
    if (m[1] !== undefined) tokens.push({ kind: "bold", body: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: "italic", body: m[2] });
    else if (m[3] !== undefined) tokens.push({ kind: "code", body: m[3] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: "text", body: text.slice(lastIndex) });
  }

  // Step 2 — render with HTML escaping inside every run.
  return tokens
    .map((t) => {
      const body = escapeHtml(t.body);
      switch (t.kind) {
        case "bold":
          return `<b>${body}</b>`;
        case "italic":
          return `<i>${body}</i>`;
        case "code":
          return `<code>${body}</code>`;
        default:
          return body;
      }
    })
    .join("");
}

// ------------------------------------------------------------------
// Internals
// ------------------------------------------------------------------

/**
 * If a line has an odd number of `*` or `_`, strip all of them on that
 * line. Prevents half-open Telegram HTML tags without nuking formatting
 * elsewhere in a long reply.
 */
function balanceMarkersInLine(line: string): string {
  let out = line;
  const starCount = (out.match(/\*/g) ?? []).length;
  if (starCount % 2 !== 0) out = out.replace(/\*/g, "");

  // Underscores commonly appear inside identifiers (user_id, file_name).
  // Only rewrite if the line clearly has paired italic markers; otherwise
  // leave alone. Heuristic: treat _word_ blocks as italic, but don't
  // force-balance isolated underscores.
  // Simpler: if odd count AND no-space-delimited `_word_` pattern exists,
  // leave them; else balance.
  const underCount = (out.match(/_/g) ?? []).length;
  if (underCount % 2 !== 0) {
    // Only strip underscores if they look like formatting markers
    // (surrounded by whitespace/start/end). Leave intra-word ones alone.
    out = out.replace(/(^|\s)_([^_\s][^_]*?[^_\s]|[^_\s])_(?=\s|$)/g, "$1$2");
    // If still odd, strip *marker-ish* underscores at edges only.
    const still = (out.match(/_/g) ?? []).length;
    if (still % 2 !== 0) {
      // Trailing/leading single _ → drop them
      out = out.replace(/(^|\s)_(?=\s|$)/g, "$1");
    }
  }

  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
