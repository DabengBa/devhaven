import { useCallback, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { DateFilter, GitFilter } from "../models/filters";
import { DATE_FILTER_OPTIONS } from "../models/filters";
import type { HeatmapData } from "../models/heatmap";
import type { TagData, Project } from "../models/types";
import { swiftDateToJsDate } from "../models/types";
import { formatDateKey, parseGitDaily } from "../utils/gitDaily";

type UseProjectFilterParams = {
  visibleProjects: Project[];
  favoriteProjectPathSet: Set<string>;
  appTags: TagData[];
  onLocateProject: (projectId: string) => void;
};

export type UseProjectFilterReturn = {
  searchText: string;
  setSearchText: Dispatch<SetStateAction<string>>;
  dateFilter: DateFilter;
  setDateFilter: Dispatch<SetStateAction<DateFilter>>;
  gitFilter: GitFilter;
  setGitFilter: Dispatch<SetStateAction<GitFilter>>;
  selectedTags: Set<string>;
  setSelectedTags: Dispatch<SetStateAction<Set<string>>>;
  selectedDirectory: string | null;
  setSelectedDirectory: Dispatch<SetStateAction<string | null>>;
  heatmapFilteredProjectIds: Set<string>;
  setHeatmapFilteredProjectIds: Dispatch<SetStateAction<Set<string>>>;
  heatmapSelectedDateKey: string | null;
  setHeatmapSelectedDateKey: Dispatch<SetStateAction<string | null>>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  hiddenTags: Set<string>;
  filteredProjects: Project[];
  heatmapActiveProjects: Array<{
    projectId: string;
    projectName: string;
    projectPath: string;
    commitCount: number;
  }>;
  handleSelectTag: (tag: string) => void;
  handleSelectDirectory: (directory: string | null) => void;
  handleSelectHeatmapDate: (entry: HeatmapData | null) => void;
  handleLocateHeatmapProject: (projectId: string) => void;
};

/** 管理搜索、标签、目录、时间与热力图筛选逻辑。 */
export function useProjectFilter({
  visibleProjects,
  favoriteProjectPathSet,
  appTags,
  onLocateProject,
}: UseProjectFilterParams): UseProjectFilterReturn {
  const [searchText, setSearchText] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [gitFilter, setGitFilter] = useState<GitFilter>("all");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);
  const [heatmapFilteredProjectIds, setHeatmapFilteredProjectIds] = useState<Set<string>>(new Set());
  const [heatmapSelectedDateKey, setHeatmapSelectedDateKey] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const hiddenTags = useMemo(
    () => new Set(appTags.filter((tag) => tag.hidden).map((tag) => tag.name)),
    [appTags],
  );

  const filteredProjects = useMemo(() => {
    let result = [...visibleProjects];

    if (selectedDirectory) {
      result = result.filter((project) => project.path.startsWith(selectedDirectory));
    }

    result = result.filter((project) => {
      const projectHiddenTags = project.tags.filter((tag) => hiddenTags.has(tag));
      if (projectHiddenTags.length === 0) {
        return true;
      }
      if (selectedTags.size > 0 && !selectedTags.has("全部")) {
        return Array.from(selectedTags).some((tag) => projectHiddenTags.includes(tag));
      }
      return false;
    });

    if (heatmapFilteredProjectIds.size > 0) {
      result = result.filter((project) => heatmapFilteredProjectIds.has(project.id));
    } else if (selectedTags.size > 0 && !selectedTags.has("全部")) {
      const selectedTagList = Array.from(selectedTags);
      result = result.filter((project) => selectedTagList.every((tag) => project.tags.includes(tag)));
    }

    const trimmedSearch = searchText.trim().toLowerCase();
    if (trimmedSearch) {
      result = result.filter(
        (project) =>
          project.name.toLowerCase().includes(trimmedSearch) || project.path.toLowerCase().includes(trimmedSearch),
      );
    }

    const dateOption = DATE_FILTER_OPTIONS.find((option) => option.value === dateFilter);
    if (dateOption?.days) {
      const cutoff = Date.now() - dateOption.days * 24 * 60 * 60 * 1000;
      result = result.filter((project) => swiftDateToJsDate(project.mtime).getTime() >= cutoff);
    }

    if (gitFilter === "gitOnly") {
      result = result.filter((project) => (project.git_commits ?? 0) > 0);
    } else if (gitFilter === "nonGitOnly") {
      result = result.filter((project) => (project.git_commits ?? 0) === 0);
    }

    result.sort((left, right) => {
      const leftFavorite = favoriteProjectPathSet.has(left.path);
      const rightFavorite = favoriteProjectPathSet.has(right.path);
      if (leftFavorite !== rightFavorite) {
        return leftFavorite ? -1 : 1;
      }
      return right.mtime - left.mtime;
    });

    return result;
  }, [
    dateFilter,
    favoriteProjectPathSet,
    gitFilter,
    heatmapFilteredProjectIds,
    hiddenTags,
    searchText,
    selectedDirectory,
    selectedTags,
    visibleProjects,
  ]);

  const heatmapActiveProjects = useMemo(() => {
    if (!heatmapSelectedDateKey) {
      return [];
    }
    return visibleProjects
      .map((project) => ({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        commitCount: parseGitDaily(project.git_daily)[heatmapSelectedDateKey] ?? 0,
      }))
      .filter((item) => item.commitCount > 0)
      .sort((left, right) => {
        if (left.commitCount !== right.commitCount) {
          return right.commitCount - left.commitCount;
        }
        return left.projectName.localeCompare(right.projectName);
      });
  }, [heatmapSelectedDateKey, visibleProjects]);

  const handleSelectTag = useCallback((tag: string) => {
    if (tag === "全部") {
      setSelectedTags(new Set());
      return;
    }
    setSelectedTags(new Set([tag]));
  }, []);

  const handleSelectDirectory = useCallback((directory: string | null) => {
    setSelectedDirectory(directory);
  }, []);

  const handleSelectHeatmapDate = useCallback((entry: HeatmapData | null) => {
    if (!entry) {
      setHeatmapFilteredProjectIds(new Set());
      setHeatmapSelectedDateKey(null);
      return;
    }
    setHeatmapFilteredProjectIds(new Set(entry.projectIds));
    setHeatmapSelectedDateKey(formatDateKey(entry.date));
  }, []);

  const handleLocateHeatmapProject = useCallback(
    (projectId: string) => {
      onLocateProject(projectId);
    },
    [onLocateProject],
  );

  return {
    searchText,
    setSearchText,
    dateFilter,
    setDateFilter,
    gitFilter,
    setGitFilter,
    selectedTags,
    setSelectedTags,
    selectedDirectory,
    setSelectedDirectory,
    heatmapFilteredProjectIds,
    setHeatmapFilteredProjectIds,
    heatmapSelectedDateKey,
    setHeatmapSelectedDateKey,
    searchInputRef,
    hiddenTags,
    filteredProjects,
    heatmapActiveProjects,
    handleSelectTag,
    handleSelectDirectory,
    handleSelectHeatmapDate,
    handleLocateHeatmapProject,
  };
}
