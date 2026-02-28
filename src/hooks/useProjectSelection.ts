import { useCallback, useMemo, useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";

import type { Project } from "../models/types";

type UseProjectSelectionParams = {
  projectMap: Map<string, Project>;
  recycleBinSet: Set<string>;
};

export type UseProjectSelectionReturn = {
  selectedProjects: Set<string>;
  setSelectedProjects: Dispatch<SetStateAction<Set<string>>>;
  selectedProjectId: string | null;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  showDetailPanel: boolean;
  setShowDetailPanel: Dispatch<SetStateAction<boolean>>;
  resolvedSelectedProject: Project | null;
  handleSelectProject: (project: { id: string }, event: MouseEvent<HTMLDivElement>) => void;
  handleToggleDetail: () => void;
  handleClearSelectedProjects: () => void;
  locateProject: (projectId: string) => void;
};

/** 管理项目选中、多选与详情面板联动状态。 */
export function useProjectSelection({
  projectMap,
  recycleBinSet,
}: UseProjectSelectionParams): UseProjectSelectionReturn {
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showDetailPanel, setShowDetailPanel] = useState(false);

  const selectedProject = selectedProjectId ? projectMap.get(selectedProjectId) ?? null : null;
  const resolvedSelectedProject = useMemo(
    () => (selectedProject && recycleBinSet.has(selectedProject.path) ? null : selectedProject),
    [recycleBinSet, selectedProject],
  );

  const handleSelectProject = useCallback((project: { id: string }, event: MouseEvent<HTMLDivElement>) => {
    const isMulti = event.shiftKey || event.metaKey || event.ctrlKey;
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (isMulti) {
        if (next.has(project.id)) {
          next.delete(project.id);
        } else {
          next.add(project.id);
        }
      } else {
        next.clear();
        next.add(project.id);
      }
      return next;
    });
    setSelectedProjectId(project.id);
  }, []);

  const handleToggleDetail = useCallback(() => {
    setShowDetailPanel((prev) => {
      const next = !prev;
      if (next && !selectedProjectId && selectedProjects.size > 0) {
        setSelectedProjectId(Array.from(selectedProjects)[0]);
      }
      return next;
    });
  }, [selectedProjectId, selectedProjects]);

  const handleClearSelectedProjects = useCallback(() => {
    setSelectedProjects(new Set());
    setSelectedProjectId(null);
  }, []);

  const locateProject = useCallback((projectId: string) => {
    setSelectedProjects(new Set([projectId]));
    setSelectedProjectId(projectId);
    setShowDetailPanel(true);
  }, []);

  return {
    selectedProjects,
    setSelectedProjects,
    selectedProjectId,
    setSelectedProjectId,
    showDetailPanel,
    setShowDetailPanel,
    resolvedSelectedProject,
    handleSelectProject,
    handleToggleDetail,
    handleClearSelectedProjects,
    locateProject,
  };
}
