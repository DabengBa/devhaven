import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import type { ITheme } from "xterm";

import type { RightSidebarState, SplitDirection, TerminalRightSidebarTab, TerminalTab, TerminalWorkspace } from "../../models/terminal";
import type { ProjectScript } from "../../models/types";
import { useDevHavenContext } from "../../state/DevHavenContext";
import {
  getTerminalCodexPaneOverlay,
  killTerminal,
  listenTerminalOutput,
  writeTerminal,
  type TerminalCodexPaneOverlay,
} from "../../services/terminal";
import { saveTerminalWorkspace, loadTerminalWorkspace } from "../../services/terminalWorkspace";
import { gitIsRepo } from "../../services/gitManagement";
import {
  TERMINAL_QUICK_COMMAND_RUN_EVENT,
  TERMINAL_QUICK_COMMAND_STOP_EVENT,
  takeTerminalQuickCommandActionsForProject,
  type TerminalQuickCommandAction,
  type TerminalQuickCommandRunPayload,
  type TerminalQuickCommandStopPayload,
} from "../../services/terminalQuickCommands";
import {
  collectSessionIds,
  createDefaultWorkspace,
  createId,
  findPanePath,
  normalizeWorkspace,
  removePane,
  splitPane,
  updateSplitRatios,
} from "../../utils/terminalLayout";
import { isInteractionLocked } from "../../utils/interactionLock";
import { renderScriptTemplateCommand } from "../../utils/scriptTemplate";
import { IconFolder, IconGitBranch, IconSidebarRight, IconX } from "../Icons";
import ResizablePanel from "./ResizablePanel";
import SplitLayout from "./SplitLayout";
import TerminalRightSidebar from "./TerminalRightSidebar";
import TerminalPane from "./TerminalPane";
import TerminalTabs from "./TerminalTabs";

export type TerminalWorkspaceViewProps = {
  projectId: string | null;
  projectPath: string;
  projectName?: string | null;
  isActive: boolean;
  windowLabel: string;
  xtermTheme: ITheme;
  codexRunningCount?: number;
  scripts?: ProjectScript[];
};

type ScriptRuntime = {
  tabId: string;
  sessionId: string;
  ptyId: string | null;
};

const TERMINAL_TITLE_PATTERN = /^终端\s*(\d+)$/;
const QUICK_COMMAND_OUTPUT_BUFFER_LIMIT = 4096;
const CODEX_STARTUP_OUTPUT_BUFFER_LIMIT = 4096;
const QUICK_COMMAND_EXIT_MARKER_REGEX =
  /\u001b\]633;DevHaven;qc-exit;([^;]+);(-?\d+)\u0007/;
const ANSI_CSI_REGEX = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CODEX_MODEL_LINE_REGEX = /model:\s*([^\s|]+)\s+([^\s|]+)\s+\/model\b/i;
const CODEX_MODEL_CHANGED_REGEX = /model changed to\s+([^\s`]+)(?:\s+([^\s`]+))?/i;
const CODEX_RESUME_MODEL_REGEX = /resuming with\s+`([^`]+)`/i;

const DEFAULT_RIGHT_SIDEBAR: RightSidebarState = {
  open: false,
  width: 520,
  tab: "files",
};
const MIN_RIGHT_SIDEBAR_WIDTH = 360;
const MAX_RIGHT_SIDEBAR_WIDTH = 960;
const CODEX_PANE_OVERLAY_REFRESH_INTERVAL_MS = 2500;

type CodexStartupHint = {
  model: string | null;
  effort: string | null;
  updatedAt: number;
};

function stripAnsiSequences(input: string) {
  return input.replace(ANSI_OSC_REGEX, "").replace(ANSI_CSI_REGEX, "");
}

function parseCodexStartupModelLine(buffer: string): Pick<CodexStartupHint, "model" | "effort"> | null {
  const lines = stripAnsiSequences(buffer).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const normalized = lines[index].replace(/[│┃]/g, " ").replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }

    const modelChangedMatched = normalized.match(CODEX_MODEL_CHANGED_REGEX);
    if (modelChangedMatched) {
      return {
        model: modelChangedMatched[1]?.trim() || null,
        effort: modelChangedMatched[2]?.trim() || null,
      };
    }

    const resumeModelMatched = normalized.match(CODEX_RESUME_MODEL_REGEX);
    if (resumeModelMatched) {
      return {
        model: resumeModelMatched[1]?.trim() || null,
        effort: null,
      };
    }

    if (!normalized.toLowerCase().includes("model:")) {
      continue;
    }
    const startupModelMatched = normalized.match(CODEX_MODEL_LINE_REGEX);
    if (!startupModelMatched) {
      continue;
    }
    return {
      model: startupModelMatched[1]?.trim() || null,
      effort: startupModelMatched[2]?.trim() || null,
    };
  }
  return null;
}

function shellQuote(value: string) {
  // POSIX-safe single-quote escaping: 'foo'"'"'bar'
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function wrapQuickCommandForShell(
  command: string,
  token: string,
  environment?: Record<string, string | undefined>,
) {
  const normalized = command.replace(/\r\n|\n|\r/g, "; ").trim();
  const safeToken = token.replace(/[^a-zA-Z0-9-]/g, "");
  if (!normalized || !safeToken) {
    return "";
  }

  // Run the command in a sub-shell so Ctrl+C (SIGINT) still emits our qc-exit marker via trap.
  // This keeps the outer interactive shell alive, and avoids relying on buffered follow-up lines.
  const runnerScript =
    'printf "\\033]633;DevHaven;qc-start;%s\\007" "$DEVHAVEN_QC_TOKEN"; ' +
    'dh_qc_emit_exit() { printf "\\033]633;DevHaven;qc-exit;%s;%s\\007" "$DEVHAVEN_QC_TOKEN" "$1"; }; ' +
    'trap "dh_qc_emit_exit 130; exit 130" INT; ' +
    'eval "$DEVHAVEN_QC_CMD"; ' +
    'code=$?; dh_qc_emit_exit "$code"; exit "$code"';

  const envAssignments: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(environment ?? {})) {
    if (!rawValue) {
      continue;
    }
    const key = rawKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    envAssignments.push(`${key}=${shellQuote(rawValue)}`);
  }
  const envPrefix = envAssignments.length > 0 ? `${envAssignments.join(" ")} ` : "";

  return (
    envPrefix +
    `DEVHAVEN_QC_TOKEN=${shellQuote(safeToken)} ` +
    `DEVHAVEN_QC_CMD=${shellQuote(normalized)} ` +
    `sh -lc ${shellQuote(runnerScript)}`
  );
}

function getNextTerminalTitle(tabs: TerminalTab[]): string {
  const used = new Set<number>();
  for (const tab of tabs) {
    const match = tab.title.match(TERMINAL_TITLE_PATTERN);
    if (!match) {
      continue;
    }
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) {
      used.add(value);
    }
  }
  let next = 1;
  while (used.has(next)) {
    next += 1;
  }
  return `终端 ${next}`;
}

export default function TerminalWorkspaceView({
  projectId,
  projectPath,
  projectName,
  isActive,
  windowLabel,
  xtermTheme,
  codexRunningCount = 0,
  scripts = [],
}: TerminalWorkspaceViewProps) {
  const { appState } = useDevHavenContext();
  const workspaceDefaultsRef = useRef<{
    defaultQuickCommandsPanelOpen: boolean;
    defaultFileExplorerPanelOpen: boolean;
    defaultFileExplorerShowHidden: boolean;
  }>({
    defaultQuickCommandsPanelOpen: scripts.length > 0,
    defaultFileExplorerPanelOpen: false,
    defaultFileExplorerShowHidden: false,
  });
  workspaceDefaultsRef.current.defaultQuickCommandsPanelOpen = scripts.length > 0;

  const [workspace, setWorkspace] = useState<TerminalWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspaceRef = useRef<TerminalWorkspace | null>(null);
  const snapshotProviders = useRef(new Map<string, () => string | null>());

  const [panelMessage, setPanelMessage] = useState<string | null>(null);
  const panelMessageTimerRef = useRef<number | null>(null);

  const [scriptRuntimeById, setScriptRuntimeById] = useState<Record<string, ScriptRuntime>>({});
  const scriptRuntimeByIdRef = useRef<Record<string, ScriptRuntime>>({});

  const sessionPtyIdRef = useRef(new Map<string, string>());
  const scriptIdBySessionIdRef = useRef(new Map<string, string>());
  const pendingStartBySessionIdRef = useRef(new Map<string, string>());
  const quickCommandOutputBufferBySessionIdRef = useRef(new Map<string, string>());
  const codexStartupOutputBufferBySessionIdRef = useRef(new Map<string, string>());
  const pendingExternalActionsRef = useRef<TerminalQuickCommandAction[]>([]);
  const handledRequestIdsRef = useRef(new Set<string>());

  const stageRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelDraft, setPanelDraft] = useState<{ x: number; y: number } | null>(null);
  const panelDraftRef = useRef<{ x: number; y: number } | null>(null);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [previewDirty, setPreviewDirty] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [codexPaneOverlayBySessionId, setCodexPaneOverlayBySessionId] = useState<
    Record<string, TerminalCodexPaneOverlay>
  >({});
  const [codexStartupHintBySessionId, setCodexStartupHintBySessionId] = useState<
    Record<string, CodexStartupHint>
  >({});
  const dragStateRef = useRef<{
    startClientX: number;
    startClientY: number;
    baseX: number;
    baseY: number;
  } | null>(null);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useLayoutEffect(() => {
    scriptRuntimeByIdRef.current = scriptRuntimeById;
  }, [scriptRuntimeById]);

  useEffect(() => {
    return () => {
      if (panelMessageTimerRef.current !== null) {
        window.clearTimeout(panelMessageTimerRef.current);
        panelMessageTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsGitRepo(false);
    if (!projectPath) {
      return () => {
        cancelled = true;
      };
    }
    gitIsRepo(projectPath)
      .then((value) => {
        if (!cancelled) {
          setIsGitRepo(Boolean(value));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsGitRepo(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) {
      return;
    }
    let cancelled = false;
    setError(null);
    setPanelMessage(null);
    if (panelMessageTimerRef.current !== null) {
      window.clearTimeout(panelMessageTimerRef.current);
      panelMessageTimerRef.current = null;
    }
    setScriptRuntimeById({});
    scriptIdBySessionIdRef.current.clear();
    sessionPtyIdRef.current.clear();
    pendingStartBySessionIdRef.current.clear();
    quickCommandOutputBufferBySessionIdRef.current.clear();
    codexStartupOutputBufferBySessionIdRef.current.clear();
    pendingExternalActionsRef.current = [];
    handledRequestIdsRef.current.clear();
    setPreviewFilePath(null);
    setPreviewDirty(false);
    setCodexPaneOverlayBySessionId({});
    setCodexStartupHintBySessionId({});
    loadTerminalWorkspace(projectPath)
      .then((data) => {
        if (cancelled) {
          return;
        }
        const defaults = workspaceDefaultsRef.current;
        const next = data
          ? normalizeWorkspace(data, projectPath, projectId, defaults)
          : createDefaultWorkspace(projectPath, projectId, defaults);
        setWorkspace(next);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setWorkspace(createDefaultWorkspace(projectPath, projectId, workspaceDefaultsRef.current));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, projectPath]);

  const registerSnapshotProvider = useCallback(
    (sessionId: string, provider: () => string | null) => {
      snapshotProviders.current.set(sessionId, provider);
      return () => snapshotProviders.current.delete(sessionId);
    },
    [],
  );

  const saveWorkspace = useCallback(async () => {
    const current = workspaceRef.current;
    if (!current) {
      return;
    }
    const sessions = { ...current.sessions };
    Object.entries(sessions).forEach(([sessionId, snapshot]) => {
      const provider = snapshotProviders.current.get(sessionId);
      if (provider) {
        sessions[sessionId] = { ...snapshot, savedState: provider() ?? null };
      }
    });
    const payload = {
      ...current,
      sessions,
      updatedAt: Date.now(),
    };
    try {
      await saveTerminalWorkspace(current.projectPath, payload);
    } catch (err) {
      console.error("保存终端工作空间失败。", err);
    }
  }, []);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveWorkspace();
    }, 800);
    return () => {
      window.clearTimeout(timer);
    };
  }, [workspace, saveWorkspace]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      void saveWorkspace();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [saveWorkspace]);

  const updateWorkspace = useCallback(
    (updater: (current: TerminalWorkspace) => TerminalWorkspace) => {
      setWorkspace((prev) => (prev ? updater(prev) : prev));
    },
    [],
  );

  const showPanelMessage = useCallback((message: string) => {
    setPanelMessage(message);
    if (panelMessageTimerRef.current !== null) {
      window.clearTimeout(panelMessageTimerRef.current);
    }
    panelMessageTimerRef.current = window.setTimeout(() => {
      panelMessageTimerRef.current = null;
      setPanelMessage(null);
    }, 2500);
  }, []);

  const cleanupRuntimeBySessionIds = useCallback((sessionIds: string[]) => {
    if (sessionIds.length === 0) {
      return;
    }
    const removeSet = new Set(sessionIds);
    setScriptRuntimeById((prev) => {
      let next: typeof prev | null = null;
      Object.entries(prev).forEach(([scriptId, runtime]) => {
        if (!removeSet.has(runtime.sessionId)) {
          return;
        }
        if (!next) {
          next = { ...prev };
        }
        delete next[scriptId];
      });
      return next ?? prev;
    });

    sessionIds.forEach((sessionId) => {
      sessionPtyIdRef.current.delete(sessionId);
      scriptIdBySessionIdRef.current.delete(sessionId);
      pendingStartBySessionIdRef.current.delete(sessionId);
      quickCommandOutputBufferBySessionIdRef.current.delete(sessionId);
      codexStartupOutputBufferBySessionIdRef.current.delete(sessionId);
    });

    setCodexStartupHintBySessionId((prev) => {
      let next: Record<string, CodexStartupHint> | null = null;
      for (const sessionId of sessionIds) {
        if (!(sessionId in prev)) {
          continue;
        }
        if (!next) {
          next = { ...prev };
        }
        delete next[sessionId];
      }
      return next ?? prev;
    });

    setCodexPaneOverlayBySessionId((prev) => {
      let next: Record<string, TerminalCodexPaneOverlay> | null = null;
      for (const sessionId of sessionIds) {
        if (!(sessionId in prev)) {
          continue;
        }
        if (!next) {
          next = { ...prev };
        }
        delete next[sessionId];
      }
      return next ?? prev;
    });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const registerListener = async () => {
      try {
        unlisten = await listenTerminalOutput((event) => {
          const payload = event.payload;
          const sessionId = payload.sessionId;

          const startupBufferMap = codexStartupOutputBufferBySessionIdRef.current;
          const startupPrev = startupBufferMap.get(sessionId) ?? "";
          const startupNext = `${startupPrev}${payload.data}`.slice(-CODEX_STARTUP_OUTPUT_BUFFER_LIMIT);
          startupBufferMap.set(sessionId, startupNext);

          const startupHint = parseCodexStartupModelLine(startupNext);
          if (startupHint) {
            const now = Date.now();
            setCodexStartupHintBySessionId((prev) => {
              const existing = prev[sessionId];
              const nextModel = startupHint.model ?? existing?.model ?? null;
              const nextEffort = startupHint.effort ?? existing?.effort ?? null;
              if (existing && existing.model === nextModel && existing.effort === nextEffort) {
                return prev;
              }
              return {
                ...prev,
                [sessionId]: {
                  model: nextModel,
                  effort: nextEffort,
                  updatedAt: now,
                },
              };
            });
          }

          const scriptId = scriptIdBySessionIdRef.current.get(sessionId);
          if (!scriptId) {
            return;
          }

          const bufferMap = quickCommandOutputBufferBySessionIdRef.current;
          const prev = bufferMap.get(sessionId) ?? "";
          const next = `${prev}${payload.data}`.slice(-QUICK_COMMAND_OUTPUT_BUFFER_LIMIT);
          bufferMap.set(sessionId, next);

          const match = QUICK_COMMAND_EXIT_MARKER_REGEX.exec(next);
          if (!match) {
            return;
          }
          const token = match[1];
          const code = match[2];
          if (token !== sessionId) {
            return;
          }
          cleanupRuntimeBySessionIds([sessionId]);
          showPanelMessage(code === "0" ? "命令已完成" : `命令已结束（退出码 ${code}）`);
        });
      } catch (error) {
        console.error("监听终端输出事件失败。", error);
      }
    };

    void registerListener();

    return () => {
      unlisten?.();
    };
  }, [cleanupRuntimeBySessionIds, showPanelMessage]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    const panel = workspace.ui?.quickCommandsPanel;
    if (!panel || !panel.open) {
      return;
    }
    if (panel.x !== null && panel.y !== null) {
      return;
    }
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const margin = 12;
    const defaultWidth = 260;
    const rect = stage.getBoundingClientRect();
    const resolvedX =
      panel.x !== null ? panel.x : Math.max(margin, Math.round(rect.width - defaultWidth - margin));
    const resolvedY = panel.y !== null ? panel.y : margin;
    updateWorkspace((current) => ({
      ...current,
      ui: {
        ...current.ui,
        quickCommandsPanel: {
          ...(current.ui?.quickCommandsPanel ?? {
            open: workspaceDefaultsRef.current.defaultQuickCommandsPanelOpen,
            x: null,
            y: null,
          }),
          x: resolvedX,
          y: resolvedY,
        },
      },
    }));
  }, [updateWorkspace, workspace]);

  const handleSelectTab = useCallback(
    (tabId: string) => {
      updateWorkspace((current) => ({ ...current, activeTabId: tabId }));
    },
    [updateWorkspace],
  );

  const handleNewTab = useCallback(() => {
    updateWorkspace((current) => {
      const sessionId = createId();
      const tabId = createId();
      const title = getNextTerminalTitle(current.tabs);
      return {
        ...current,
        activeTabId: tabId,
        tabs: [
          ...current.tabs,
          {
            id: tabId,
            title,
            root: { type: "pane", sessionId },
            activeSessionId: sessionId,
          },
        ],
        sessions: {
          ...current.sessions,
          [sessionId]: { id: sessionId, cwd: current.projectPath, savedState: null },
        },
      };
    });
  }, [updateWorkspace]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const current = workspaceRef.current;
      const closedTab = current?.tabs.find((tab) => tab.id === tabId) ?? null;
      const removedSessions = closedTab ? collectSessionIds(closedTab.root) : [];
      cleanupRuntimeBySessionIds(removedSessions);

      updateWorkspace((current) => {
        const remainingTabs = current.tabs.filter((tab) => tab.id !== tabId);
        const closedTab = current.tabs.find((tab) => tab.id === tabId);
        const removedSessions = closedTab ? collectSessionIds(closedTab.root) : [];
        if (remainingTabs.length === 0) {
          return createDefaultWorkspace(current.projectPath, current.projectId, workspaceDefaultsRef.current);
        }
        const nextSessions = { ...current.sessions };
        removedSessions.forEach((sessionId) => {
          delete nextSessions[sessionId];
        });
        const nextActiveTabId =
          current.activeTabId === tabId ? remainingTabs[0].id : current.activeTabId;
        return {
          ...current,
          tabs: remainingTabs,
          activeTabId: nextActiveTabId,
          sessions: nextSessions,
        };
      });
    },
    [cleanupRuntimeBySessionIds, updateWorkspace],
  );

  const handleSelectTabRelative = useCallback(
    (delta: number) => {
      updateWorkspace((current) => {
        if (current.tabs.length <= 1) {
          return current;
        }
        const currentIndex = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
        if (currentIndex < 0) {
          return current;
        }
        const nextIndex = (currentIndex + delta + current.tabs.length) % current.tabs.length;
        return { ...current, activeTabId: current.tabs[nextIndex].id };
      });
    },
    [updateWorkspace],
  );

  const handleSelectTabIndex = useCallback(
    (index: number) => {
      updateWorkspace((current) => {
        if (index < 0 || index >= current.tabs.length) {
          return current;
        }
        return { ...current, activeTabId: current.tabs[index].id };
      });
    },
    [updateWorkspace],
  );

  const handleSplit = useCallback(
    (direction: SplitDirection) => {
      updateWorkspace((current) => {
        const activeTab = current.tabs.find((tab) => tab.id === current.activeTabId);
        if (!activeTab) {
          return current;
        }
        const newSessionId = createId();
        const nextRoot = splitPane(activeTab.root, activeTab.activeSessionId, direction, newSessionId);
        const nextTab = {
          ...activeTab,
          root: nextRoot,
          activeSessionId: newSessionId,
        };
        return {
          ...current,
          tabs: current.tabs.map((tab) => (tab.id === activeTab.id ? nextTab : tab)),
          sessions: {
            ...current.sessions,
            [newSessionId]: { id: newSessionId, cwd: current.projectPath, savedState: null },
          },
        };
      });
    },
    [updateWorkspace],
  );

  const handleSessionExit = useCallback(
    (sessionId: string) => {
      const current = workspaceRef.current;
      if (!current) {
        cleanupRuntimeBySessionIds([sessionId]);
      } else {
        const targetTab = current.tabs.find((tab) => findPanePath(tab.root, sessionId) !== null) ?? null;
        if (!targetTab) {
          cleanupRuntimeBySessionIds([sessionId]);
        } else {
          const nextRoot = removePane(targetTab.root, sessionId);
          const beforeSessionIds = collectSessionIds(targetTab.root);
          const afterSessionIds = nextRoot ? collectSessionIds(nextRoot) : [];
          const afterSet = new Set(afterSessionIds);
          const removedSessions = beforeSessionIds.filter((id) => !afterSet.has(id));
          cleanupRuntimeBySessionIds(removedSessions);
        }
      }

      updateWorkspace((current) => {
        const targetIndex = current.tabs.findIndex((tab) => findPanePath(tab.root, sessionId) !== null);
        if (targetIndex < 0) {
          return current;
        }

        const targetTab = current.tabs[targetIndex];
        const nextRoot = removePane(targetTab.root, sessionId);
        const beforeSessionIds = collectSessionIds(targetTab.root);
        const afterSessionIds = nextRoot ? collectSessionIds(nextRoot) : [];
        const afterSet = new Set(afterSessionIds);
        const removedSessions = beforeSessionIds.filter((id) => !afterSet.has(id));

        const nextSessions = { ...current.sessions };
        removedSessions.forEach((id) => {
          delete nextSessions[id];
        });

        if (!nextRoot) {
          const remainingTabs = current.tabs.filter((tab) => tab.id !== targetTab.id);
          if (remainingTabs.length === 0) {
            return createDefaultWorkspace(current.projectPath, current.projectId, workspaceDefaultsRef.current);
          }
          const nextActiveTabId =
            current.activeTabId === targetTab.id ? remainingTabs[0].id : current.activeTabId;
          return {
            ...current,
            tabs: remainingTabs,
            activeTabId: nextActiveTabId,
            sessions: nextSessions,
          };
        }

        const nextActiveSessionId = afterSet.has(targetTab.activeSessionId)
          ? targetTab.activeSessionId
          : afterSessionIds[0];
        const nextTab = { ...targetTab, root: nextRoot, activeSessionId: nextActiveSessionId };
        return {
          ...current,
          tabs: current.tabs.map((tab) => (tab.id === targetTab.id ? nextTab : tab)),
          sessions: nextSessions,
        };
      });
    },
    [cleanupRuntimeBySessionIds, updateWorkspace],
  );

  const setQuickCommandsPanelOpen = useCallback(
    (open: boolean) => {
      updateWorkspace((current) => ({
        ...current,
        ui: {
          ...current.ui,
          quickCommandsPanel: {
            ...(current.ui?.quickCommandsPanel ?? {
              open: workspaceDefaultsRef.current.defaultQuickCommandsPanelOpen,
              x: null,
              y: null,
            }),
            open,
          },
        },
      }));
    },
    [updateWorkspace],
  );

  const setFileExplorerShowHidden = useCallback(
    (showHidden: boolean) => {
      updateWorkspace((current) => ({
        ...current,
        ui: {
          ...current.ui,
          fileExplorerPanel: {
            ...(current.ui?.fileExplorerPanel ?? {
              open: workspaceDefaultsRef.current.defaultFileExplorerPanelOpen,
              showHidden: workspaceDefaultsRef.current.defaultFileExplorerShowHidden,
            }),
            showHidden,
          },
        },
      }));
    },
    [updateWorkspace],
  );

  const updateRightSidebar = useCallback(
    (updater: (current: RightSidebarState) => RightSidebarState) => {
      updateWorkspace((current) => {
        const ui = current.ui ?? {};
        const filePanel = ui.fileExplorerPanel ?? {
          open: workspaceDefaultsRef.current.defaultFileExplorerPanelOpen,
          showHidden: workspaceDefaultsRef.current.defaultFileExplorerShowHidden,
        };
        const gitPanel = ui.gitPanel ?? { open: false };
        const rightSidebar = ui.rightSidebar ?? DEFAULT_RIGHT_SIDEBAR;
        const nextRightSidebar = updater(rightSidebar);
        return {
          ...current,
          ui: {
            ...ui,
            rightSidebar: nextRightSidebar,
            fileExplorerPanel: {
              ...filePanel,
              open: nextRightSidebar.open && nextRightSidebar.tab === "files",
            },
            gitPanel: {
              ...gitPanel,
              open: nextRightSidebar.open && nextRightSidebar.tab === "git",
            },
          },
        };
      });
    },
    [updateWorkspace],
  );

  const closeRightSidebar = useCallback(() => {
    updateRightSidebar((current) => ({ ...current, open: false }));
    setPreviewFilePath(null);
    setPreviewDirty(false);
  }, [updateRightSidebar]);

  const requestCloseRightSidebar = useCallback(() => {
    if (previewDirty) {
      const ok = window.confirm("当前文件有未保存修改，确定关闭侧边栏？");
      if (!ok) {
        return;
      }
    }
    closeRightSidebar();
  }, [closeRightSidebar, previewDirty]);

  const setRightSidebarTab = useCallback(
    (tab: TerminalRightSidebarTab) => {
      updateRightSidebar((current) => ({ ...current, tab, open: true }));
    },
    [updateRightSidebar],
  );

  const setRightSidebarWidth = useCallback(
    (width: number) => {
      updateRightSidebar((current) => ({ ...current, width }));
    },
    [updateRightSidebar],
  );

  const commitQuickCommandsPanelPosition = useCallback(
    (x: number, y: number) => {
      updateWorkspace((current) => ({
        ...current,
        ui: {
          ...current.ui,
          quickCommandsPanel: {
            ...(current.ui?.quickCommandsPanel ?? {
              open: workspaceDefaultsRef.current.defaultQuickCommandsPanelOpen,
              x: null,
              y: null,
            }),
            x,
            y,
          },
        },
      }));
    },
    [updateWorkspace],
  );

  const beginDragQuickCommandsPanel = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const current = workspaceRef.current;
      const panel = current?.ui?.quickCommandsPanel ?? {
        open: workspaceDefaultsRef.current.defaultQuickCommandsPanelOpen,
        x: null,
        y: null,
      };
      const base = panelDraftRef.current ?? { x: panel.x ?? 12, y: panel.y ?? 12 };
      dragStateRef.current = {
        startClientX: event.clientX,
        startClientY: event.clientY,
        baseX: base.x,
        baseY: base.y,
      };

      const handleMove = (moveEvent: PointerEvent) => {
        const state = dragStateRef.current;
        if (!state) {
          return;
        }
        const stage = stageRef.current;
        if (!stage) {
          return;
        }
        const stageRect = stage.getBoundingClientRect();
        const panelRect = panelRef.current?.getBoundingClientRect() ?? null;
        const panelWidth = panelRect ? panelRect.width : 260;
        const panelHeight = panelRect ? panelRect.height : 240;
        const margin = 8;
        const maxX = Math.max(margin, Math.round(stageRect.width - panelWidth - margin));
        const maxY = Math.max(margin, Math.round(stageRect.height - panelHeight - margin));

        const dx = moveEvent.clientX - state.startClientX;
        const dy = moveEvent.clientY - state.startClientY;
        const nextX = Math.min(maxX, Math.max(margin, Math.round(state.baseX + dx)));
        const nextY = Math.min(maxY, Math.max(margin, Math.round(state.baseY + dy)));
        panelDraftRef.current = { x: nextX, y: nextY };
        setPanelDraft({ x: nextX, y: nextY });
      };

      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        const latest = panelDraftRef.current;
        panelDraftRef.current = null;
        dragStateRef.current = null;
        if (latest) {
          commitQuickCommandsPanelPosition(latest.x, latest.y);
        }
        setPanelDraft(null);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [commitQuickCommandsPanelPosition],
  );

  useEffect(() => {
    if (!isActive) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isInteractionLocked()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.defaultPrevented || event.repeat) {
        return;
      }
      if (!event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();

      // 仅按下 Cmd（Meta）本身也可能触发 WebView/页面滚动（尤其在终端处于非底部时），直接吞掉。
      if (key === "meta") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // iTerm2 风格：⌘D 向右分屏，⌘⇧D 向下分屏。
      if (key === "d") {
        event.preventDefault();
        event.stopPropagation();
        handleSplit(event.shiftKey ? "b" : "r");
        return;
      }

      // ⌘T：新建标签页
      if (key === "t" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        handleNewTab();
        return;
      }

      // ⌘W：关闭当前 Pane；若该 Tab 只剩最后一个 Pane，则关闭 Tab
      if (key === "w" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        const current = workspaceRef.current;
        if (!current) {
          return;
        }
        const activeTab = current.tabs.find((tab) => tab.id === current.activeTabId);
        if (!activeTab) {
          return;
        }
        handleSessionExit(activeTab.activeSessionId);
        return;
      }

      // ⌘↑/⌘←：上一 Tab；⌘↓/⌘→：下一 Tab
      if (
        !event.shiftKey &&
        (event.code === "ArrowLeft" ||
          event.code === "ArrowRight" ||
          event.code === "ArrowUp" ||
          event.code === "ArrowDown")
      ) {
        event.preventDefault();
        event.stopPropagation();
        handleSelectTabRelative(event.code === "ArrowLeft" || event.code === "ArrowUp" ? -1 : 1);
        return;
      }

      // ⌘⇧[ / ⌘⇧]：上一/下一 Tab（浏览器/iTerm2 常用）
      if (event.shiftKey && (event.code === "BracketLeft" || event.code === "BracketRight")) {
        event.preventDefault();
        event.stopPropagation();
        handleSelectTabRelative(event.code === "BracketLeft" ? -1 : 1);
        return;
      }

      // ⌘1..⌘8：切换到对应 Tab；⌘9：切到最后一个 Tab（浏览器常用）
      if (!event.shiftKey) {
        const digit = Number.parseInt(key, 10);
        if (Number.isFinite(digit) && digit >= 1 && digit <= 9) {
          event.preventDefault();
          event.stopPropagation();
          const current = workspaceRef.current;
          if (!current) {
            return;
          }
          const index = digit === 9 ? current.tabs.length - 1 : digit - 1;
          handleSelectTabIndex(index);
        }
      }
    };

    // Capture phase：确保终端（xterm）聚焦时也能触发快捷键。
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [handleNewTab, handleSelectTabIndex, handleSelectTabRelative, handleSessionExit, handleSplit, isActive]);

  const handleResize = useCallback(
    (path: number[], ratios: number[]) => {
      updateWorkspace((current) => {
        const activeTab = current.tabs.find((tab) => tab.id === current.activeTabId);
        if (!activeTab) {
          return current;
        }
        const nextRoot = updateSplitRatios(activeTab.root, path, ratios);
        const nextTab = { ...activeTab, root: nextRoot };
        return {
          ...current,
          tabs: current.tabs.map((tab) => (tab.id === activeTab.id ? nextTab : tab)),
        };
      });
    },
    [updateWorkspace],
  );

  const handleActivateSession = useCallback(
    (tabId: string, sessionId: string) => {
      updateWorkspace((current) => {
        const nextTabs = current.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, activeSessionId: sessionId } : tab,
        );
        return { ...current, tabs: nextTabs };
      });
    },
    [updateWorkspace],
  );

  const isScriptRuntimeValid = useCallback((runtime: ScriptRuntime) => {
    const current = workspaceRef.current;
    if (!current) {
      return false;
    }
    if (!current.sessions[runtime.sessionId]) {
      return false;
    }
    const tab = current.tabs.find((item) => item.id === runtime.tabId);
    if (!tab) {
      return false;
    }
    return findPanePath(tab.root, runtime.sessionId) !== null;
  }, []);

  const handlePtyReady = useCallback((sessionId: string, ptyId: string) => {
    sessionPtyIdRef.current.set(sessionId, ptyId);

    const scriptId = scriptIdBySessionIdRef.current.get(sessionId);
    if (scriptId) {
      setScriptRuntimeById((prev) => {
        const runtime = prev[scriptId];
        if (!runtime || runtime.sessionId !== sessionId || runtime.ptyId === ptyId) {
          return prev;
        }
        return { ...prev, [scriptId]: { ...runtime, ptyId } };
      });
    }

    const command = pendingStartBySessionIdRef.current.get(sessionId);
    if (!command) {
      return;
    }
    pendingStartBySessionIdRef.current.delete(sessionId);
    const payload = command.endsWith("\r") ? command : `${command}\r`;
    void writeTerminal(ptyId, payload).catch((error) => {
      console.error("快捷命令下发失败。", error);
    });
  }, []);

  const runQuickCommand = useCallback(
    (script: ProjectScript) => {
      if (!script.start.trim()) {
        showPanelMessage("启动命令为空");
        return;
      }
      const rendered = renderScriptTemplateCommand(script);
      if (!rendered.ok) {
        showPanelMessage(rendered.error);
        return;
      }
      const current = workspaceRef.current;
      if (!current) {
        showPanelMessage("终端工作区尚未就绪");
        return;
      }

      const existing = scriptRuntimeByIdRef.current[script.id] ?? null;
      if (existing && isScriptRuntimeValid(existing)) {
        showPanelMessage("命令已在运行，已切换到对应终端");
        updateWorkspace((ws) => {
          const nextTabs = ws.tabs.map((tab) => {
            if (tab.id !== existing.tabId) {
              return tab;
            }
            return tab.activeSessionId === existing.sessionId ? tab : { ...tab, activeSessionId: existing.sessionId };
          });
          return { ...ws, activeTabId: existing.tabId, tabs: nextTabs };
        });
        return;
      }

      if (existing) {
        cleanupRuntimeBySessionIds([existing.sessionId]);
      }

      const sessionId = createId();
      const tabId = createId();
      scriptIdBySessionIdRef.current.set(sessionId, script.id);
      pendingStartBySessionIdRef.current.set(
        sessionId,
        wrapQuickCommandForShell(rendered.command.trim(), sessionId, {
          DEVHAVEN_SHARED_SCRIPTS: appState.settings.sharedScriptsRoot,
          DEVHAVEN_PROJECT_PATH: current.projectPath || projectPath,
        }),
      );

      setScriptRuntimeById((prev) => ({
        ...prev,
        [script.id]: { tabId, sessionId, ptyId: null },
      }));

      updateWorkspace((ws) => {
        const title = script.name.trim() ? script.name.trim() : `命令 ${ws.tabs.length + 1}`;
        return {
          ...ws,
          activeTabId: tabId,
          tabs: [
            ...ws.tabs,
            { id: tabId, title, root: { type: "pane", sessionId }, activeSessionId: sessionId },
          ],
          sessions: {
            ...ws.sessions,
            [sessionId]: { id: sessionId, cwd: ws.projectPath, savedState: null },
          },
        };
      });
    },
    [
      appState.settings.sharedScriptsRoot,
      cleanupRuntimeBySessionIds,
      isScriptRuntimeValid,
      projectPath,
      showPanelMessage,
      updateWorkspace,
    ],
  );

  const stopQuickCommand = useCallback(
    (scriptId: string) => {
      const runtime = scriptRuntimeByIdRef.current[scriptId] ?? null;
      if (!runtime || !isScriptRuntimeValid(runtime)) {
        if (runtime) {
          cleanupRuntimeBySessionIds([runtime.sessionId]);
        }
        showPanelMessage("该命令未在运行");
        return;
      }

      const ptyId = runtime.ptyId ?? sessionPtyIdRef.current.get(runtime.sessionId) ?? null;
      handleSessionExit(runtime.sessionId);
      if (ptyId) {
        void killTerminal(ptyId).catch((error) => {
          console.error("停止快捷命令失败。", error);
        });
      }
    },
    [cleanupRuntimeBySessionIds, handleSessionExit, isScriptRuntimeValid, showPanelMessage],
  );

  const handleQuickCommandAction = useCallback(
    (action: TerminalQuickCommandAction) => {
      const requestId = action.payload.requestId;
      const handled = handledRequestIdsRef.current;
      if (handled.has(requestId)) {
        return;
      }
      handled.add(requestId);
      if (handled.size > 200) {
        handled.clear();
        handled.add(requestId);
      }

      if (!workspaceRef.current) {
        pendingExternalActionsRef.current.push(action);
        return;
      }

      if (action.type === "run") {
        const script = scripts.find((item) => item.id === action.payload.scriptId) ?? null;
        if (!script) {
          showPanelMessage("命令不存在或已被删除");
          return;
        }
        runQuickCommand(script);
        return;
      }

      stopQuickCommand(action.payload.scriptId);
    },
    [runQuickCommand, scripts, showPanelMessage, stopQuickCommand],
  );

  useEffect(() => {
    if (!projectPath) {
      return;
    }
    const pending = takeTerminalQuickCommandActionsForProject(projectPath);
    if (pending.length === 0) {
      return;
    }
    pending.forEach(handleQuickCommandAction);
  }, [handleQuickCommandAction, projectPath]);

  useEffect(() => {
    let unlistenRun: (() => void) | null = null;
    let unlistenStop: (() => void) | null = null;

    const registerListener = async () => {
      try {
        unlistenRun = await listen<TerminalQuickCommandRunPayload>(TERMINAL_QUICK_COMMAND_RUN_EVENT, (event) => {
          const payload = event.payload;
          if (payload.projectPath !== projectPath) {
            return;
          }
          if (projectId && payload.projectId !== projectId) {
            return;
          }
          handleQuickCommandAction({ type: "run", payload });
        });
        unlistenStop = await listen<TerminalQuickCommandStopPayload>(TERMINAL_QUICK_COMMAND_STOP_EVENT, (event) => {
          const payload = event.payload;
          if (payload.projectPath !== projectPath) {
            return;
          }
          if (projectId && payload.projectId !== projectId) {
            return;
          }
          handleQuickCommandAction({ type: "stop", payload });
        });
      } catch (error) {
        console.error("监听快捷命令事件失败。", error);
      }
    };

    void registerListener();

    return () => {
      unlistenRun?.();
      unlistenStop?.();
    };
  }, [handleQuickCommandAction, projectId, projectPath]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    const pending = pendingExternalActionsRef.current;
    if (pending.length === 0) {
      return;
    }
    pendingExternalActionsRef.current = [];
    pending.forEach(handleQuickCommandAction);
  }, [handleQuickCommandAction, workspace]);

  useEffect(() => {
    if (!workspace || !isActive) {
      setCodexPaneOverlayBySessionId({});
      return;
    }

    const sessionIds = Object.keys(workspace.sessions ?? {});
    if (sessionIds.length === 0) {
      setCodexPaneOverlayBySessionId({});
      return;
    }

    let cancelled = false;

    const refreshOverlay = async () => {
      if (document.visibilityState === "hidden") {
        return;
      }

      try {
        const items = await getTerminalCodexPaneOverlay(windowLabel, sessionIds);
        if (cancelled) {
          return;
        }
        const next: Record<string, TerminalCodexPaneOverlay> = {};
        for (const item of items ?? []) {
          if (!item?.sessionId) {
            continue;
          }
          next[item.sessionId] = item;
        }
        setCodexPaneOverlayBySessionId(next);
      } catch {
        if (!cancelled) {
          setCodexPaneOverlayBySessionId({});
        }
      }
    };

    void refreshOverlay();
    const timer = window.setInterval(() => {
      void refreshOverlay();
    }, CODEX_PANE_OVERLAY_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isActive, windowLabel, workspace]);

  if (!projectPath) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--terminal-muted-fg)]">
        未找到项目
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--terminal-muted-fg)]">
        {error}
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--terminal-muted-fg)]">
        正在加载终端工作空间...
      </div>
    );
  }

  const panelState = workspace.ui?.quickCommandsPanel ?? {
    open: workspaceDefaultsRef.current.defaultQuickCommandsPanelOpen,
    x: null,
    y: null,
  };
  const panelOpen = Boolean(panelState.open);
  const panelPosition = panelDraft ?? { x: panelState.x ?? 12, y: panelState.y ?? 12 };

  const filePanelState = workspace.ui?.fileExplorerPanel ?? {
    open: workspaceDefaultsRef.current.defaultFileExplorerPanelOpen,
    showHidden: workspaceDefaultsRef.current.defaultFileExplorerShowHidden,
  };
  const rightSidebarState = workspace.ui?.rightSidebar ?? DEFAULT_RIGHT_SIDEBAR;
  const rightSidebarOpen = Boolean(rightSidebarState.open);
  const rightSidebarWidth = Math.max(
    MIN_RIGHT_SIDEBAR_WIDTH,
    Math.min(MAX_RIGHT_SIDEBAR_WIDTH, rightSidebarState.width),
  );
  const rightSidebarTab: TerminalRightSidebarTab =
    rightSidebarState.tab === "git" && !isGitRepo ? "files" : rightSidebarState.tab;

  return (
    <div className="flex h-full flex-col bg-[var(--terminal-bg)] text-[var(--terminal-fg)]">
      <header className="flex items-center gap-3 border-b border-[var(--terminal-divider)] bg-[var(--terminal-panel-bg)] px-3 py-2">
        <div className="max-w-[200px] truncate text-[13px] font-semibold text-[var(--terminal-fg)]">
          {projectName ?? projectPath}
        </div>
        {codexRunningCount > 0 ? (
          <div
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--terminal-divider)] bg-[var(--terminal-hover-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--terminal-muted-fg)]"
            title={`Codex 运行中（${codexRunningCount} 个会话）`}
          >
            <span className="h-2 w-2 rounded-full bg-[var(--terminal-accent)]" aria-hidden="true" />
            <span className="whitespace-nowrap">Codex 运行中</span>
          </div>
        ) : null}
        <button
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--terminal-divider)] text-[var(--terminal-muted-fg)] transition-colors duration-150 hover:bg-[var(--terminal-hover-bg)] hover:text-[var(--terminal-fg)] ${
            panelOpen ? "bg-[var(--terminal-hover-bg)]" : ""
          }`}
          type="button"
          title={panelOpen ? "隐藏快捷命令" : "显示快捷命令"}
          onClick={() => setQuickCommandsPanelOpen(!panelOpen)}
        >
          <IconSidebarRight size={16} />
        </button>
        <button
          className={`inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--terminal-divider)] px-2 text-[var(--terminal-muted-fg)] transition-colors duration-150 hover:bg-[var(--terminal-hover-bg)] hover:text-[var(--terminal-fg)] ${
            rightSidebarOpen ? "bg-[var(--terminal-hover-bg)]" : ""
          }`}
          type="button"
          title={rightSidebarOpen ? "隐藏侧边栏" : "显示侧边栏"}
          onClick={() => {
            if (rightSidebarOpen) {
              requestCloseRightSidebar();
              return;
            }
            setRightSidebarTab(rightSidebarTab === "files" && isGitRepo ? "git" : "files");
          }}
        >
          {rightSidebarTab === "files" ? <IconFolder size={16} /> : <IconGitBranch size={16} />}
          <span className="text-[12px] font-semibold">{rightSidebarTab === "files" ? "文件" : "Git"}</span>
        </button>
        <TerminalTabs
          tabs={workspace.tabs}
          activeTabId={workspace.activeTabId}
          onSelect={handleSelectTab}
          onNewTab={handleNewTab}
          onCloseTab={handleCloseTab}
        />
      </header>
      <div ref={stageRef} className="relative flex min-h-0 flex-1">
        {panelOpen ? (
          <div
            ref={panelRef}
            className="absolute z-20 w-[260px] select-none rounded-lg border border-[var(--terminal-divider)] bg-[var(--terminal-panel-bg)] shadow-lg"
            style={{ transform: `translate3d(${panelPosition.x}px, ${panelPosition.y}px, 0)` }}
          >
            <div
              className="flex items-center justify-between gap-2 border-b border-[var(--terminal-divider)] px-3 py-2 text-[12px] font-semibold text-[var(--terminal-muted-fg)] cursor-move"
              onPointerDown={beginDragQuickCommandsPanel}
            >
              <span className="truncate">快捷命令</span>
              <button
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-[var(--terminal-muted-fg)] hover:border-[var(--terminal-divider)] hover:bg-[var(--terminal-hover-bg)] hover:text-[var(--terminal-fg)]"
                type="button"
                title="关闭"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuickCommandsPanelOpen(false);
                }}
              >
                <IconX size={12} />
              </button>
            </div>
            <div className="max-h-[360px] overflow-y-auto p-2">
              {panelMessage ? (
                <div className="px-2 pb-2 text-[11px] font-semibold text-[var(--terminal-muted-fg)]">
                  {panelMessage}
                </div>
              ) : null}
              {scripts.length === 0 ? (
                <div className="px-2 py-2 text-[12px] text-[var(--terminal-muted-fg)]">
                  暂无快捷命令，请在项目详情面板中配置
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {scripts.map((script) => {
                    const runtime = scriptRuntimeById[script.id] ?? null;
                    const isRunning = runtime ? isScriptRuntimeValid(runtime) : false;
                    return (
                      <div
                        key={script.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-[var(--terminal-divider)] bg-[var(--terminal-bg)] px-2.5 py-2"
                        title={script.start}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-semibold text-[var(--terminal-fg)]">
                            {script.name}
                          </div>
                          <div className="truncate text-[11px] text-[var(--terminal-muted-fg)]">
                            {script.start}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {isRunning ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[var(--terminal-muted-fg)]">
                              <span
                                className="h-2 w-2 rounded-full bg-[var(--terminal-accent)]"
                                aria-hidden="true"
                              />
                              <span className="whitespace-nowrap">运行中</span>
                            </span>
                          ) : null}
                          <button
                            className="inline-flex h-7 items-center justify-center rounded-md border border-[var(--terminal-divider)] bg-[var(--terminal-hover-bg)] px-2 text-[11px] font-semibold text-[var(--terminal-muted-fg)] transition-colors duration-150 hover:text-[var(--terminal-fg)]"
                            type="button"
                            onClick={() => runQuickCommand(script)}
                          >
                            运行
                          </button>
                          <button
                            className="inline-flex h-7 items-center justify-center rounded-md border border-[var(--terminal-divider)] bg-transparent px-2 text-[11px] font-semibold text-[var(--terminal-muted-fg)] transition-colors duration-150 hover:bg-[var(--terminal-hover-bg)] hover:text-[var(--terminal-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                            type="button"
                            disabled={!isRunning}
                            onClick={() => stopQuickCommand(script.id)}
                          >
                            停止
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="relative flex min-h-0 min-w-0 flex-1">
            {workspace.tabs.map((tab) => (
              <div
                key={tab.id}
                className={`absolute inset-0 flex min-h-0 flex-1 ${
                  tab.id === workspace.activeTabId ? "opacity-100" : "opacity-0 pointer-events-none"
                }`}
              >
                <SplitLayout
                  root={tab.root}
                  activeSessionId={tab.activeSessionId}
                  onActivate={(sessionId) => handleActivateSession(tab.id, sessionId)}
                  onResize={handleResize}
                  renderPane={(sessionId, isActive) => (
                    <TerminalPane
                      sessionId={sessionId}
                      cwd={workspace.sessions[sessionId]?.cwd ?? workspace.projectPath}
                      savedState={workspace.sessions[sessionId]?.savedState ?? null}
                      codexPaneOverlay={(() => {
                        const backendOverlay = codexPaneOverlayBySessionId[sessionId] ?? null;
                        if (!backendOverlay) {
                          return null;
                        }
                        const startupHint = codexStartupHintBySessionId[sessionId] ?? null;
                        if (!startupHint) {
                          return backendOverlay;
                        }
                        return {
                          ...backendOverlay,
                          model: startupHint.model ?? backendOverlay.model,
                          effort: startupHint.effort ?? backendOverlay.effort,
                        };
                      })()}
                      windowLabel={windowLabel}
                      // 仅对当前激活 Tab 启用 WebGL 渲染，避免创建过多 WebGL contexts（浏览器有上限）。
                      useWebgl={appState.settings.terminalUseWebglRenderer && tab.id === workspace.activeTabId}
                      theme={xtermTheme}
                      isActive={tab.id === workspace.activeTabId && isActive}
                      onActivate={(nextSessionId) => handleActivateSession(tab.id, nextSessionId)}
                      onPtyReady={handlePtyReady}
                      onExit={handleSessionExit}
                      onRegisterSnapshotProvider={registerSnapshotProvider}
                    />
                  )}
                />
              </div>
            ))}
          </div>
          {rightSidebarOpen ? (
            <ResizablePanel
              width={rightSidebarWidth}
              onWidthChange={setRightSidebarWidth}
              minWidth={MIN_RIGHT_SIDEBAR_WIDTH}
              maxWidth={MAX_RIGHT_SIDEBAR_WIDTH}
              handleSide="left"
            >
              <TerminalRightSidebar
                projectPath={projectPath}
                isGitRepo={isGitRepo}
                sidebarWidth={rightSidebarWidth}
                activeTab={rightSidebarTab}
                previewDirty={previewDirty}
                previewFilePath={previewFilePath}
                showHidden={Boolean(filePanelState.showHidden)}
                onToggleShowHidden={setFileExplorerShowHidden}
                onSelectFile={(relativePath) => {
                  if (previewDirty && relativePath !== previewFilePath) {
                    const ok = window.confirm("当前文件有未保存修改，确定切换文件？");
                    if (!ok) {
                      return;
                    }
                  }
                  setPreviewFilePath(relativePath);
                  setPreviewDirty(false);
                }}
                onClosePreview={() => {
                  setPreviewFilePath(null);
                  setPreviewDirty(false);
                }}
                onPreviewDirtyChange={setPreviewDirty}
                onChangeTab={setRightSidebarTab}
                onClose={requestCloseRightSidebar}
              />
            </ResizablePanel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
