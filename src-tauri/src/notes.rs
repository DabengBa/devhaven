use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::models::ProjectNotesPreview;
use rayon::prelude::*;

const NOTES_FILE: &str = "PROJECT_NOTES.md";
const TODO_FILE: &str = "PROJECT_TODO.md";

/// 读取项目备注内容，空内容返回 None。
pub fn read_notes(project_path: &str) -> Result<Option<String>, String> {
    read_optional_file(project_path, NOTES_FILE, "备注")
}

/// 写入项目备注内容，传 None 则删除文件。
pub fn write_notes(project_path: &str, notes: Option<String>) -> Result<(), String> {
    write_optional_file(project_path, NOTES_FILE, "备注", notes)
}

/// 读取项目 Todo 内容，空内容返回 None。
pub fn read_todo(project_path: &str) -> Result<Option<String>, String> {
    read_optional_file(project_path, TODO_FILE, "Todo")
}

/// 写入项目 Todo 内容，传 None 则删除文件。
pub fn write_todo(project_path: &str, todo: Option<String>) -> Result<(), String> {
    write_optional_file(project_path, TODO_FILE, "Todo", todo)
}

/// 批量读取项目备注首行预览，读取失败时返回空预览。
pub fn read_notes_previews(project_paths: &[String]) -> Vec<ProjectNotesPreview> {
    project_paths
        .par_iter()
        .map(|path| ProjectNotesPreview {
            path: path.clone(),
            notes_preview: read_notes_preview_line(path),
        })
        .collect()
}

fn read_notes_preview_line(project_path: &str) -> Option<String> {
    let target_path = Path::new(project_path).join(NOTES_FILE);
    let file = fs::File::open(&target_path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = line.ok()?;
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    None
}

fn read_optional_file(
    project_path: &str,
    file_name: &str,
    label: &str,
) -> Result<Option<String>, String> {
    let target_path = Path::new(project_path).join(file_name);
    if !target_path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&target_path).map_err(|err| format!("读取{label}失败: {err}"))?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(content))
    }
}

fn write_optional_file(
    project_path: &str,
    file_name: &str,
    label: &str,
    content: Option<String>,
) -> Result<(), String> {
    let target_path = Path::new(project_path).join(file_name);
    match content {
        Some(value) => {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|err| format!("创建{label}目录失败: {err}"))?;
            }
            fs::write(&target_path, value).map_err(|err| format!("写入{label}失败: {err}"))?;
            Ok(())
        }
        None => {
            if target_path.exists() {
                fs::remove_file(&target_path).map_err(|err| format!("删除{label}失败: {err}"))?;
            }
            Ok(())
        }
    }
}
