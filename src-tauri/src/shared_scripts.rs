use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::models::{
    ScriptParamField, ScriptParamFieldType, SharedScriptEntry, SharedScriptManifestScript,
    SharedScriptPresetRestoreResult,
};

const DEFAULT_SHARED_SCRIPTS_ROOT: &str = "~/.devhaven/scripts";
const MANIFEST_FILE_NAME: &str = "manifest.json";
const DEFAULT_COMMAND_TEMPLATE: &str = "bash \"${scriptPath}\"";
const BUILTIN_PRESET_VERSION: &str = "2026.02.2";

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SharedScriptsManifest {
    #[serde(default)]
    preset_version: Option<String>,
    #[serde(default)]
    scripts: Vec<SharedScriptsManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedScriptsManifestEntry {
    id: String,
    #[serde(default)]
    name: String,
    path: String,
    #[serde(default)]
    command_template: Option<String>,
    #[serde(default)]
    params: Vec<ScriptParamField>,
}

#[derive(Debug, Clone)]
struct SharedScriptPreset {
    manifest_entry: SharedScriptsManifestEntry,
    file_content: &'static str,
}

pub fn list_shared_scripts(
    app: &AppHandle,
    root_override: Option<&str>,
) -> Result<Vec<SharedScriptEntry>, String> {
    let root = resolve_shared_scripts_root(app, root_override)?;
    ensure_builtin_presets_on_first_run(&root)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !root.is_dir() {
        return Err(format!("通用脚本目录不是文件夹: {}", root.display()));
    }

    let manifest_path = root.join(MANIFEST_FILE_NAME);
    let mut entries = if manifest_path.exists() {
        list_manifest_scripts(&root, &manifest_path)?
    } else {
        scan_scripts_from_directory(&root)?
    };

    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    Ok(entries)
}

pub fn save_shared_scripts_manifest(
    app: &AppHandle,
    root_override: Option<&str>,
    scripts: &[SharedScriptManifestScript],
) -> Result<(), String> {
    let root = resolve_shared_scripts_root(app, root_override)?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("创建通用脚本目录失败（{}）：{}", root.display(), error))?;

    let mut manifest_entries = Vec::new();
    let mut used_ids = HashSet::new();

    for (index, script) in scripts.iter().enumerate() {
        let id = script.id.trim();
        if id.is_empty() {
            return Err(format!("第 {} 个脚本缺少 id", index + 1));
        }
        if !used_ids.insert(id.to_string()) {
            return Err(format!("脚本 id 重复: {}", id));
        }

        let relative_path = normalize_relative_path(&script.path)
            .ok_or_else(|| format!("脚本路径不合法（id={}）：{}", script.id, script.path))?;
        let name = if script.name.trim().is_empty() {
            derive_script_name(&relative_path)
        } else {
            script.name.trim().to_string()
        };
        let command_template = script.command_template.trim();

        manifest_entries.push(SharedScriptsManifestEntry {
            id: id.to_string(),
            name,
            path: relative_path,
            command_template: Some(if command_template.is_empty() {
                DEFAULT_COMMAND_TEMPLATE.to_string()
            } else {
                command_template.to_string()
            }),
            params: normalize_param_fields(script.params.clone()),
        });
    }

    let manifest_path = root.join(MANIFEST_FILE_NAME);
    let existing_preset_version = read_manifest_preset_version(&manifest_path)?;
    write_manifest(&root, manifest_entries, existing_preset_version)
}

pub fn restore_shared_script_presets(
    app: &AppHandle,
    root_override: Option<&str>,
) -> Result<SharedScriptPresetRestoreResult, String> {
    let root = resolve_shared_scripts_root(app, root_override)?;
    apply_builtin_presets(&root)
}

pub fn read_shared_script_file(
    app: &AppHandle,
    root_override: Option<&str>,
    relative_path: &str,
) -> Result<String, String> {
    let target_path = resolve_shared_script_path(app, root_override, relative_path)?;
    fs::read_to_string(&target_path)
        .map_err(|error| format!("读取脚本文件失败（{}）：{}", target_path.display(), error))
}

pub fn write_shared_script_file(
    app: &AppHandle,
    root_override: Option<&str>,
    relative_path: &str,
    content: &str,
) -> Result<(), String> {
    let target_path = resolve_shared_script_path(app, root_override, relative_path)?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建脚本目录失败（{}）：{}", parent.display(), error))?;
    }
    fs::write(&target_path, content)
        .map_err(|error| format!("写入脚本文件失败（{}）：{}", target_path.display(), error))
}

fn list_manifest_scripts(
    root: &Path,
    manifest_path: &Path,
) -> Result<Vec<SharedScriptEntry>, String> {
    let manifest = read_manifest(manifest_path)?;

    let mut entries = Vec::new();
    let mut used_ids = HashSet::new();

    for (index, item) in manifest.scripts.into_iter().enumerate() {
        let id = item.id.trim();
        if id.is_empty() {
            return Err(format!("通用脚本清单第 {} 项缺少 id", index + 1));
        }
        if !used_ids.insert(id.to_string()) {
            return Err(format!("通用脚本清单存在重复 id: {}", id));
        }

        let relative_path = normalize_relative_path(&item.path)
            .ok_or_else(|| format!("通用脚本路径不合法（id={}）: {}", id, item.path))?;
        let absolute_path = root.join(&relative_path);

        let command_template = item
            .command_template
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_COMMAND_TEMPLATE)
            .to_string();

        let name = if item.name.trim().is_empty() {
            derive_script_name(&relative_path)
        } else {
            item.name.trim().to_string()
        };

        entries.push(SharedScriptEntry {
            id: id.to_string(),
            name,
            absolute_path: absolute_path.to_string_lossy().to_string(),
            relative_path,
            command_template,
            params: normalize_param_fields(item.params),
        });
    }

    Ok(entries)
}

fn scan_scripts_from_directory(root: &Path) -> Result<Vec<SharedScriptEntry>, String> {
    let mut entries = Vec::new();
    let mut used_ids = HashSet::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(current) = stack.pop() {
        let iterator = fs::read_dir(&current)
            .map_err(|error| format!("读取通用脚本目录失败（{}）：{}", current.display(), error))?;

        for item in iterator {
            let entry = match item {
                Ok(value) => value,
                Err(error) => {
                    log::warn!("读取通用脚本目录项失败：{}", error);
                    continue;
                }
            };
            let file_type = match entry.file_type() {
                Ok(value) => value,
                Err(error) => {
                    log::warn!("读取通用脚本类型失败：{}", error);
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();

            if file_type.is_dir() {
                if name.starts_with('.') {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !file_type.is_file() || !is_script_candidate(&path) {
                continue;
            }

            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative_path = relative.to_string_lossy().replace('\\', "/");
            let id_base = create_scanned_id(&relative_path);
            let id = ensure_unique_id(&mut used_ids, &id_base);

            entries.push(SharedScriptEntry {
                id,
                name: derive_script_name(&relative_path),
                absolute_path: path.to_string_lossy().to_string(),
                relative_path,
                command_template: DEFAULT_COMMAND_TEMPLATE.to_string(),
                params: Vec::new(),
            });
        }
    }

    Ok(entries)
}

fn ensure_builtin_presets_on_first_run(root: &Path) -> Result<(), String> {
    if !root.exists() {
        apply_builtin_presets(root)?;
        return Ok(());
    }
    if !root.is_dir() {
        return Err(format!("通用脚本目录不是文件夹: {}", root.display()));
    }

    let manifest_path = root.join(MANIFEST_FILE_NAME);
    if manifest_path.exists() {
        return Ok(());
    }

    if scan_scripts_from_directory(root)?.is_empty() {
        apply_builtin_presets(root)?;
    }

    Ok(())
}

fn apply_builtin_presets(root: &Path) -> Result<SharedScriptPresetRestoreResult, String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("创建通用脚本目录失败（{}）：{}", root.display(), error))?;

    let manifest_path = root.join(MANIFEST_FILE_NAME);
    let mut manifest_scripts = if manifest_path.exists() {
        list_manifest_scripts(root, &manifest_path)?
            .into_iter()
            .map(manifest_script_from_entry)
            .collect::<Vec<_>>()
    } else {
        scan_scripts_from_directory(root)?
            .into_iter()
            .map(manifest_script_from_entry)
            .collect::<Vec<_>>()
    };

    let mut used_ids = manifest_scripts
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    let mut used_paths = manifest_scripts
        .iter()
        .filter_map(|item| normalize_relative_path(&item.path))
        .collect::<HashSet<_>>();

    let mut added_scripts = 0usize;
    let mut skipped_scripts = 0usize;
    let mut created_files = 0usize;

    for preset in builtin_shared_script_presets() {
        let preset_path = normalize_relative_path(&preset.manifest_entry.path)
            .unwrap_or_else(|| preset.manifest_entry.path.clone());
        if used_ids.contains(&preset.manifest_entry.id) || used_paths.contains(&preset_path) {
            skipped_scripts += 1;
        } else {
            used_ids.insert(preset.manifest_entry.id.clone());
            used_paths.insert(preset_path.clone());
            manifest_scripts.push(SharedScriptManifestScript {
                id: preset.manifest_entry.id.clone(),
                name: preset.manifest_entry.name.clone(),
                path: preset_path,
                command_template: preset
                    .manifest_entry
                    .command_template
                    .clone()
                    .unwrap_or_else(|| DEFAULT_COMMAND_TEMPLATE.to_string()),
                params: preset.manifest_entry.params.clone(),
            });
            added_scripts += 1;
        }

        let target_path = root.join(&preset.manifest_entry.path);
        if write_file_if_absent(&target_path, preset.file_content)? {
            created_files += 1;
        }
    }

    let current_preset_version = read_manifest_preset_version(&manifest_path)?;
    if added_scripts > 0
        || !manifest_path.exists()
        || current_preset_version.as_deref() != Some(BUILTIN_PRESET_VERSION)
    {
        write_manifest_from_scripts(root, &manifest_scripts, Some(BUILTIN_PRESET_VERSION))?;
    }

    Ok(SharedScriptPresetRestoreResult {
        preset_version: BUILTIN_PRESET_VERSION.to_string(),
        added_scripts,
        skipped_scripts,
        created_files,
    })
}

fn builtin_shared_script_presets() -> Vec<SharedScriptPreset> {
    vec![SharedScriptPreset {
        manifest_entry: SharedScriptsManifestEntry {
            id: "jenkins".to_string(),
            name: "Jenkins 部署".to_string(),
            path: "jenkins-depoly".to_string(),
            command_template: Some(
                r#"export JENKINS_PASSWORD="${password}"
python3 "${scriptPath}" --jenkins-url "${host}" --username "${username}" --job "${job}""#
                    .to_string(),
            ),
            params: vec![
                ScriptParamField {
                    key: "host".to_string(),
                    label: "Jenkins 地址".to_string(),
                    r#type: ScriptParamFieldType::Text,
                    required: true,
                    default_value: None,
                    description: Some("例如：https://jenkins.example.com".to_string()),
                },
                ScriptParamField {
                    key: "username".to_string(),
                    label: "用户名".to_string(),
                    r#type: ScriptParamFieldType::Text,
                    required: true,
                    default_value: None,
                    description: None,
                },
                ScriptParamField {
                    key: "password".to_string(),
                    label: "密码".to_string(),
                    r#type: ScriptParamFieldType::Secret,
                    required: true,
                    default_value: None,
                    description: None,
                },
                ScriptParamField {
                    key: "job".to_string(),
                    label: "任务".to_string(),
                    r#type: ScriptParamFieldType::Text,
                    required: true,
                    default_value: None,
                    description: Some("Jenkins job 名称".to_string()),
                },
            ],
        },
        file_content: r#"#!/usr/bin/env python3
"""Jenkins 部署脚本占位模板。"""

import argparse
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Jenkins 部署占位脚本")
    parser.add_argument("--jenkins-url", required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--job", required=True)
    args = parser.parse_args()

    password = os.environ.get("JENKINS_PASSWORD")
    masked = "***" if password else "(未提供)"
    print("Jenkins 部署脚本尚未替换为真实实现。")
    print(f"url={args.jenkins_url}, username={args.username}, job={args.job}, password={masked}")
    print("请将真实脚本内容写入 ~/.devhaven/scripts/jenkins-depoly")
    return 1


if __name__ == "__main__":
    sys.exit(main())
"#,
    }]
}

fn write_manifest_from_scripts(
    root: &Path,
    scripts: &[SharedScriptManifestScript],
    preset_version: Option<&str>,
) -> Result<(), String> {
    let mut manifest_entries = Vec::new();
    let mut used_ids = HashSet::new();
    for (index, script) in scripts.iter().enumerate() {
        let id = script.id.trim();
        if id.is_empty() {
            return Err(format!("第 {} 个脚本缺少 id", index + 1));
        }
        if !used_ids.insert(id.to_string()) {
            return Err(format!("脚本 id 重复: {}", id));
        }
        let relative_path = normalize_relative_path(&script.path)
            .ok_or_else(|| format!("脚本路径不合法（id={}）：{}", script.id, script.path))?;
        manifest_entries.push(SharedScriptsManifestEntry {
            id: id.to_string(),
            name: script.name.trim().to_string(),
            path: relative_path,
            command_template: Some(if script.command_template.trim().is_empty() {
                DEFAULT_COMMAND_TEMPLATE.to_string()
            } else {
                script.command_template.trim().to_string()
            }),
            params: normalize_param_fields(script.params.clone()),
        });
    }
    write_manifest(
        root,
        manifest_entries,
        preset_version.map(ToOwned::to_owned),
    )
}

fn write_manifest(
    root: &Path,
    scripts: Vec<SharedScriptsManifestEntry>,
    preset_version: Option<String>,
) -> Result<(), String> {
    let manifest = SharedScriptsManifest {
        preset_version,
        scripts,
    };
    let data = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("序列化通用脚本清单失败（{}）：{}", root.display(), error))?;
    let manifest_path = root.join(MANIFEST_FILE_NAME);
    fs::write(&manifest_path, data).map_err(|error| {
        format!(
            "写入通用脚本清单失败（{}）：{}",
            manifest_path.display(),
            error
        )
    })
}

fn read_manifest(manifest_path: &Path) -> Result<SharedScriptsManifest, String> {
    let bytes = fs::read(manifest_path).map_err(|error| {
        format!(
            "读取通用脚本清单失败（{}）：{}",
            manifest_path.display(),
            error
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "解析通用脚本清单失败（{}）：{}",
            manifest_path.display(),
            error
        )
    })
}

fn read_manifest_preset_version(manifest_path: &Path) -> Result<Option<String>, String> {
    if !manifest_path.exists() {
        return Ok(None);
    }
    match read_manifest(manifest_path) {
        Ok(manifest) => Ok(manifest.preset_version),
        Err(error) => {
            log::warn!(
                "读取共享脚本预设版本失败，忽略并继续覆盖（{}）：{}",
                manifest_path.display(),
                error
            );
            Ok(None)
        }
    }
}

fn manifest_script_from_entry(entry: SharedScriptEntry) -> SharedScriptManifestScript {
    SharedScriptManifestScript {
        id: entry.id,
        name: entry.name,
        path: entry.relative_path,
        command_template: entry.command_template,
        params: entry.params,
    }
}

fn write_file_if_absent(path: &Path, content: &str) -> Result<bool, String> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建脚本目录失败（{}）：{}", parent.display(), error))?;
    }
    fs::write(path, content)
        .map_err(|error| format!("写入脚本文件失败（{}）：{}", path.display(), error))?;
    Ok(true)
}

fn resolve_shared_script_path(
    app: &AppHandle,
    root_override: Option<&str>,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let root = resolve_shared_scripts_root(app, root_override)?;
    let normalized = normalize_relative_path(relative_path)
        .ok_or_else(|| format!("脚本相对路径不合法: {}", relative_path))?;
    Ok(root.join(normalized))
}

fn normalize_relative_path(path: &str) -> Option<String> {
    let mut normalized = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::CurDir => continue,
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let result = normalized.to_string_lossy().replace('\\', "/");
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn normalize_param_fields(fields: Vec<ScriptParamField>) -> Vec<ScriptParamField> {
    let mut normalized = Vec::new();
    let mut used_keys = HashSet::new();

    for field in fields {
        let key = field.key.trim().to_string();
        if key.is_empty() || !used_keys.insert(key.clone()) {
            continue;
        }
        let label = if field.label.trim().is_empty() {
            key.clone()
        } else {
            field.label.trim().to_string()
        };
        let default_value = field
            .default_value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let description = field
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        normalized.push(ScriptParamField {
            key,
            label,
            r#type: field.r#type,
            required: field.required,
            default_value,
            description,
        });
    }

    normalized
}

fn resolve_shared_scripts_root(
    app: &AppHandle,
    root_override: Option<&str>,
) -> Result<PathBuf, String> {
    let configured = root_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_SHARED_SCRIPTS_ROOT);
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {}", error))?;
    Ok(expand_home_path(configured, &home))
}

fn expand_home_path(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home.join(rest);
    }

    let candidate = PathBuf::from(path);
    if candidate.is_absolute() {
        candidate
    } else {
        home.join(candidate)
    }
}

fn is_script_candidate(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    if matches!(
        extension.as_deref(),
        Some("sh" | "bash" | "zsh" | "fish" | "command" | "ps1" | "cmd" | "bat")
    ) {
        return true;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if let Ok(metadata) = fs::metadata(path) {
            return metadata.permissions().mode() & 0o111 != 0;
        }
    }

    false
}

fn derive_script_name(relative_path: &str) -> String {
    Path::new(relative_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| relative_path.to_string())
}

fn create_scanned_id(relative_path: &str) -> String {
    let mut id = String::with_capacity(relative_path.len());
    for ch in relative_path.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_lowercase());
        } else {
            id.push('-');
        }
    }
    let compact = id.trim_matches('-');
    if compact.is_empty() {
        "shared-script".to_string()
    } else {
        compact.to_string()
    }
}

fn ensure_unique_id(used_ids: &mut HashSet<String>, id_base: &str) -> String {
    if used_ids.insert(id_base.to_string()) {
        return id_base.to_string();
    }
    let mut index = 2usize;
    loop {
        let candidate = format!("{}-{}", id_base, index);
        if used_ids.insert(candidate.clone()) {
            return candidate;
        }
        index += 1;
    }
}
