import type {
  FileExplorerPanelState,
  GitPanelState,
  QuickCommandsPanelState,
  RunConfigurationState,
  RightSidebarState,
  SplitDirection,
  SplitNode,
  SplitOrientation,
  TerminalRightSidebarTab,
  TerminalSessionSnapshot,
  TerminalWorkspaceUi,
  TerminalWorkspace,
} from "../models/terminal";

const FALLBACK_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_PANEL_OPEN = true;
const DEFAULT_RUN_CONFIGURATION_SCRIPT_ID: string | null = null;
const DEFAULT_FILE_PANEL_OPEN = false;
const DEFAULT_FILE_PANEL_SHOW_HIDDEN = false;
const DEFAULT_GIT_PANEL_OPEN = false;
const DEFAULT_RIGHT_SIDEBAR_OPEN = false;
const DEFAULT_RIGHT_SIDEBAR_WIDTH = 520;
const DEFAULT_RIGHT_SIDEBAR_TAB: TerminalRightSidebarTab = "files";

export type TerminalWorkspaceDefaults = {
  defaultQuickCommandsPanelOpen?: boolean;
  defaultFileExplorerPanelOpen?: boolean;
  defaultFileExplorerShowHidden?: boolean;
  defaultGitPanelOpen?: boolean;
  defaultRightSidebarOpen?: boolean;
  defaultRightSidebarWidth?: number;
  defaultRightSidebarTab?: TerminalRightSidebarTab;
};

export function createId() {
  // 部分 WebView/旧版本环境里 `crypto.randomUUID` 可能不存在或不是函数；用更严格的判断避免运行时崩溃。
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  let value = "";
  for (let i = 0; i < 16; i += 1) {
    value += FALLBACK_ID_CHARS[Math.floor(Math.random() * FALLBACK_ID_CHARS.length)];
  }
  return value;
}

export function createDefaultWorkspace(
  projectPath: string,
  projectId: string | null,
  defaults?: TerminalWorkspaceDefaults,
): TerminalWorkspace {
  const sessionId = createId();
  const tabId = createId();
  const now = Date.now();
  return {
    version: 1,
    projectId,
    projectPath,
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        title: "终端 1",
        root: { type: "pane", sessionId },
        activeSessionId: sessionId,
      },
    ],
    sessions: {
      [sessionId]: {
        id: sessionId,
        cwd: projectPath,
        savedState: null,
      },
    },
    ui: normalizeWorkspaceUi(undefined, defaults),
    updatedAt: now,
  };
}

export function normalizeWorkspace(
  workspace: TerminalWorkspace,
  projectPath: string,
  projectId: string | null,
  defaults?: TerminalWorkspaceDefaults,
): TerminalWorkspace {
  if (!workspace || !Array.isArray(workspace.tabs) || workspace.tabs.length === 0) {
    return createDefaultWorkspace(projectPath, projectId, defaults);
  }
  const sessions = { ...(workspace.sessions ?? {}) } as Record<string, TerminalSessionSnapshot>;
  const tabs = workspace.tabs.map((tab, index) => {
    const normalizedRoot = normalizeNode(tab.root);
    const sessionIds = collectSessionIds(normalizedRoot);
    if (sessionIds.length === 0) {
      const nextSessionId = createId();
      sessions[nextSessionId] = {
        id: nextSessionId,
        cwd: projectPath,
        savedState: null,
      };
      const rootPane: SplitNode = { type: "pane", sessionId: nextSessionId };
      return {
        ...tab,
        title: tab.title || `终端 ${index + 1}`,
        root: rootPane,
        activeSessionId: nextSessionId,
      };
    }
    sessionIds.forEach((sessionId) => {
      if (!sessions[sessionId]) {
        sessions[sessionId] = { id: sessionId, cwd: projectPath, savedState: null };
      }
    });
    const activeSessionId = sessionIds.includes(tab.activeSessionId)
      ? tab.activeSessionId
      : sessionIds[0];
    return {
      ...tab,
      title: tab.title || `终端 ${index + 1}`,
      root: normalizedRoot,
      activeSessionId,
    };
  });
  const activeTabId = tabs.some((tab) => tab.id === workspace.activeTabId)
    ? workspace.activeTabId
    : tabs[0].id;
  return {
    ...workspace,
    version: 1,
    projectId: projectId ?? workspace.projectId ?? null,
    projectPath,
    tabs,
    activeTabId,
    sessions,
    ui: normalizeWorkspaceUi(workspace.ui, defaults),
    updatedAt: workspace.updatedAt ?? Date.now(),
  };
}

export function normalizeWorkspaceUi(
  value: TerminalWorkspace["ui"],
  defaults?: TerminalWorkspaceDefaults,
): TerminalWorkspaceUi {
  const resolved: TerminalWorkspaceUi = value && typeof value === "object" ? { ...value } : {};
  const panel = normalizeQuickCommandsPanel(
    resolved.quickCommandsPanel,
    defaults?.defaultQuickCommandsPanelOpen ?? DEFAULT_PANEL_OPEN,
  );
  const runConfiguration = normalizeRunConfiguration(
    resolved.runConfiguration,
    DEFAULT_RUN_CONFIGURATION_SCRIPT_ID,
  );
  const filePanel = normalizeFileExplorerPanel(
    resolved.fileExplorerPanel,
    defaults?.defaultFileExplorerPanelOpen ?? DEFAULT_FILE_PANEL_OPEN,
    defaults?.defaultFileExplorerShowHidden ?? DEFAULT_FILE_PANEL_SHOW_HIDDEN,
  );
  const gitPanel = normalizeGitPanel(
    resolved.gitPanel,
    defaults?.defaultGitPanelOpen ?? DEFAULT_GIT_PANEL_OPEN,
  );
  const rightSidebar = normalizeRightSidebar(
    resolved.rightSidebar,
    {
      fileOpen: filePanel.open,
      gitOpen: gitPanel.open,
    },
    {
      open: defaults?.defaultRightSidebarOpen ?? DEFAULT_RIGHT_SIDEBAR_OPEN,
      width: defaults?.defaultRightSidebarWidth ?? DEFAULT_RIGHT_SIDEBAR_WIDTH,
      tab: defaults?.defaultRightSidebarTab ?? DEFAULT_RIGHT_SIDEBAR_TAB,
    },
  );

  // Legacy flags are kept in sync so old code paths and persisted data remain consistent.
  const syncedFilePanel: FileExplorerPanelState = {
    ...filePanel,
    open: rightSidebar.open && rightSidebar.tab === "files",
  };
  const syncedGitPanel: GitPanelState = {
    ...gitPanel,
    open: rightSidebar.open && rightSidebar.tab === "git",
  };

  return {
    ...resolved,
    quickCommandsPanel: panel,
    runConfiguration,
    fileExplorerPanel: syncedFilePanel,
    gitPanel: syncedGitPanel,
    rightSidebar,
  };
}

function normalizeQuickCommandsPanel(value: unknown, defaultOpen: boolean): QuickCommandsPanelState {
  if (!value || typeof value !== "object") {
    return { open: defaultOpen, x: null, y: null };
  }
  const asRecord = value as Record<string, unknown>;
  const open = typeof asRecord.open === "boolean" ? asRecord.open : defaultOpen;
  const x = typeof asRecord.x === "number" ? asRecord.x : null;
  const y = typeof asRecord.y === "number" ? asRecord.y : null;
  return { open, x, y };
}

function normalizeRunConfiguration(
  value: unknown,
  defaultSelectedScriptId: string | null,
): RunConfigurationState {
  if (!value || typeof value !== "object") {
    return { selectedScriptId: defaultSelectedScriptId };
  }
  const asRecord = value as Record<string, unknown>;
  const selectedScriptId =
    typeof asRecord.selectedScriptId === "string" && asRecord.selectedScriptId.trim().length > 0
      ? asRecord.selectedScriptId
      : defaultSelectedScriptId;
  return { selectedScriptId };
}

function normalizeFileExplorerPanel(
  value: unknown,
  defaultOpen: boolean,
  defaultShowHidden: boolean,
): FileExplorerPanelState {
  if (!value || typeof value !== "object") {
    return { open: defaultOpen, showHidden: defaultShowHidden };
  }
  const asRecord = value as Record<string, unknown>;
  const open = typeof asRecord.open === "boolean" ? asRecord.open : defaultOpen;
  const showHidden =
    typeof asRecord.showHidden === "boolean" ? asRecord.showHidden : defaultShowHidden;
  return { open, showHidden };
}

function normalizeGitPanel(value: unknown, defaultOpen: boolean): GitPanelState {
  if (!value || typeof value !== "object") {
    return { open: defaultOpen };
  }
  const asRecord = value as Record<string, unknown>;
  const open = typeof asRecord.open === "boolean" ? asRecord.open : defaultOpen;
  return { open };
}

function normalizeRightSidebar(
  value: unknown,
  legacy: { fileOpen: boolean; gitOpen: boolean },
  defaults: { open: boolean; width: number; tab: TerminalRightSidebarTab },
): RightSidebarState {
  const legacyOpen = Boolean(legacy.fileOpen || legacy.gitOpen);

  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const open = record && typeof record.open === "boolean" ? record.open : legacyOpen || defaults.open;
  const width = record && typeof record.width === "number" && Number.isFinite(record.width)
    ? record.width
    : defaults.width;
  const tabCandidate = record && typeof record.tab === "string" ? record.tab : null;
  const tab: TerminalRightSidebarTab =
    tabCandidate === "git" || tabCandidate === "files"
      ? tabCandidate
      : legacy.fileOpen
        ? "files"
        : legacy.gitOpen
          ? "git"
          : defaults.tab;

  // Keep a sane range; actual clamping during resize happens in the UI.
  const safeWidth = Math.max(220, Math.min(1200, width));
  return { open, width: safeWidth, tab };
}

export function collectSessionIds(node: SplitNode): string[] {
  if (node.type === "pane") {
    return [node.sessionId];
  }
  return node.children.flatMap((child) => collectSessionIds(child));
}

export function findPanePath(root: SplitNode, sessionId: string): number[] | null {
  if (root.type === "pane") {
    return root.sessionId === sessionId ? [] : null;
  }
  for (let i = 0; i < root.children.length; i += 1) {
    const child = root.children[i];
    const result = findPanePath(child, sessionId);
    if (result) {
      return [i, ...result];
    }
  }
  return null;
}

export function splitPane(
  root: SplitNode,
  targetSessionId: string,
  direction: SplitDirection,
  newSessionId: string,
): SplitNode {
  const orientation = splitOrientationFor(direction);
  const targetPath = findPanePath(root, targetSessionId);
  if (!targetPath) {
    return root;
  }
  const newPane: SplitNode = { type: "pane", sessionId: newSessionId };
  if (targetPath.length === 0) {
    return createSplitNode(root, newPane, orientation, direction);
  }
  const parentPath = targetPath.slice(0, -1);
  const targetIndex = targetPath[targetPath.length - 1];
  const parent = getNodeAtPath(root, parentPath);
  if (!parent || parent.type !== "split") {
    return root;
  }
  if (parent.orientation === orientation) {
    const insertBefore = direction === "l" || direction === "t";
    const insertIndex = insertBefore ? targetIndex : targetIndex + 1;
    const nextChildren = [...parent.children];
    nextChildren.splice(insertIndex, 0, newPane);
    const nextRatios = [...parent.ratios];
    const baseRatio = nextRatios[targetIndex] ?? 1 / parent.children.length;
    const half = baseRatio / 2;
    if (insertBefore) {
      nextRatios.splice(insertIndex, 0, half);
      nextRatios[targetIndex + 1] = half;
    } else {
      nextRatios[targetIndex] = half;
      nextRatios.splice(insertIndex, 0, half);
    }
    const updatedParent: SplitNode = {
      ...parent,
      children: nextChildren,
      ratios: normalizeRatios(nextRatios, nextChildren.length),
    };
    return updateNodeAtPath(root, parentPath, updatedParent);
  }
  const targetNode = parent.children[targetIndex];
  const splitNode = createSplitNode(targetNode, newPane, orientation, direction);
  return updateNodeAtPath(root, targetPath, splitNode);
}

export function updateSplitRatios(root: SplitNode, path: number[], ratios: number[]): SplitNode {
  const node = getNodeAtPath(root, path);
  if (!node || node.type !== "split") {
    return root;
  }
  const updated: SplitNode = {
    ...node,
    ratios: normalizeRatios(ratios, node.children.length),
  };
  return updateNodeAtPath(root, path, updated);
}

export function removePane(root: SplitNode, sessionId: string): SplitNode | null {
  return removePaneFromNode(root, sessionId);
}

function splitOrientationFor(direction: SplitDirection): SplitOrientation {
  return direction === "l" || direction === "r" ? "v" : "h";
}

function createSplitNode(
  primary: SplitNode,
  secondary: SplitNode,
  orientation: SplitOrientation,
  direction: SplitDirection,
): SplitNode {
  const insertBefore = direction === "l" || direction === "t";
  const children = insertBefore ? [secondary, primary] : [primary, secondary];
  return {
    type: "split",
    orientation,
    children,
    ratios: [0.5, 0.5],
  };
}

function getNodeAtPath(root: SplitNode, path: number[]): SplitNode | null {
  let current: SplitNode = root;
  for (const index of path) {
    if (current.type !== "split") {
      return null;
    }
    current = current.children[index];
    if (!current) {
      return null;
    }
  }
  return current;
}

function updateNodeAtPath(root: SplitNode, path: number[], nextNode: SplitNode): SplitNode {
  if (path.length === 0) {
    return nextNode;
  }
  if (root.type !== "split") {
    return root;
  }
  const [index, ...rest] = path;
  const nextChildren = root.children.map((child, childIndex) =>
    childIndex === index ? updateNodeAtPath(child, rest, nextNode) : child,
  );
  return {
    ...root,
    children: nextChildren,
    ratios: normalizeRatios(root.ratios, nextChildren.length),
  };
}

function normalizeNode(node: SplitNode): SplitNode {
  if (node.type === "pane") {
    return node;
  }
  const children = node.children.map((child) => normalizeNode(child));
  if (children.length === 1) {
    return children[0];
  }
  return {
    ...node,
    children,
    ratios: normalizeRatios(node.ratios, children.length),
  };
}

function normalizeRatios(ratios: number[], count: number) {
  if (count <= 0) {
    return [];
  }
  let next = ratios.slice(0, count);
  if (next.length < count) {
    next = next.concat(Array.from({ length: count - next.length }, () => 1 / count));
  }
  const sum = next.reduce((total, value) => total + value, 0);
  if (!sum) {
    return Array.from({ length: count }, () => 1 / count);
  }
  return next.map((value) => value / sum);
}

function removePaneFromNode(node: SplitNode, sessionId: string): SplitNode | null {
  if (node.type === "pane") {
    return node.sessionId === sessionId ? null : node;
  }

  let changed = false;
  const nextChildren: SplitNode[] = [];
  const nextRatios: number[] = [];

  node.children.forEach((child, index) => {
    const nextChild = removePaneFromNode(child, sessionId);
    if (!nextChild) {
      changed = true;
      return;
    }
    if (nextChild !== child) {
      changed = true;
    }
    nextChildren.push(nextChild);
    nextRatios.push(node.ratios[index] ?? 1 / node.children.length);
  });

  if (!changed) {
    return node;
  }
  if (nextChildren.length === 0) {
    return null;
  }
  if (nextChildren.length === 1) {
    return nextChildren[0];
  }

  return {
    ...node,
    children: nextChildren,
    ratios: normalizeRatios(nextRatios, nextChildren.length),
  };
}
