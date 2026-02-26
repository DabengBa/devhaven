import { invoke } from "@tauri-apps/api/core";

import type { SharedScriptEntry, SharedScriptManifestScript } from "../models/types";

/** 列出全局共享脚本（优先读取 manifest，否则回退目录扫描）。 */
export async function listSharedScripts(root?: string): Promise<SharedScriptEntry[]> {
  const normalizedRoot = root?.trim();
  return invoke<SharedScriptEntry[]>("list_shared_scripts", {
    root: normalizedRoot ? normalizedRoot : null,
  });
}

/** 保存共享脚本清单（manifest.json）。 */
export async function saveSharedScriptsManifest(
  scripts: SharedScriptManifestScript[],
  root?: string,
): Promise<void> {
  const normalizedRoot = root?.trim();
  await invoke("save_shared_scripts_manifest", {
    scripts,
    root: normalizedRoot ? normalizedRoot : null,
  });
}

/** 读取共享脚本文件内容。 */
export async function readSharedScriptFile(relativePath: string, root?: string): Promise<string> {
  const normalizedRoot = root?.trim();
  return invoke<string>("read_shared_script_file", {
    relativePath,
    root: normalizedRoot ? normalizedRoot : null,
  });
}

/** 写入共享脚本文件内容。 */
export async function writeSharedScriptFile(
  relativePath: string,
  content: string,
  root?: string,
): Promise<void> {
  const normalizedRoot = root?.trim();
  await invoke("write_shared_script_file", {
    relativePath,
    content,
    root: normalizedRoot ? normalizedRoot : null,
  });
}
