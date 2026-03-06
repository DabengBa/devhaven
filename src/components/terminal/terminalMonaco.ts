import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

export const TERMINAL_MONACO_THEME = "devhaven-terminal";

// Monaco needs explicit worker wiring in bundlers like Vite.
// Keep this side-effect module shared between code editor + diff viewer.
(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker() {
    // Keep a single lightweight worker to avoid bundling language-service workers
    // (ts/css/html/json), which dramatically increases desktop package size.
    return new editorWorker();
  },
};

loader.config({ monaco });

let monacoInitialized = false;
let monacoInitPromise: Promise<void> | null = null;

export async function ensureTerminalMonacoInitialized(): Promise<void> {
  if (monacoInitialized) {
    return;
  }
  if (monacoInitPromise) {
    return monacoInitPromise;
  }
  monacoInitPromise = (async () => {
    await loader.init();
    monacoInitialized = true;
  })();
  return monacoInitPromise;
}

function parseRgbTuple(value: string): { r: number; g: number; b: number } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      return { r, g, b };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      return { r, g, b };
    }
  }

  const match = trimmed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!match) {
    return null;
  }
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function isDarkColor(value: string): boolean {
  const rgb = parseRgbTuple(value);
  if (!rgb) {
    return true;
  }
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return luminance < 128;
}

export function applyTerminalMonacoTheme(container: HTMLElement): void {
  const styles = getComputedStyle(container);
  const bg = styles.getPropertyValue("--terminal-bg").trim() || "#0b0b0b";
  const fg = styles.getPropertyValue("--terminal-fg").trim() || "#e5e7eb";

  monaco.editor.defineTheme(TERMINAL_MONACO_THEME, {
    base: isDarkColor(bg) ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
    },
  });
  monaco.editor.setTheme(TERMINAL_MONACO_THEME);
}

export function getTerminalMonacoBaseOptions(readOnly: boolean) {
  return {
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: "on",
    scrollBeyondLastLine: false,
    fontSize: 12,
    lineHeight: 20,
    lineNumbersMinChars: 3,
    padding: { top: 10, bottom: 10 },
    readOnly,
    cursorBlinking: "smooth",
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
    },
  } as const;
}

export type MonacoDiffOptions = monaco.editor.IDiffEditorConstructionOptions;
