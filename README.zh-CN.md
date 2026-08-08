# pi-codex-env-run

在 [pi](https://pi.dev) 中复用并管理 [Codex](https://github.com/openai/codex)
项目环境动作（`.codex/environments/*.toml`）——一份配置文件，两个工具通用。

如果你在使用 Codex 的应用操作栏（`Run` 按钮），你的仓库里应该已经有
`.codex/environments/environment.toml`，其中包含 `[[actions]]` 条目。本扩展
解析同样的文件，让 pi 覆盖工作流的两个侧面：

**运行（执行项目动作）**
- **`/run <action>`** 斜杠命令，支持动作名补全
- **`run_env_action`** 工具，模型可直接调用（"运行模拟器" → agent 执行项目自己的脚本）

**管理（维护动作配置）**
- **`manage_env_action`** 工具，支持 `list` / `validate` / `add` / `update` /
  `remove` 操作 —— agent 可以检查、静态校验、增删改 `.codex/environments/*.toml`
  中的动作，例如"添加一个运行 ./gradlew assembleDebug 的 Build 动作"。

```
pi install npm:pi-codex-env-run
```

然后使用 `/run`（或 `/run sim` 补全为 `simulator`）。

长时间运行的动作不会“悄无声息”：`run_env_action` 会把最新命令输出（附带 ⏱
耗时计时）实时流式显示在工具行中；`/run` 每 10 秒更新一次运行状态
（`⏱ 名称: 已运行 1m 23s · <最后一行输出>`）；完成通知会包含总耗时。

## 工作原理

- 扫描 `.codex/environments/*.toml`（目录下所有 `.toml` 文件，不止
  `environment.toml`），从当前目录向上查找直到项目根目录——与 Codex 的解析方式一致。
- 使用轻量、零依赖的 TOML 子集解析器解析官方 Codex 格式：

```toml
version = 1
name = "web-app"

[setup]
script = ""

[[actions]]
name = "Run"
icon = "run"
command = "npm run dev"

[[actions]]
name = "Test"
icon = "test"
command = '''
cd frontend
bun test
'''
```

- 支持多行 `'''` 命令、`[setup]`/`[cleanup]` 表、行尾注释与字符串转义。
  无法识别的键/表会被忽略，损坏的文件会被跳过。
- 动作按名称去重（按字母序处理文件，先到先得）。
- 命令通过 `bash -lc` 在项目根目录（包含 `.codex/` 的目录）执行。

## 管理动作

`manage_env_action` 支持五个操作（参数：`operation`、`name`、`command`、
`icon`、`file`）：

| 操作 | 说明 |
|-----------|-------------|
| `list` | 列出 `.codex/environments/*.toml` 中所有动作，含来源文件、图标与命令 |
| `validate` | 静态校验：TOML 解析错误、缺少 `name`/`command`、重名（文件内和跨文件）、未知图标警告。绝不执行命令。 |
| `add` | 追加一个新的 `[[actions]]` 块（拒绝重名；`icon` 可选，默认无） |
| `update` | 按名称替换现有动作的 `command`/`icon`（不区分大小写；保留原名称大小写） |
| `remove` | 按名称删除动作块（不区分大小写） |

编辑是**块级精确**的：只重写目标 `[[actions]]` 块——文件中其他部分的注释、
顺序与格式都保持不变。默认写入 `environment.toml`；传 `file` 可指定同目录下
的另一个 `.toml`。变更后务必运行 `validate` 确认文件仍然有效。

## 环境要求

- 支持扩展的 pi（`@earendil-works/pi-coding-agent` 运行时）
- 带 `.codex/environments/*.toml` 的项目（由 Codex 生成或手写）

## 开发

```bash
node --test tests/parser.test.mjs   # 解析器单元测试
```

## 许可证

MIT
