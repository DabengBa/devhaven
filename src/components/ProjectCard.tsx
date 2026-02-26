import { memo } from "react";

import type { Project } from "../models/types";
import { swiftDateToJsDate } from "../models/types";
import { openInFinder } from "../services/system";
import { formatPathWithTilde } from "../utils/pathDisplay";
import DropdownMenu from "./DropdownMenu";
import { IconCalendar, IconCode, IconCopy, IconFolder, IconRefresh, IconStar, IconTrash, IconX } from "./Icons";

export type ProjectCardProps = {
  project: Project;
  isSelected: boolean;
  isFavorite: boolean;
  selectedProjectIds: Set<string>;
  onSelect: (event: React.MouseEvent<HTMLDivElement>) => void;
  onOpenTerminal: (project: Project) => void;
  onRunProjectScript: (projectId: string, scriptId: string) => Promise<void>;
  onTagClick: (tag: string) => void;
  onRemoveTag: (projectId: string, tag: string) => void;
  getTagColor: (tag: string) => string;
  onRefreshProject: (path: string) => void;
  onCopyPath: (path: string) => void;
  onMoveToRecycleBin: (project: Project) => void;
  onToggleFavorite: (path: string) => void;
};

/** 格式化 Swift 时间戳为中文日期。 */
const formatDate = (swiftDate: number) => {
  if (!swiftDate) {
    return "--";
  }
  const date = swiftDateToJsDate(swiftDate);
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
};

/** 项目卡片，展示基础信息与快捷操作。 */
function ProjectCard({
  project,
  isSelected,
  isFavorite,
  selectedProjectIds,
  onSelect,
  onOpenTerminal,
  onRunProjectScript,
  onTagClick,
  onRemoveTag,
  getTagColor,
  onRefreshProject,
  onCopyPath,
  onMoveToRecycleBin,
  onToggleFavorite,
}: ProjectCardProps) {
  const displayPath = formatPathWithTilde(project.path);
  const scripts = project.scripts ?? [];
  const scriptMenuItems = scripts.length
    ? scripts.map((script) => ({
        key: script.id,
        label: `运行：${script.name}`,
        onClick: () => {
          void onRunProjectScript(project.id, script.id);
        },
      }))
    : [{ key: "empty", label: "暂无快捷命令", disabled: true }];

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    const ids = selectedProjectIds.has(project.id)
      ? Array.from(selectedProjectIds)
      : [project.id];
    event.dataTransfer.setData("application/x-project-ids", JSON.stringify(ids));
    event.dataTransfer.effectAllowed = "copy";
  };

  const handleActionClick = (event: React.MouseEvent, action: () => void) => {
    event.stopPropagation();
    action();
  };

  return (
    <div
      className={`card ${isSelected ? "card-selected" : "hover:bg-card-hover"}`}
      onClick={onSelect}
      onDoubleClick={() => onOpenTerminal(project)}
      draggable
      onDragStart={handleDragStart}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-fs-title font-semibold text-text" title={project.name}>
          {project.name}
        </div>
        <div className="ml-auto inline-flex items-center gap-1.5">
          <DropdownMenu label={<IconCode size={16} />} ariaLabel="运行快捷命令" items={scriptMenuItems} />
          <button
            className={`icon-btn ${isFavorite ? "text-amber-500" : "text-titlebar-icon"}`}
            aria-label={isFavorite ? "取消收藏" : "收藏项目"}
            title={isFavorite ? "取消收藏" : "收藏项目"}
            onClick={(event) => handleActionClick(event, () => void onToggleFavorite(project.path))}
          >
            <IconStar size={16} fill={isFavorite ? "currentColor" : "none"} />
          </button>
          <button
            className="icon-btn text-titlebar-icon"
            aria-label="在 Finder 中显示"
            title="在 Finder 中显示"
            onClick={(event) => handleActionClick(event, () => void openInFinder(project.path))}
          >
            <IconFolder size={16} />
          </button>
          <button
            className="icon-btn text-titlebar-icon"
            aria-label="复制路径"
            title="复制路径"
            onClick={(event) => handleActionClick(event, () => void onCopyPath(project.path))}
          >
            <IconCopy size={16} />
          </button>
          <button
            className="icon-btn text-titlebar-icon"
            aria-label="刷新项目"
            title="刷新项目"
            onClick={(event) => handleActionClick(event, () => void onRefreshProject(project.path))}
          >
            <IconRefresh size={16} />
          </button>
          <button
            className="icon-btn text-titlebar-icon"
            aria-label="移入回收站"
            title="移入回收站"
            onClick={(event) => handleActionClick(event, () => void onMoveToRecycleBin(project))}
          >
            <IconTrash size={16} />
          </button>
        </div>
      </div>
      <div className="truncate text-fs-caption text-secondary-text" title={project.path}>
        {displayPath}
      </div>
      <div className="flex items-center justify-between text-fs-caption text-secondary-text">
        <span className="inline-flex items-center gap-1">
          <IconCalendar size={14} />
          {formatDate(project.mtime)}
        </span>
        {project.git_commits > 0 ? (
          <span className="rounded-md bg-[rgba(69,59,231,0.15)] px-2 py-1 text-[12px] text-accent">
            {project.git_commits} 次提交
          </span>
        ) : (
          <span>非 Git 项目</span>
        )}
      </div>
      <div className="project-card-tags flex flex-nowrap gap-1.5 overflow-x-auto pb-0.5">
        {project.tags.map((tag) => (
          <span
            key={tag}
            className="tag-pill"
            style={{ background: `${getTagColor(tag)}33`, color: getTagColor(tag) }}
          >
            <span onClick={(event) => {
              event.stopPropagation();
              onTagClick(tag);
            }}>
              {tag}
            </span>
            <button
              className="ml-1.5 inline-flex items-center justify-center text-[12px] opacity-60 hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onRemoveTag(project.id, tag);
              }}
              aria-label={`移除标签 ${tag}`}
            >
              <IconX size={12} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

export default memo(ProjectCard);
