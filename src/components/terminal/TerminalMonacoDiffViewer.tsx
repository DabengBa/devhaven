import { useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { APP_RESUME_EVENT } from "../../utils/appResume";

import {
  applyTerminalMonacoTheme,
  ensureTerminalMonacoInitialized,
} from "./terminalMonaco";

export type TerminalMonacoDiffViewerProps = {
  original: string;
  modified: string;
  language: string;
  sideBySide?: boolean;
};

function estimateLineNumbersMinChars(original: string, modified: string): number {
  const origLines = original ? original.split("\n").length : 1;
  const modLines = modified ? modified.split("\n").length : 1;
  return Math.max(3, String(Math.max(origLines, modLines)).length);
}

let diffViewerIdSeq = 0;
function nextViewerId(): string {
  diffViewerIdSeq += 1;
  return String(diffViewerIdSeq);
}

export default function TerminalMonacoDiffViewer({
  original,
  modified,
  language,
  sideBySide = true,
}: TerminalMonacoDiffViewerProps) {
  const [ready, setReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerIdRef = useRef<string>(nextViewerId());
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);

  useEffect(() => {
    let cancelled = false;
    ensureTerminalMonacoInitialized()
      .then(() => {
        if (!cancelled) {
          setReady(true);
        }
      })
      .catch((err) => {
        console.warn("初始化 Monaco Diff 失败", err);
        if (!cancelled) {
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    applyTerminalMonacoTheme(container);
  }, [ready]);

  const options = useMemo(() => {
    return {
      renderSideBySide: sideBySide,
      useInlineViewWhenSpaceIsLimited: true,
      originalEditable: false,
      renderOverviewRuler: false,
      glyphMargin: false,
      // Prefer showing real code line structure for diffs.
      wordWrap: "off",
      diffWordWrap: "off",
      readOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      scrollBeyondLastColumn: 0,
      fontSize: 12,
      lineHeight: 20,
      padding: { top: 10, bottom: 10 },
      lineNumbersMinChars: estimateLineNumbersMinChars(original, modified),
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
      },
    } as const;
  }, [modified, original, sideBySide]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (editorRef.current) {
      return;
    }

    editorRef.current = monaco.editor.createDiffEditor(container, {
      automaticLayout: true,
      ...options,
    });

    const id = viewerIdRef.current;
    const originalUri = monaco.Uri.parse(`inmemory://devhaven/gitdiff/original/${id}`);
    const modifiedUri = monaco.Uri.parse(`inmemory://devhaven/gitdiff/modified/${id}`);
    const originalModel = monaco.editor.createModel(original ?? "", language || "text", originalUri);
    const modifiedModel = monaco.editor.createModel(modified ?? "", language || "text", modifiedUri);
    modelsRef.current = { original: originalModel, modified: modifiedModel };
    editorRef.current.setModel({ original: originalModel, modified: modifiedModel });

    return () => {
      // Dispose in a safe order: detach models -> dispose editor -> dispose models.
      if (editorRef.current) {
        editorRef.current.setModel(null);
        editorRef.current.dispose();
        editorRef.current = null;
      }
      if (modelsRef.current) {
        modelsRef.current.original.dispose();
        modelsRef.current.modified.dispose();
        modelsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (!ready || !editorRef.current) {
      return;
    }
    editorRef.current.updateOptions(options);
  }, [options, ready]);

  useEffect(() => {
    const models = modelsRef.current;
    if (!ready || !models) {
      return;
    }
    monaco.editor.setModelLanguage(models.original, language || "text");
    monaco.editor.setModelLanguage(models.modified, language || "text");
  }, [language, ready]);

  useEffect(() => {
    const models = modelsRef.current;
    if (!ready || !models) {
      return;
    }
    const nextOriginal = original ?? "";
    const nextModified = modified ?? "";
    if (models.original.getValue() !== nextOriginal) {
      models.original.setValue(nextOriginal);
    }
    if (models.modified.getValue() !== nextModified) {
      models.modified.setValue(nextModified);
    }
  }, [modified, original, ready]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleResume = () => {
      try {
        editorRef.current?.layout();
      } catch (error) {
        console.warn("Monaco Diff 在恢复后重新布局失败", error);
      }
    };

    window.addEventListener(APP_RESUME_EVENT, handleResume as EventListener);
    return () => {
      window.removeEventListener(APP_RESUME_EVENT, handleResume as EventListener);
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-[var(--terminal-muted-fg)]">
        正在加载对比视图...
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      {/* Monaco diff editor is created imperatively to control model disposal order. */}
    </div>
  );
}
