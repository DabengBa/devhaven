import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type TerminalCreateRequest = {
  projectPath: string;
  cols: number;
  rows: number;
  windowLabel: string;
  sessionId?: string;
};

export type TerminalCreateResult = {
  ptyId: string;
  sessionId: string;
  shell: string;
};

export type TerminalOutputPayload = {
  sessionId: string;
  data: string;
};

export type TerminalExitPayload = {
  sessionId: string;
  code?: number | null;
};

export async function createTerminalSession(request: TerminalCreateRequest): Promise<TerminalCreateResult> {
  return invoke<TerminalCreateResult>("terminal_create_session", request);
}

export async function writeTerminal(ptyId: string, data: string): Promise<void> {
  await invoke("terminal_write", { ptyId, data });
}

export async function resizeTerminal(ptyId: string, cols: number, rows: number): Promise<void> {
  await invoke("terminal_resize", { ptyId, cols, rows });
}

export async function killTerminal(ptyId: string): Promise<void> {
  await invoke("terminal_kill", { ptyId });
}

export async function listenTerminalOutput(
  handler: (event: { payload: TerminalOutputPayload }) => void,
) {
  return listen<TerminalOutputPayload>("terminal-output", handler);
}

export async function listenTerminalExit(
  handler: (event: { payload: TerminalExitPayload }) => void,
) {
  return listen<TerminalExitPayload>("terminal-exit", handler);
}
