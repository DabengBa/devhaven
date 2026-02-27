# Quick Command 重构任务清单

- [x] 现状审查：梳理 quick command 运行/停止/结束链路与竞态点
- [x] 后端状态机收敛：实现严格迁移、幂等 finish/stop、终态保护
- [x] 前端监听改造：接入 quick command snapshot + event，改为事件驱动
- [x] 停止闭环改造：软停 -> 超时硬停 -> 终态收口，避免状态漂移
- [x] 运行/停止竞态修复：处理 run 后立即 stop、重复 finish 等问题
- [x] 验证：类型检查与关键流程自测

---

## Review
- 采用“后端状态机 + 前端快照/事件对账”的执行模型，避免前端本地状态漂移。
- 运行与停止链路加入幂等保护（finish once）和 run->stop 启动竞态兜底。
- 补充会话关闭时的任务终态回写，减少 running/stopping 残留任务。
- 本地验证通过：`npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml`。

---

# Codex 终端浮层移除任务清单

- [x] 删除前端终端 Pane 右上角 Codex 模型/推理强度浮层渲染
- [x] 删除前端 overlay 轮询与启动输出解析逻辑
- [x] 删除前端 `get_terminal_codex_pane_overlay` service 封装
- [x] 删除 Tauri `get_terminal_codex_pane_overlay` command、模型结构与后端实现
- [x] 更新 `AGENTS.md` 功能地图，移除浮层说明
- [x] 验证构建：`npm run build` 与 `cargo check --manifest-path src-tauri/Cargo.toml`

## Review
- 本次改动只移除了“终端 pane 右上角浮层”链路，未影响侧栏 Codex 会话监控与运行状态聚合能力。
- Rust 侧同时清理了仅服务该浮层的 rollout/lsof/process-tree 代码，避免保留死代码和无效 command。
