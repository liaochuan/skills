# Skills

个人 agent skills 集合。每个 skill 一个目录，目录内为 `SKILL.md`（YAML frontmatter + 正文）以及该 skill 自带的脚本、测试等资源，遵循 Agent Skills 规范，可被 OpenCode、Claude Code 等支持 `SKILL.md` 的 agent 加载。

## 技能列表

| Skill | 说明 |
|---|---|
| [dev-rules](./dev-rules/SKILL.md) | 通用开发规则：初始化检查、任务分流、安全风险提示、worktree 隔离、文档归属、提交禁令、收尾审查，共七条，不限技术栈。附带 `merge-back.mjs`，用于把 worktree 里的改动串行回流到主工作区。 |

## 目录结构

```
.
├── README.md
├── .gitignore
└── dev-rules/
    ├── SKILL.md
    └── scripts/
        ├── merge-back.mjs        # worktree 改动回流脚本
        └── merge-back.test.mjs   # 对应的回归测试（node:test）
```

## 安装

把一个 skill 目录整个复制到 agent 的 skills 目录即可，目录名需与 `SKILL.md` 里的 `name` 一致。

OpenCode：

```bash
# 全局
git clone https://github.com/liaochuan/skills.git ~/skills-tmp
cp -r ~/skills-tmp/dev-rules ~/.config/opencode/skills/dev-rules
# 或项目内
cp -r ~/skills-tmp/dev-rules .opencode/skills/dev-rules
```

Claude Code：

```bash
cp -r ~/skills-tmp/dev-rules ~/.claude/skills/dev-rules
```

Windows 下把 `cp -r` 换成 `Copy-Item -Recurse` 即可。

## 测试

带脚本的 skill 保留对应测试，脚本改动后可回归验证：

```bash
node --test dev-rules/scripts/merge-back.test.mjs
```

需要 Node.js 18+（脚本用到 `node:test` 与 ESM）。

## 新增 skill

1. 在根目录新建 `<skill-name>/`，目录名用小写字母、数字和单个连字符
2. 写 `SKILL.md`，frontmatter 至少包含 `name` 与 `description`
3. 有脚本就放在 `scripts/`，同时补上可运行的测试
4. 在本 README 的技能列表里加一行
