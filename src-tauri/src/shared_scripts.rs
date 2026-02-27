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
const BUILTIN_PRESET_VERSION: &str = "2026.02.4";

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
    vec![
        SharedScriptPreset {
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
"""统一 Jenkins 构建触发脚本：支持工程选择、参数填写、实时日志。"""

import argparse
import base64
import getpass
import json
import os
import shutil
import subprocess
import sys
import time
from urllib import error, parse, request

try:
    import readline
except ImportError:
    readline = None


def parse_json(body, context):
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        snippet = body[:300].replace("\n", " ")
        raise RuntimeError(f"{context} 返回非 JSON: {snippet}") from exc


def input_with_completion(prompt_text, options):
    """为交互输入增加 Tab 自动补全；不支持 readline 时自动降级。"""
    if readline is None or not options:
        return input(prompt_text).strip()

    candidates = sorted({str(item) for item in options}, key=str.lower)

    def completer(text, state):
        text_lower = text.lower()
        matches = [item for item in candidates if text_lower in item.lower()]
        if state < len(matches):
            return matches[state]
        return None

    old_completer = readline.get_completer()
    old_delims = readline.get_completer_delims()
    try:
        readline.set_completer(completer)
        # 分支名常含 "/"，这里移除分隔符避免补全被截断。
        readline.set_completer_delims(old_delims.replace("/", ""))
        readline.parse_and_bind("tab: complete")
        return input(prompt_text).strip()
    finally:
        readline.set_completer(old_completer)
        readline.set_completer_delims(old_delims)


def can_use_fzf():
    return bool(shutil.which("fzf")) and sys.stdin.isatty() and sys.stdout.isatty()


def fzf_select(options, prompt_text, header=None, query=None):
    """使用 fzf 做交互筛选；返回选中值，取消时返回 None。"""
    if not options or not can_use_fzf():
        return None

    cmd = [
        "fzf",
        "--height=70%",
        "--layout=reverse",
        "--border",
        "--prompt",
        prompt_text,
        "--select-1",
        "--exit-0",
    ]
    if header:
        cmd.extend(["--header", header])
    if query:
        cmd.extend(["--query", str(query)])

    proc = subprocess.run(
        cmd,
        input="\n".join(str(item) for item in options) + "\n",
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    selected = proc.stdout.strip().splitlines()
    return selected[0] if selected else None


def resolve_ui_mode(ui_mode):
    if ui_mode == "plain":
        return False
    if ui_mode == "fzf":
        if not can_use_fzf():
            raise RuntimeError("指定了 --ui fzf，但当前环境不可用（请安装 fzf 并在交互终端运行）")
        return True
    return can_use_fzf()


class JenkinsClient:
    def __init__(self, base_url, username, password, timeout=30):
        self.base_url = base_url.rstrip("/")
        self.base_parsed = parse.urlparse(self.base_url)
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        self.auth_header = f"Basic {token}"
        self.timeout = timeout
        self.crumb = None

    def _full_url(self, path_or_url):
        if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
            return path_or_url
        return parse.urljoin(self.base_url + "/", path_or_url.lstrip("/"))

    def request(self, path_or_url, method="GET", data=None, headers=None):
        req_headers = {"Authorization": self.auth_header}
        if self.crumb and method.upper() in ("POST", "PUT", "PATCH", "DELETE"):
            req_headers[self.crumb[0]] = self.crumb[1]
        if headers:
            req_headers.update(headers)

        req = request.Request(
            url=self._full_url(path_or_url),
            data=data,
            headers=req_headers,
            method=method.upper(),
        )
        try:
            with request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                return resp.status, resp_headers, body
        except error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            err_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
            return exc.code, err_headers, body

    def canonicalize_url(self, path_or_url):
        """强制使用用户传入 Jenkins 地址的协议和主机，避免 Jenkins Root URL 配置错位。"""
        full_url = self._full_url(path_or_url)
        parsed = parse.urlparse(full_url)
        return parse.urlunparse(
            (
                self.base_parsed.scheme,
                self.base_parsed.netloc,
                parsed.path or "/",
                parsed.params,
                parsed.query,
                parsed.fragment,
            )
        )

    def request_json(self, path_or_url, context="请求"):
        status, _, body = self.request(path_or_url)
        if status != 200:
            raise RuntimeError(f"{context}失败 HTTP {status}: {body[:300]}")
        return parse_json(body, context)

    def init_crumb(self):
        status, _, body = self.request("/crumbIssuer/api/json")
        if status == 200:
            data = parse_json(body, "获取 crumb")
            field = data.get("crumbRequestField")
            crumb = data.get("crumb")
            if field and crumb:
                self.crumb = (field, crumb)
            return
        if status in (403, 404):
            self.crumb = None
            return
        raise RuntimeError(f"获取 crumb 失败 HTTP {status}: {body[:300]}")

    def list_jobs(self):
        jobs = []

        def walk(api_url, prefix):
            data = self.request_json(api_url, context="读取工程列表")
            for item in data.get("jobs", []):
                name = item.get("name")
                url = item.get("url")
                cls = (item.get("_class") or "").lower()
                if not name or not url:
                    continue

                is_container = ("folder" in cls) or ("multibranch" in cls)
                if is_container:
                    child_api = parse.urljoin(url, "api/json?tree=jobs[name,url,_class]")
                    child_api = self.canonicalize_url(child_api)
                    walk(child_api, prefix + name + "/")
                    continue
                canonical = self.canonicalize_url(url).rstrip("/") + "/"
                jobs.append({"name": prefix + name, "url": canonical})

        walk("/api/json?tree=jobs[name,url,_class]", "")
        jobs.sort(key=lambda item: item["name"].lower())
        return jobs


def job_ref_to_url(base_url, job_ref):
    ref = (job_ref or "").strip()
    if not ref:
        raise ValueError("job 不能为空")

    if ref.startswith("http://") or ref.startswith("https://"):
        return ref.rstrip("/") + "/"

    if "/job/" in ref:
        path = ref.strip("/")
        if not path.startswith("job/"):
            path = "job/" + path
        return parse.urljoin(base_url.rstrip("/") + "/", path + "/")

    parts = [part for part in ref.strip("/").split("/") if part]
    if not parts:
        raise ValueError("job 格式非法")
    path = "/".join(f"job/{parse.quote(part, safe='')}" for part in parts)
    return parse.urljoin(base_url.rstrip("/") + "/", path + "/")


def select_job(client, job_arg, non_interactive, use_fzf):
    if job_arg:
        job_url = job_ref_to_url(client.base_url, job_arg)
        data = client.request_json(job_url + "api/json?tree=name,fullName,url", context="读取工程信息")
        display_name = data.get("fullName") or data.get("name") or job_arg
        job_url = client.canonicalize_url(data.get("url") or job_url).rstrip("/") + "/"
        return display_name, job_url

    if non_interactive:
        raise RuntimeError("非交互模式必须使用 --job 指定工程")

    all_jobs = client.list_jobs()
    if not all_jobs:
        raise RuntimeError("未发现可用工程")

    if use_fzf:
        selected_name = fzf_select(
            [item["name"] for item in all_jobs],
            prompt_text="工程> ",
            header="输入即过滤；回车确认；可鼠标点击定位",
        )
        if selected_name:
            chosen = next(item for item in all_jobs if item["name"] == selected_name)
            return chosen["name"], chosen["url"]
        print("已退出 fzf 选择，降级到文本交互模式。")

    current = all_jobs
    while True:
        print("\n可选工程（支持 Tab 补全）:")
        for item in current[:20]:
            print(f"  - {item['name']}")
        if len(current) > 20:
            print(f"  ... 当前匹配 {len(current)} 个，请继续输入关键字缩小范围")

        raw = input_with_completion(
            "输入工程名（支持关键字过滤，回车在仅剩1项时确认）: ",
            [item["name"] for item in all_jobs],
        )
        if not raw:
            if len(current) == 1:
                chosen = current[0]
                return chosen["name"], chosen["url"]
            print("当前匹配不唯一，请继续输入关键字")
            continue

        exact = next((item for item in all_jobs if item["name"] == raw), None)
        if exact is None:
            exact = next((item for item in all_jobs if item["name"].lower() == raw.lower()), None)
        if exact:
            return exact["name"], exact["url"]

        filtered = [item for item in all_jobs if raw.lower() in item["name"].lower()]
        if not filtered:
            print("没有匹配工程，请重试")
            current = all_jobs
            continue
        if len(filtered) == 1:
            chosen = filtered[0]
            return chosen["name"], chosen["url"]
        print(f"匹配到 {len(filtered)} 个工程，请继续输入更精确关键字")
        current = filtered


def get_param_definitions(client, job_url):
    api_url = (
        job_url
        + "api/json?tree=actions[parameterDefinitions[name,description,type,defaultParameterValue[value],choices,_class]]"
    )
    data = client.request_json(api_url, context="读取参数定义")

    params = []
    seen = set()
    for action in data.get("actions") or []:
        # Jenkins actions 里可能混入 null，必须先做类型保护。
        if not isinstance(action, dict):
            continue

        raw_definitions = action.get("parameterDefinitions") or []
        if isinstance(raw_definitions, dict):
            definitions = [raw_definitions]
        elif isinstance(raw_definitions, list):
            definitions = raw_definitions
        else:
            continue

        for definition in definitions:
            if not isinstance(definition, dict):
                continue
            name = definition.get("name")
            if not name or name in seen:
                continue
            seen.add(name)

            ptype = definition.get("type") or (definition.get("_class", "").split(".")[-1])
            default = None
            if isinstance(definition.get("defaultParameterValue"), dict):
                default = definition["defaultParameterValue"].get("value")
            choices = definition.get("choices")
            if isinstance(choices, list):
                choices = [str(item) for item in choices]
            else:
                choices = None

            params.append(
                {
                    "name": name,
                    "type": ptype or "",
                    "class_name": definition.get("_class") or "",
                    "description": definition.get("description") or "",
                    "default": default,
                    "choices": choices,
                }
            )

    enrich_git_parameter_choices(client, job_url, params)
    return params


def enrich_git_parameter_choices(client, job_url, params):
    """补全 Git Parameter 插件的可选项（如分支/标签），让终端也能下拉选择。"""
    endpoint = (
        job_url
        + "descriptorByName/net.uaznia.lukanus.hudson.plugins.gitparameter.GitParameterDefinition/fillValueItems"
    )

    for param in params:
        is_git_param = (
            "gitparameter" in (param.get("class_name") or "").lower()
            or (param.get("type") or "").startswith("PT_")
        )
        if not is_git_param:
            continue
        if param.get("choices"):
            continue

        try:
            query = parse.urlencode({"param": param["name"]})
            data = client.request_json(endpoint + "?" + query, context=f"读取 {param['name']} 可选项")
            values = data.get("values") or []
            parsed_choices = []
            selected_default = None
            for item in values:
                value = str(item.get("value", "")).strip()
                if not value:
                    continue
                parsed_choices.append(value)
                if item.get("selected"):
                    selected_default = value
            if parsed_choices:
                param["choices"] = parsed_choices
                if selected_default is not None:
                    param["default"] = selected_default
        except Exception:
            # 动态拉取失败时降级为文本输入，避免影响整个构建流程。
            continue


def parse_param_overrides(items):
    params = {}
    for item in items or []:
        if "=" not in item:
            raise ValueError(f"参数格式错误: {item}，应为 key=value")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"参数 key 不能为空: {item}")
        params[key] = value
    return params


def is_boolean_type(param_type):
    return "boolean" in (param_type or "").lower()


def to_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")


def parse_bool(raw):
    value = raw.strip().lower()
    if value in ("1", "true", "yes", "y", "on"):
        return "true"
    if value in ("0", "false", "no", "n", "off"):
        return "false"
    return None


def prompt_param_value(param, use_fzf):
    name = param["name"]
    description = f" - {param['description']}" if param["description"] else ""
    param_type = param["type"]
    default = param["default"]
    choices = param["choices"]

    print(f"\n参数 {name}{description}")

    if choices:
        if use_fzf:
            selected = fzf_select(
                choices,
                prompt_text=f"{name}> ",
                header="输入即过滤；回车确认；可鼠标点击定位",
                query=default if default is not None else None,
            )
            if selected:
                return str(selected)
            print("已退出 fzf 选择，降级到文本输入模式。")

        current_choices = choices
        while True:
            preview = ", ".join(current_choices[:8])
            if len(current_choices) > 8:
                preview += f" ...（共 {len(current_choices)} 项）"
            print(f"可选值: {preview}")

            if default is not None:
                prompt_text = f"请输入值（支持关键字/Tab 补全，回车默认 {default}）: "
            else:
                prompt_text = "请输入值（支持关键字/Tab 补全，回车在仅剩1项时确认）: "
            raw = input_with_completion(prompt_text, choices)

            if not raw:
                if default is not None:
                    return str(default)
                if len(current_choices) == 1:
                    return str(current_choices[0])
                print("当前匹配不唯一，请继续输入关键字")
                continue

            exact = next((item for item in choices if item == raw), None)
            if exact is None:
                exact = next((item for item in choices if str(item).lower() == raw.lower()), None)
            if exact is not None:
                return str(exact)

            filtered = [item for item in choices if raw.lower() in str(item).lower()]
            if not filtered:
                print("没有匹配值，请重试")
                current_choices = choices
                continue
            if len(filtered) == 1:
                return str(filtered[0])
            print(f"匹配到 {len(filtered)} 个值，请继续输入更精确关键字")
            current_choices = filtered

    if is_boolean_type(param_type):
        default_bool = to_bool(default)
        hint = "Y/n" if default_bool else "y/N"
        while True:
            raw = input(f"输入布尔值 [{hint}]: ").strip()
            if not raw:
                return "true" if default_bool else "false"
            parsed = parse_bool(raw)
            if parsed is not None:
                return parsed
            print("请输入 y/n/true/false")

    if "password" in (param_type or "").lower():
        value = getpass.getpass("请输入（回车使用默认）: ")
        if value == "" and default is not None:
            return str(default)
        return value

    if default is not None:
        raw = input(f"请输入（默认: {default}）: ").strip()
        return str(default) if raw == "" else raw

    return input("请输入: ").strip()


def collect_params(param_defs, overrides, non_interactive, use_fzf):
    params = {}
    consumed = set()

    for param in param_defs:
        name = param["name"]
        if name in overrides:
            params[name] = overrides[name]
            consumed.add(name)
            continue

        if non_interactive:
            if param["default"] is None:
                raise RuntimeError(f"参数 {name} 缺失，请使用 --param {name}=... 指定")
            params[name] = "true" if is_boolean_type(param["type"]) and to_bool(param["default"]) else str(param["default"])
            continue

        params[name] = prompt_param_value(param, use_fzf)

    for key, value in overrides.items():
        if key not in consumed and key not in params:
            params[key] = value

    return params


def should_mask(key):
    lowered = key.lower()
    return any(token in lowered for token in ("password", "token", "secret", "key"))


def trigger_build(client, job_url, params):
    if params:
        endpoint = job_url + "buildWithParameters"
        data = parse.urlencode(params).encode("utf-8")
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
    else:
        endpoint = job_url + "build"
        data = None
        headers = None

    status, resp_headers, body = client.request(endpoint, method="POST", data=data, headers=headers)
    if status not in (200, 201, 202):
        raise RuntimeError(f"触发构建失败 HTTP {status}: {body[:400]}")

    queue_url = resp_headers.get("location")
    if not queue_url:
        raise RuntimeError("触发成功但没有返回队列地址（Location 头缺失）")

    queue_url = client.canonicalize_url(queue_url).rstrip("/") + "/"
    return queue_url


def wait_for_build_start(client, queue_url, job_url, timeout_sec, poll_sec):
    deadline = time.time() + timeout_sec
    last_reason = None

    while time.time() < deadline:
        queue = client.request_json(
            queue_url + "api/json?tree=why,cancelled,executable[number,url]",
            context="查询队列",
        )
        if queue.get("cancelled"):
            raise RuntimeError(f"队列任务已取消: {queue.get('why') or 'unknown'}")

        executable = queue.get("executable")
        if executable and executable.get("number") is not None:
            number = int(executable["number"])
            raw_url = executable.get("url")
            if raw_url:
                build_url = client.canonicalize_url(raw_url).rstrip("/") + "/"
            else:
                build_url = parse.urljoin(job_url.rstrip("/") + "/", f"{number}/")
            return number, build_url

        reason = queue.get("why")
        if reason and reason != last_reason:
            print(f"队列中: {reason}")
            last_reason = reason

        time.sleep(poll_sec)

    raise TimeoutError("等待构建开始超时")


def stream_logs(client, build_url, timeout_sec, poll_sec):
    deadline = time.time() + timeout_sec
    offset = 0
    result = "UNKNOWN"

    while time.time() < deadline:
        status, headers, text = client.request(f"{build_url}logText/progressiveText?start={offset}")
        more_data = False
        if status == 200:
            if text:
                sys.stdout.write(text)
                sys.stdout.flush()
            try:
                offset = int(headers.get("x-text-size", str(offset)))
            except ValueError:
                pass
            more_data = headers.get("x-more-data", "false").lower() == "true"

        info = client.request_json(build_url + "api/json?tree=building,result", context="查询构建状态")
        building = bool(info.get("building"))
        if info.get("result"):
            result = info["result"]

        if not building and not more_data:
            return result
        time.sleep(poll_sec)

    raise TimeoutError("实时日志拉取超时")


def parse_args():
    parser = argparse.ArgumentParser(description="Jenkins 统一触发脚本（工程选择 + 参数填写 + 实时日志）")
    parser.add_argument("--jenkins-url", required=True, help="例如: http://192.168.0.28:8081/")
    parser.add_argument("--username", required=True, help="Jenkins 用户名")
    parser.add_argument("--password", default=None, help="Jenkins 密码（建议使用 JENKINS_PASSWORD）")
    parser.add_argument("--job", help="工程名称/路径/URL（不传则交互选择）")
    parser.add_argument("--param", action="append", default=[], help="参数 key=value，可重复")
    parser.add_argument("--list-jobs", action="store_true", help="仅列出工程并退出")
    parser.add_argument("--non-interactive", action="store_true", help="强制非交互模式")
    parser.add_argument("--timeout", type=int, default=1800, help="总超时秒数，默认 1800")
    parser.add_argument("--poll", type=float, default=2.0, help="轮询间隔秒，默认 2")
    parser.add_argument("--http-timeout", type=int, default=30, help="单次 HTTP 超时秒数，默认 30")
    parser.add_argument(
        "--ui",
        choices=("auto", "fzf", "plain"),
        default="auto",
        help="交互模式：auto(自动), fzf(强制 fzf), plain(纯文本)",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    use_fzf = resolve_ui_mode(args.ui)
    password = args.password or os.environ.get("JENKINS_PASSWORD")
    if not password:
        if args.non_interactive:
            print("非交互模式缺少密码，请传 --password 或设置 JENKINS_PASSWORD", file=sys.stderr)
            return 2
        password = getpass.getpass("请输入 Jenkins 密码: ")
    if not password:
        print("密码不能为空", file=sys.stderr)
        return 2

    overrides = parse_param_overrides(args.param)

    client = JenkinsClient(
        base_url=args.jenkins_url,
        username=args.username,
        password=password,
        timeout=max(5, args.http_timeout),
    )
    client.init_crumb()

    if args.list_jobs:
        for item in client.list_jobs():
            print(item["name"])
        return 0

    job_name, job_url = select_job(client, args.job, args.non_interactive, use_fzf)
    print(f"目标工程: {job_name}")

    param_defs = get_param_definitions(client, job_url)
    if param_defs:
        print("检测到参数: " + ", ".join(param["name"] for param in param_defs))
    else:
        print("该工程未声明参数")

    params = collect_params(param_defs, overrides, args.non_interactive, use_fzf)
    if params:
        print("本次参数:")
        for key, value in params.items():
            display_value = "***" if should_mask(key) else value
            print(f"  - {key}={display_value}")

    queue_url = trigger_build(client, job_url, params)
    print(f"已触发构建，队列地址: {queue_url}")

    build_number, build_url = wait_for_build_start(client, queue_url, job_url, args.timeout, args.poll)
    print(f"构建开始: #{build_number} {build_url}")
    print("-" * 80)

    result = stream_logs(client, build_url, args.timeout, args.poll)
    print("\n" + "-" * 80)
    print(f"构建结果: {result}")
    return 0 if result == "SUCCESS" else 1


if __name__ == "__main__":
    sys.exit(main())
"#,
        },
        SharedScriptPreset {
            manifest_entry: SharedScriptsManifestEntry {
                id: "remote-log-viewer".to_string(),
                name: "远程日志查看".to_string(),
                path: "remote_log_viewer.sh".to_string(),
                command_template: Some(
                    r#"server=${server}
logPath=${logPath}
user=${user}
port=${port}
identityFile=${identityFile}
lines=${lines}
follow=${follow}
strictHostKeyChecking=${strictHostKeyChecking}
allowPasswordPrompt=${allowPasswordPrompt}

args=()
if [ -n "$user" ]; then args+=(--user "$user"); fi
if [ -n "$port" ]; then args+=(--port "$port"); fi
if [ -n "$identityFile" ]; then args+=(--identity-file "$identityFile"); fi
if [ -n "$lines" ]; then args+=(--lines "$lines"); fi
if [ "$follow" = "1" ]; then args+=(--follow); fi
if [ -n "$strictHostKeyChecking" ]; then args+=(--strict-host-key-checking "$strictHostKeyChecking"); fi
if [ "$allowPasswordPrompt" = "1" ]; then args+=(--allow-password-prompt); fi

exec bash "${scriptPath}" "${args[@]}" "$server" "$logPath""#
                        .to_string(),
                ),
                params: vec![
                    ScriptParamField {
                        key: "server".to_string(),
                        label: "服务器".to_string(),
                        r#type: ScriptParamFieldType::Text,
                        required: true,
                        default_value: None,
                        description: Some("例如：10.0.0.12 或 user@10.0.0.12".to_string()),
                    },
                    ScriptParamField {
                        key: "logPath".to_string(),
                        label: "日志路径".to_string(),
                        r#type: ScriptParamFieldType::Text,
                        required: true,
                        default_value: None,
                        description: Some("例如：/var/log/nginx/error.log".to_string()),
                    },
                    ScriptParamField {
                        key: "user".to_string(),
                        label: "SSH 用户".to_string(),
                        r#type: ScriptParamFieldType::Text,
                        required: false,
                        default_value: None,
                        description: Some("当 server 已包含 user@host 时可留空".to_string()),
                    },
                    ScriptParamField {
                        key: "port".to_string(),
                        label: "SSH 端口".to_string(),
                        r#type: ScriptParamFieldType::Number,
                        required: false,
                        default_value: Some("22".to_string()),
                        description: None,
                    },
                    ScriptParamField {
                        key: "identityFile".to_string(),
                        label: "私钥文件".to_string(),
                        r#type: ScriptParamFieldType::Text,
                        required: false,
                        default_value: None,
                        description: Some("例如：~/.ssh/id_rsa".to_string()),
                    },
                    ScriptParamField {
                        key: "lines".to_string(),
                        label: "输出行数".to_string(),
                        r#type: ScriptParamFieldType::Number,
                        required: false,
                        default_value: Some("200".to_string()),
                        description: None,
                    },
                    ScriptParamField {
                        key: "follow".to_string(),
                        label: "持续跟踪".to_string(),
                        r#type: ScriptParamFieldType::Number,
                        required: false,
                        default_value: Some("0".to_string()),
                        description: Some("填 1 开启（追加 --follow）".to_string()),
                    },
                    ScriptParamField {
                        key: "strictHostKeyChecking".to_string(),
                        label: "StrictHostKeyChecking".to_string(),
                        r#type: ScriptParamFieldType::Text,
                        required: false,
                        default_value: Some("accept-new".to_string()),
                        description: Some("可选值：yes/no/accept-new".to_string()),
                    },
                    ScriptParamField {
                        key: "allowPasswordPrompt".to_string(),
                        label: "允许密码交互".to_string(),
                        r#type: ScriptParamFieldType::Number,
                        required: false,
                        default_value: Some("0".to_string()),
                        description: Some("填 1 开启（关闭 BatchMode）".to_string()),
                    },
                ],
            },
            file_content: r#"#!/usr/bin/env bash
set -euo pipefail

# 查看用法
usage() {
  cat <<'EOF'
用法:
  remote_log_viewer.sh [选项] <server> <log_path>

说明:
  通过 SSH 查看远程日志，默认输出最后 200 行。

参数:
  <server>              服务器地址，例如: 10.0.0.12 或 user@10.0.0.12
  <log_path>            远程日志路径，例如: /var/log/nginx/error.log

选项:
  -u, --user USER       SSH 用户名（当 server 已包含 user@host 时忽略）
  -p, --port PORT       SSH 端口（默认: 22）
  -i, --identity-file   SSH 私钥文件路径
  -n, --lines LINES     tail 输出行数（默认: 200）
  -f, --follow          持续跟踪日志（tail -F）
      --strict-host-key-checking MODE
                        SSH StrictHostKeyChecking: yes|no|accept-new（默认: accept-new）
      --allow-password-prompt
                        允许交互式密码输入（默认关闭，启用 BatchMode）
  -h, --help            显示帮助

示例:
  ./remote_log_viewer.sh 10.0.0.12 /var/log/syslog
  ./remote_log_viewer.sh -u root -i ~/.ssh/id_rsa -f -n 300 10.0.0.12 /var/log/app.log
EOF
}

user=""
port=22
identity_file=""
lines=200
follow=0
strict_host_key_checking="accept-new"
allow_password_prompt=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--user)
      user="${2:-}"
      shift 2
      ;;
    -p|--port)
      port="${2:-}"
      shift 2
      ;;
    -i|--identity-file)
      identity_file="${2:-}"
      shift 2
      ;;
    -n|--lines)
      lines="${2:-}"
      shift 2
      ;;
    -f|--follow)
      follow=1
      shift
      ;;
    --strict-host-key-checking)
      strict_host_key_checking="${2:-}"
      shift 2
      ;;
    --allow-password-prompt)
      allow_password_prompt=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "错误: 未知参数 $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -ne 2 ]]; then
  echo "错误: 需要传入 server 和 log_path 两个参数。" >&2
  usage >&2
  exit 2
fi

server="$1"
log_path="$2"

if ! [[ "$lines" =~ ^[1-9][0-9]*$ ]]; then
  echo "错误: --lines 必须是大于 0 的整数。" >&2
  exit 2
fi

if ! [[ "$port" =~ ^[1-9][0-9]*$ ]]; then
  echo "错误: --port 必须是大于 0 的整数。" >&2
  exit 2
fi

case "$strict_host_key_checking" in
  yes|no|accept-new) ;;
  *)
    echo "错误: --strict-host-key-checking 仅支持 yes|no|accept-new。" >&2
    exit 2
    ;;
esac

if ! command -v ssh >/dev/null 2>&1; then
  echo "错误: 未找到 ssh 命令。" >&2
  exit 127
fi

target="$server"
if [[ "$server" != *"@"* && -n "$user" ]]; then
  target="${user}@${server}"
fi

printf -v safe_log_path '%q' "$log_path"
tail_flag=""
if [[ "$follow" -eq 1 ]]; then
  tail_flag="-F"
fi
remote_cmd="tail -n ${lines} ${tail_flag} -- ${safe_log_path}"

ssh_cmd=(
  ssh
  -o "StrictHostKeyChecking=${strict_host_key_checking}"
  -p "$port"
)

if [[ "$allow_password_prompt" -eq 0 ]]; then
  ssh_cmd+=(-o "BatchMode=yes")
fi

if [[ -n "$identity_file" ]]; then
  ssh_cmd+=(-i "$identity_file")
fi

ssh_cmd+=("$target" "$remote_cmd")

exec "${ssh_cmd[@]}"
"#,
        },
    ]
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
