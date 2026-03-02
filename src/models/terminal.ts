export type SplitOrientation = "h" | "v";
export type SplitDirection = "r" | "b" | "l" | "t";

export type SplitNode =
  | {
      type: "pane";
      sessionId: string;
    }
  | {
      type: "split";
      orientation: SplitOrientation;
      ratios: number[];
      children: SplitNode[];
    };

export type TerminalTab = {
  id: string;
  title: string;
  root: SplitNode;
  activeSessionId: string;
};

export type TerminalSessionSnapshot = {
  id: string;
  cwd: string;
  savedState?: string | null;
};

export type QuickCommandsPanelState = {
  open: boolean;
  x: number | null;
  y: number | null;
};

export type RunConfigurationState = {
  selectedScriptId: string | null;
};

export type FileExplorerPanelState = {
  open: boolean;
  showHidden: boolean;
};

export type GitPanelState = {
  open: boolean;
};

export type TerminalRightSidebarTab = "files" | "git";

export type RightSidebarState = {
  open: boolean;
  width: number;
  tab: TerminalRightSidebarTab;
};

export type TerminalWorkspaceUi = {
  quickCommandsPanel?: QuickCommandsPanelState;
  runConfiguration?: RunConfigurationState;
  fileExplorerPanel?: FileExplorerPanelState;
  gitPanel?: GitPanelState;
  rightSidebar?: RightSidebarState;
};

export type TerminalWorkspace = {
  version: number;
  projectId: string | null;
  projectPath: string;
  tabs: TerminalTab[];
  activeTabId: string;
  sessions: Record<string, TerminalSessionSnapshot>;
  ui?: TerminalWorkspaceUi;
  updatedAt: number;
};

export type TerminalWorkspaceSummary = {
  projectPath: string;
  projectId: string | null;
  updatedAt: number | null;
};
