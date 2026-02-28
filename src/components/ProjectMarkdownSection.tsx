import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import type { MarkdownFileEntry } from "../models/markdown";
import type { Project } from "../models/types";
import { listProjectMarkdownFiles, readProjectMarkdownFile } from "../services/markdown";
import { openInFinder } from "../services/system";

export type ProjectMarkdownSectionProps = {
  project: Project | null;
};

/** 项目 Markdown 预览区。 */
export default function ProjectMarkdownSection({ project }: ProjectMarkdownSectionProps) {
  const [markdownFiles, setMarkdownFiles] = useState<MarkdownFileEntry[]>([]);
  const [markdownLoading, setMarkdownLoading] = useState(false);
  const [markdownError, setMarkdownError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [activeMarkdownPath, setActiveMarkdownPath] = useState<string | null>(null);
  const [markdownContent, setMarkdownContent] = useState("");
  const [markdownContentLoading, setMarkdownContentLoading] = useState(false);
  const [markdownContentError, setMarkdownContentError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) {
      setMarkdownFiles([]);
      setMarkdownError(null);
      setMarkdownLoading(false);
      setExpandedFolders(new Set());
      setActiveMarkdownPath(null);
      setMarkdownContent("");
      setMarkdownContentError(null);
      setMarkdownContentLoading(false);
      return;
    }
    let cancelled = false;
    setMarkdownLoading(true);
    setMarkdownError(null);
    listProjectMarkdownFiles(project.path)
      .then((files) => {
        if (cancelled) {
          return;
        }
        setMarkdownFiles(files);
        setMarkdownLoading(false);
        setExpandedFolders(buildRootFolderSet(files));
        const nextActive = resolveDefaultMarkdownPath(files, null);
        setActiveMarkdownPath(nextActive);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setMarkdownFiles([]);
        setMarkdownLoading(false);
        setMarkdownError(error instanceof Error ? error.message : String(error));
        setExpandedFolders(new Set());
        setActiveMarkdownPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id, project?.path]);

  useEffect(() => {
    if (!project) {
      return;
    }
    if (markdownFiles.length === 0) {
      setActiveMarkdownPath(null);
      return;
    }
    setActiveMarkdownPath((prev) => resolveDefaultMarkdownPath(markdownFiles, prev));
  }, [markdownFiles, project?.id]);

  useEffect(() => {
    if (!project || !activeMarkdownPath) {
      setMarkdownContent("");
      setMarkdownContentError(null);
      setMarkdownContentLoading(false);
      return;
    }
    let cancelled = false;
    setMarkdownContentLoading(true);
    setMarkdownContentError(null);
    readProjectMarkdownFile(project.path, activeMarkdownPath)
      .then((content) => {
        if (cancelled) {
          return;
        }
        setMarkdownContent(content);
        setMarkdownContentLoading(false);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setMarkdownContent("");
        setMarkdownContentLoading(false);
        setMarkdownContentError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [activeMarkdownPath, project?.path]);

  const markdownTree = useMemo(() => buildMarkdownTree(markdownFiles), [markdownFiles]);
  const renderedMarkdown = useMemo(() => {
    if (!markdownContent) {
      return "";
    }
    const result = marked.parse(markdownContent);
    return typeof result === "string" ? DOMPurify.sanitize(result) : "";
  }, [markdownContent]);

  const toggleMarkdownFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const renderMarkdownNodes = (nodes: MarkdownTreeNode[], depth = 0) =>
    nodes.map((node) => {
      if (node.type === "folder") {
        const isExpanded = expandedFolders.has(node.path);
        return (
          <div key={node.path} className="flex flex-col">
            <button
              className="tag-row-base tag-row-hover justify-start gap-1.5 text-sidebar-title font-semibold"
              style={{ paddingLeft: `${depth * 12 + 12}px` }}
              type="button"
              onClick={() => toggleMarkdownFolder(node.path)}
              title={node.path}
            >
              <span className="w-3 text-center text-[10px] text-sidebar-secondary">{isExpanded ? "▾" : "▸"}</span>
              <span className="min-w-0 truncate">{node.name}</span>
            </button>
            {isExpanded && node.children && node.children.length > 0 ? (
              <div className="flex flex-col">{renderMarkdownNodes(node.children, depth + 1)}</div>
            ) : null}
          </div>
        );
      }

      const label = formatMarkdownLabel(node.name);
      const isActive = activeMarkdownPath === node.path;
      return (
        <button
          key={node.path}
          className={`tag-row-base tag-row-hover justify-start gap-1.5 text-sidebar-secondary ${
            isActive ? "tag-row-selected" : ""
          }`}
          style={{ paddingLeft: `${depth * 12 + 28}px` }}
          type="button"
          onClick={() => setActiveMarkdownPath(node.path)}
          onDoubleClick={() => {
            if (node.absolutePath) {
              void openInFinder(node.absolutePath);
            }
          }}
          title={node.path}
        >
          <span className="min-w-0 truncate">{label}</span>
        </button>
      );
    });

  if (!project) {
    return <div className="text-fs-caption text-secondary-text">请选择项目查看 Markdown</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-[160px] overflow-y-auto rounded-lg border border-border bg-secondary-background py-1">
        {markdownError ? (
          <div className="px-3 py-2 text-fs-caption text-secondary-text">{`读取失败：${markdownError}`}</div>
        ) : markdownLoading ? (
          <div className="px-3 py-2 text-fs-caption text-secondary-text">正在扫描 Markdown...</div>
        ) : markdownTree.length === 0 ? (
          <div className="px-3 py-2 text-fs-caption text-secondary-text">未发现 Markdown 文件</div>
        ) : (
          <div className="flex flex-col gap-0.5 pb-1">{renderMarkdownNodes(markdownTree)}</div>
        )}
      </div>
      <div className="max-h-[240px] min-h-[140px] overflow-y-auto rounded-lg border border-border bg-secondary-background px-3 py-2.5 text-fs-caption leading-relaxed text-text">
        {markdownContentError ? (
          <div className="text-fs-caption text-secondary-text">{`预览失败：${markdownContentError}`}</div>
        ) : markdownContentLoading ? (
          <div className="text-fs-caption text-secondary-text">正在加载内容...</div>
        ) : activeMarkdownPath && !markdownContent ? (
          <div className="text-fs-caption text-secondary-text">Markdown 内容为空</div>
        ) : renderedMarkdown ? (
          <div
            className="markdown-content"
            dangerouslySetInnerHTML={{
              __html: renderedMarkdown,
            }}
          />
        ) : (
          <div className="text-fs-caption text-secondary-text">请选择 Markdown 文件进行预览</div>
        )}
      </div>
    </div>
  );
}

type MarkdownTreeNode = {
  type: "folder" | "file";
  name: string;
  path: string;
  absolutePath?: string;
  children?: MarkdownTreeNode[];
};

function buildRootFolderSet(files: MarkdownFileEntry[]) {
  const roots = new Set<string>();
  files.forEach((file) => {
    const segments = file.path.split("/").filter(Boolean);
    if (segments.length > 1) {
      roots.add(segments[0]);
    }
  });
  return roots;
}

function formatMarkdownLabel(name: string) {
  return name.replace(/\.md$/i, "").replace(/_/g, " ");
}

function buildMarkdownTree(files: MarkdownFileEntry[]): MarkdownTreeNode[] {
  const root: MarkdownTreeNode = { type: "folder", name: "", path: "", children: [] };
  files.forEach((file) => {
    const segments = file.path.split("/").filter(Boolean);
    if (segments.length === 0) {
      return;
    }
    let current = root;
    let currentPath = "";
    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      if (isLeaf) {
        current.children?.push({
          type: "file",
          name: segment,
          path: file.path,
          absolutePath: file.absolutePath,
        });
        return;
      }
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let next = current.children?.find(
        (node) => node.type === "folder" && node.path === currentPath,
      );
      if (!next) {
        next = {
          type: "folder",
          name: segment,
          path: currentPath,
          children: [],
        };
        current.children?.push(next);
      }
      current = next;
    });
  });
  const children = root.children ?? [];
  sortMarkdownTree(children);
  return children;
}

function sortMarkdownTree(nodes: MarkdownTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    const aIsIndex = a.type === "file" && isIndexMarkdown(a.path);
    const bIsIndex = b.type === "file" && isIndexMarkdown(b.path);
    if (aIsIndex !== bIsIndex) {
      return aIsIndex ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  nodes.forEach((node) => {
    if (node.children) {
      sortMarkdownTree(node.children);
    }
  });
}

function isIndexMarkdown(path: string) {
  return path === "index.md" || path.endsWith("/index.md");
}

function resolveDefaultMarkdownPath(files: MarkdownFileEntry[], current: string | null) {
  if (current && files.some((file) => file.path === current)) {
    return current;
  }
  const indexFile = files.find((file) => isIndexMarkdown(file.path));
  if (indexFile) {
    return indexFile.path;
  }
  return files[0]?.path ?? null;
}
