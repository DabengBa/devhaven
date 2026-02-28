import { useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { Project, TagData } from "../models/types";

type TagDialogState = { mode: "new" | "edit"; tag?: TagData } | null;

type UseAppViewStateParams = {
  appState: {
    recycleBin?: string[];
    favoriteProjectPaths?: string[];
  };
  projects: Project[];
};

export type UseAppViewStateReturn = {
  tagDialogState: TagDialogState;
  setTagDialogState: Dispatch<SetStateAction<TagDialogState>>;
  showDashboard: boolean;
  setShowDashboard: Dispatch<SetStateAction<boolean>>;
  showSettings: boolean;
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  showGlobalSkills: boolean;
  setShowGlobalSkills: Dispatch<SetStateAction<boolean>>;
  showRecycleBin: boolean;
  setShowRecycleBin: Dispatch<SetStateAction<boolean>>;
  recycleBinPaths: string[];
  recycleBinSet: Set<string>;
  recycleBinCount: number;
  favoriteProjectPathSet: Set<string>;
  visibleProjects: Project[];
  recycleBinItems: Array<{ path: string; name: string; missing: boolean }>;
};

/** 管理 App 顶层视图状态与回收站/收藏派生数据。 */
export function useAppViewState({ appState, projects }: UseAppViewStateParams): UseAppViewStateReturn {
  const [tagDialogState, setTagDialogState] = useState<TagDialogState>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showGlobalSkills, setShowGlobalSkills] = useState(false);
  const [showRecycleBin, setShowRecycleBin] = useState(false);

  const recycleBinPaths = appState.recycleBin ?? [];
  const recycleBinSet = useMemo(() => new Set(recycleBinPaths), [recycleBinPaths]);
  const recycleBinCount = recycleBinPaths.length;

  const favoriteProjectPathSet = useMemo(
    () => new Set(appState.favoriteProjectPaths ?? []),
    [appState.favoriteProjectPaths],
  );

  const visibleProjects = useMemo(
    () => projects.filter((project) => !recycleBinSet.has(project.path)),
    [projects, recycleBinSet],
  );

  const recycleBinItems = useMemo(() => {
    const projectsByPath = new Map(projects.map((project) => [project.path, project]));
    return recycleBinPaths.map((path) => {
      const project = projectsByPath.get(path);
      return {
        path,
        name: project?.name ?? path.split("/").pop() ?? path,
        missing: !project,
      };
    });
  }, [projects, recycleBinPaths]);

  return {
    tagDialogState,
    setTagDialogState,
    showDashboard,
    setShowDashboard,
    showSettings,
    setShowSettings,
    showGlobalSkills,
    setShowGlobalSkills,
    showRecycleBin,
    setShowRecycleBin,
    recycleBinPaths,
    recycleBinSet,
    recycleBinCount,
    favoriteProjectPathSet,
    visibleProjects,
    recycleBinItems,
  };
}
