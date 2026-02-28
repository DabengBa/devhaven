use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::process::Command;

use rayon::prelude::*;

use crate::models::{GitDailyResult, GitIdentity};

const GIT_LOG_PRETTY_WITH_IDENTITY: &str = "--pretty=format:%an%x1f%ae%x1f%cd";
const GIT_LOG_PRETTY_DATE_ONLY: &str = "--pretty=format:%cd";

pub fn collect_git_daily(paths: &[String], identities: &[GitIdentity]) -> Vec<GitDailyResult> {
    let matcher = IdentityMatcher::new(identities);
    paths
        .par_iter()
        .map(|path| collect_single(path, &matcher))
        .collect()
}

fn collect_single(path: &str, matcher: &IdentityMatcher) -> GitDailyResult {
    let repo_root = Path::new(path);
    if !repo_root.join(".git").exists() {
        return GitDailyResult {
            path: path.to_string(),
            git_daily: None,
            error: None,
        };
    }

    let pretty_arg = if matcher.matches_all() {
        GIT_LOG_PRETTY_DATE_ONLY
    } else {
        GIT_LOG_PRETTY_WITH_IDENTITY
    };

    let output = Command::new("git")
        .args(["log", pretty_arg, "--date=short"])
        .current_dir(repo_root)
        .output();

    let output = match output {
        Ok(output) => output,
        Err(err) => {
            return GitDailyResult {
                path: path.to_string(),
                git_daily: None,
                error: Some(format!("执行 git log 失败: {err}")),
            };
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return GitDailyResult {
            path: path.to_string(),
            git_daily: None,
            error: Some(format!("git log 返回失败: {stderr}")),
        };
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let counts = parse_git_log_counts(stdout.as_ref(), matcher);

    if counts.is_empty() {
        return GitDailyResult {
            path: path.to_string(),
            git_daily: None,
            error: None,
        };
    }

    let git_daily = counts
        .iter()
        .map(|(date, count)| format!("{date}:{count}"))
        .collect::<Vec<_>>()
        .join(",");

    GitDailyResult {
        path: path.to_string(),
        git_daily: Some(git_daily),
        error: None,
    }
}

struct IdentityMatcher {
    tokens: HashSet<String>,
}

impl IdentityMatcher {
    fn new(identities: &[GitIdentity]) -> Self {
        let mut tokens = HashSet::new();
        for identity in identities {
            if let Some(value) = normalize_identity_value(&identity.name) {
                tokens.insert(value);
            }
            if let Some(value) = normalize_identity_value(&identity.email) {
                tokens.insert(value);
            }
        }
        Self { tokens }
    }

    fn matches(&self, name: &str, email: &str) -> bool {
        if self.matches_all() {
            return true;
        }
        let normalized_name = normalize_identity_value(name);
        let normalized_email = normalize_identity_value(email);
        normalized_name
            .as_ref()
            .map(|value| self.tokens.contains(value))
            .unwrap_or(false)
            || normalized_email
                .as_ref()
                .map(|value| self.tokens.contains(value))
                .unwrap_or(false)
    }

    fn matches_all(&self) -> bool {
        self.tokens.is_empty()
    }
}

fn parse_git_log_counts(stdout: &str, matcher: &IdentityMatcher) -> BTreeMap<String, i64> {
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();

    if matcher.matches_all() {
        for line in stdout.lines() {
            let date = line.trim();
            if date.is_empty() {
                continue;
            }
            *counts.entry(date.to_string()).or_insert(0) += 1;
        }
        return counts;
    }

    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\u{1f}');
        let name = parts.next().unwrap_or("");
        let email = parts.next().unwrap_or("");
        let date = parts.next().unwrap_or("").trim();
        if date.is_empty() {
            continue;
        }
        if !matcher.matches(name, email) {
            continue;
        }
        *counts.entry(date.to_string()).or_insert(0) += 1;
    }

    counts
}

fn normalize_identity_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_git_log_counts_uses_date_only_fast_path_when_identity_is_empty() {
        let matcher = IdentityMatcher::new(&[]);
        let counts = parse_git_log_counts("2026-01-01\n2026-01-01\n\n2026-01-02\n", &matcher);

        assert_eq!(counts.get("2026-01-01"), Some(&2));
        assert_eq!(counts.get("2026-01-02"), Some(&1));
    }

    #[test]
    fn parse_git_log_counts_keeps_identity_filter_logic() {
        let matcher = IdentityMatcher::new(&[GitIdentity {
            name: "Alice".to_string(),
            email: "".to_string(),
        }]);
        let counts = parse_git_log_counts(
            "Alice\u{1f}alice@example.com\u{1f}2026-01-01\n\
             Bob\u{1f}bob@example.com\u{1f}2026-01-01\n\
             ALICE\u{1f}other@example.com\u{1f}2026-01-02\n",
            &matcher,
        );

        assert_eq!(counts.get("2026-01-01"), Some(&1));
        assert_eq!(counts.get("2026-01-02"), Some(&1));
        assert_eq!(counts.len(), 2);
    }
}
