# Experience Kernel 使用指南

## 概述

Experience Kernel 是 ClawLore 插件的经验沉淀系统，用于将任务执行经验转化为可复用的 playbook。

**核心工作流：**
```
任务执行 → 自动创建 episode → 手动/自动生成 playbook → 审核 → 复用
```

## 工具清单

### 1. 任务记录工具

#### `episode_create`
创建任务记录（通常自动触发，无需手动调用）

**使用场景：** 需要手动记录特殊任务时

```
episode_create({
  scope_id: "global",
  session_id: "session-xxx",
  task_class: "gateway_recovery",
  task_goal: "恢复崩溃的 Gateway",
  user_intent: "用户要求修复 Gateway 启动失败问题",
  status: "completed",
  outcome: "success"
})
```

#### `episode_complete`
标记任务完成并记录结果

```
episode_complete({
  episode_id: "episode-xxx",
  outcome: "success",
  journal: "修复了端口冲突问题，Gateway 恢复正常",
  verification: ["healthz 返回 ok", "端口 19021 正常监听"]
})
```

### 2. Playbook 管理工具

#### `playbook_create`
从任务经验创建可复用手册

```
playbook_create({
  task_class: "gateway_recovery",
  title: "Gateway 崩溃恢复流程",
  trigger: "当 Gateway 无法启动或 healthz 失败时",
  goal: "恢复 Gateway 正常运行",
  steps: [
    { action: "检查 systemctl status", why: "确认服务状态", evidence_required: "Active: active (running)" },
    { action: "检查端口占用", why: "排除端口冲突", evidence_required: "ss -tlnp 显示 19021 已监听" },
    { action: "查看错误日志", why: "定位根因", evidence_required: "journalctl 无 ERROR" }
  ],
  pitfalls: [
    { signal: "端口被占用", mistake: "直接重启服务", correction: "先 kill 占用进程或更换端口" }
  ],
  verification: [
    "curl http://127.0.0.1:19021/healthz 返回 ok",
    "systemctl status 显示 active"
  ]
})
```

#### `playbook_search`
搜索相关 playbook

```
playbook_search({
  query: "Gateway 启动失败",
  limit: 5,
  status_filter: ["promoted", "reviewed"]
})
```

#### `playbook_inspect`
查看 playbook 详情

```
playbook_inspect({
  playbook_id: "pb_xxx"
})
```

#### `playbook_feedback`
记录 playbook 使用反馈

```
playbook_feedback({
  playbook_id: "pb_xxx",
  outcome: "success",  // success | failure | stale
  notes: "按步骤执行成功，但发现还需要检查磁盘空间"
})
```

### 3. 审核与验证工具

#### `playbook_review`
正式审核 playbook（更新状态）

**支持的操作：**
- `review` - 标记为已审核
- `promote` - 批准复用（推荐）
- `needs_review` - 需要进一步审核
- `quarantine` - 隔离（有问题）
- `supersede` - 标记为已替代

```
playbook_review({
  playbook_id: "pb_xxx",
  action: "promote",
  reason: "经过 3 次实际验证，流程稳定可靠"
})
```

#### `experience_replay`
用测试用例验证 playbook

```
experience_replay({
  playbook_id: "pb_xxx",
  cases: [
    {
      name: "端口冲突场景",
      required_terms: ["端口", "占用", "kill", "更换端口"],
      negative_terms: ["忽略端口"]
    },
    {
      name: "配置错误场景",
      required_terms: ["配置", "验证", "JSON"],
      negative_terms: ["直接重启"]
    }
  ]
})
```

### 4. 统计与检查工具

#### `experience_preflight`
检查 Experience Kernel 状态

```
experience_preflight({
  check_schema: true,
  check_stats: true
})
```

#### `experience_stats`
查看经验统计信息

```
experience_stats({
  include_playbooks: true,
  include_episodes: true,
  include_runs: true
})
```

### 5. 自动沉淀工具

#### `experience_promote`
从多个 episode 自动生成 playbook

```
experience_promote({
  task_class: "gateway_recovery",
  min_episodes: 3,  // 至少 3 个相似 episode
  auto_create_playbook: true
})
```

#### `forgetting_report`
生成清理报告（识别过时或低质量的经验）

```
forgetting_report({
  dry_run: true,  // 先预览，不实际删除
  threshold_days: 90  // 90 天未使用的经验
})
```

## 最佳实践

### 1. 何时创建 Playbook

- ✅ 同类任务执行 3 次以上
- ✅ 流程已经稳定验证
- ✅ 包含重要的 pitfalls 和 verification
- ❌ 一次性任务
- ❌ 流程还在变化中

### 2. Playbook 质量标准

- **trigger**: 明确描述什么情况下使用
- **steps**: 每步都有 action、why、evidence_required
- **pitfalls**: 至少包含 2-3 个常见错误
- **verification**: 可执行的验证命令或检查点

### 3. 审核流程

```
创建 → 测试（replay）→ 审核（review）→ 批准（promote）→ 复用
```

### 4. 定期维护

- 每月运行 `forgetting_report` 清理过时经验
- 根据 `playbook_feedback` 更新低成功率的手册
- 用 `experience_stats` 监控整体健康度

## 自动触发机制

当前配置：`taskExperienceCapture.enabled: true`

**自动流程：**
1. 任务完成（agent_end 事件）
2. 自动分析 transcript
3. 创建 memory entry（memory_truth 表）
4. 同时创建 episode（task_episodes 表）
5. 积累足够 episode 后，手动调用 `experience_promote` 生成 playbook

## 故障排查

### 问题：episode 没有自动创建

**检查：**
```bash
# 查看日志
grep "task-experience.*episode" /home/a/openclaw-tianji/home/state/gateway.log | tail -10

# 检查数据库
sqlite3 /home/a/openclaw-tianji/home/state/memory/lancedb-pro/memory.sqlite3 \
  "SELECT COUNT(*) FROM task_episodes;"
```

### 问题：playbook 创建失败

**检查：**
```bash
# 运行 preflight
experience_preflight({ check_schema: true })

# 查看错误日志
grep "playbook_create.*error" /home/a/openclaw-tianji/home/state/gateway.log
```

## 版本信息

- **当前版本**: 1.0.21
- **Experience Kernel**: Phase 3（完整功能）
- **工具数量**: 12 个
- **最后更新**: 2026-06-18
