import { useCallback, useEffect, useMemo, useRef } from "react";

import type { CodexAgentEvent, CodexSessionView } from "../models/codex";
import type { Project } from "../models/types";
import type { CodexMonitorStore } from "./useCodexMonitor";
import { sendSystemNotification } from "../services/system";
import { buildCodexProjectStatusById, type CodexProjectStatus } from "../utils/codexProjectStatus";
import {
  buildCodexProjectMatchCandidates,
  buildCodexSessionViews,
  matchProjectByCwd,
  parseWorktreePathFromProjectId,
  resolveWorktreeVirtualProjectByPath,
} from "../utils/worktreeHelpers";

type UseCodexIntegrationParams = {
  projects: Project[];
  projectMap: Map<string, Project>;
  terminalOpenProjects: Project[];
  codexMonitorStore: CodexMonitorStore;
  showToast: (message: string, variant?: "success" | "error") => void;
  openTerminalWorkspace: (project: Project) => void;
};

export type UseCodexIntegrationReturn = {
  codexSessionViews: CodexSessionView[];
  codexProjectStatusById: Record<string, CodexProjectStatus>;
  handleOpenCodexSession: (session: CodexSessionView) => void;
};

/** 管理 Codex 会话与项目映射、通知提示和打开会话行为。 */
export function useCodexIntegration({
  projects,
  projectMap,
  terminalOpenProjects,
  codexMonitorStore,
  showToast,
  openTerminalWorkspace,
}: UseCodexIntegrationParams): UseCodexIntegrationReturn {
  const codexEventSnapshotRef = useRef<Set<string>>(new Set());

  const codexProjectMatchCandidates = useMemo(
    () => buildCodexProjectMatchCandidates(projects, terminalOpenProjects),
    [projects, terminalOpenProjects],
  );

  const codexSessionViews = useMemo(
    () => buildCodexSessionViews(codexMonitorStore.sessions, codexProjectMatchCandidates),
    [codexMonitorStore.sessions, codexProjectMatchCandidates],
  );

  const codexProjectStatusById = useMemo(
    () => buildCodexProjectStatusById(codexSessionViews),
    [codexSessionViews],
  );

  const resolveProjectFromCodexProjectId = useCallback(
    (projectId: string): Project | null => {
      const worktreePath = parseWorktreePathFromProjectId(projectId);
      if (worktreePath) {
        return resolveWorktreeVirtualProjectByPath(projects, worktreePath);
      }
      return projectMap.get(projectId) ?? null;
    },
    [projectMap, projects],
  );

  const resolveProjectFromCodexEvent = useCallback(
    (event: CodexAgentEvent): Project | null => {
      const bySession =
        event.sessionId
          ? codexSessionViews.find((session) => session.id === event.sessionId && session.projectId)
          : null;
      if (bySession?.projectId) {
        const resolved = resolveProjectFromCodexProjectId(bySession.projectId);
        if (resolved) {
          return resolved;
        }
      }

      if (event.workingDirectory) {
        return matchProjectByCwd(event.workingDirectory, codexProjectMatchCandidates);
      }

      return null;
    },
    [codexProjectMatchCandidates, codexSessionViews, resolveProjectFromCodexProjectId],
  );

  const handleOpenCodexSession = useCallback(
    (session: CodexSessionView) => {
      if (!session.projectId) {
        showToast("未能匹配到项目", "error");
        return;
      }
      const project = resolveProjectFromCodexProjectId(session.projectId);
      if (!project) {
        showToast("项目不存在或已移除", "error");
        return;
      }
      openTerminalWorkspace(project);
    },
    [openTerminalWorkspace, resolveProjectFromCodexProjectId, showToast],
  );

  useEffect(() => {
    if (codexMonitorStore.agentEvents.length === 0) {
      return;
    }

    const seen = codexEventSnapshotRef.current;
    const events = [...codexMonitorStore.agentEvents].reverse();
    for (const event of events) {
      const eventKey = [event.type, event.sessionId ?? "", String(event.timestamp), event.details ?? ""].join("|");
      if (seen.has(eventKey)) {
        continue;
      }
      seen.add(eventKey);
      if (seen.size > 300) {
        const first = seen.values().next().value;
        if (first) {
          seen.delete(first);
        }
      }

      const project = resolveProjectFromCodexEvent(event);
      const projectName = project?.name ?? "未匹配项目";

      if (event.type === "task-complete") {
        showToast(`Codex 已完成：${projectName}`);
        void sendSystemNotification("Codex 已完成", projectName);
      } else if (event.type === "task-error") {
        showToast(`Codex 执行失败：${projectName}`, "error");
        void sendSystemNotification("Codex 执行失败", projectName);
      } else if (event.type === "needs-attention") {
        showToast(`Codex 需要你处理：${projectName}`, "error");
        void sendSystemNotification("Codex 需要处理", projectName);
      }
    }
  }, [codexMonitorStore.agentEvents, resolveProjectFromCodexEvent, showToast]);

  return {
    codexSessionViews,
    codexProjectStatusById,
    handleOpenCodexSession,
  };
}
