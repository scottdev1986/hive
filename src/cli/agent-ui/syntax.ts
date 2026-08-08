import {
  getTreeSitterClient,
  SyntaxStyle,
  type TreeSitterClient,
} from "@opentui/core";

export function createSyntaxStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: "#dee2ea" },
    keyword: { fg: "#b294fa" },
    "keyword.function": { fg: "#b294fa" },
    "keyword.return": { fg: "#b294fa" },
    string: { fg: "#7ed385" },
    number: { fg: "#e8c160" },
    boolean: { fg: "#e8c160" },
    constant: { fg: "#e8c160" },
    comment: { fg: "#7a818e", italic: true },
    function: { fg: "#6ea8fe" },
    "function.method": { fg: "#6ea8fe" },
    type: { fg: "#6ecdc6" },
    variable: { fg: "#dee2ea" },
    property: { fg: "#dee2ea" },
    operator: { fg: "#e89654" },
    punctuation: { fg: "#8a919e" },
    "punctuation.delimiter": { fg: "#8a919e" },
    "punctuation.bracket": { fg: "#8a919e" },
    "markup.heading": { fg: "#6ea8fe", bold: true },
    "markup.bold": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: "#6ecdc6" },
    "markup.link": { fg: "#6ea8fe", underline: true },
    "markup.list": { fg: "#e89654" },
  });
}

/** The tree-sitter client for syntax highlighting, or null when it is unavailable. OpenTUI keeps one client per process and destroys it with the renderer that owns it, so this asks for the current one each time rather than holding a reference: a cached client outlives the renderer it was made for and answers the next one with "client destroyed". Highlighting is decoration. A pane whose parsers will not load still has to show the diff, so a failure here is swallowed and the renderables run unhighlighted; initialization is kicked off but never awaited on the draw path, and the renderables repaint when highlights arrive. */
const listening = new WeakSet<TreeSitterClient>();

export function syntaxClient(): TreeSitterClient | null {
  try {
    const client = getTreeSitterClient();
    if (!listening.has(client)) {
      listening.add(client);
      // A parser that fails to load is reported on this channel rather than thrown, and an unhandled 'error' event would take the pane down with it.
      client.on("error", () => {});
    }
    void client.initialize().catch(() => {});
    return client;
  } catch {
    return null;
  }
}
