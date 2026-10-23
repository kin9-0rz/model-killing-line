---
name: omp-roles-autogen
description: "Use when the user asks to auto-configure omp model roles, regenerate modelRoles/fallbackChains/modelPresets from the 模型斩杀线 (AA/DeepSWE) leaderboards plus personal preferences (domestic-only, vendor exclusions, min token speed). Runs gen-roles.mjs; writes ~/.omp/agent/config.yml by default, --dry-run prints the diff."
---

# omp-roles-autogen

一条命令把「模型斩杀线」的数据（Artificial Analysis Intelligence Index +
DeepSWE PASS@1）和本机 `omp models --json` 目录对齐，按固定规则给 omp 的
11 个 Chat 角色各选一个模型，生成三块配置写进全局 `config.yml`：
`modelRoles`、`retry.fallbackChains`、`modelPresets`（快照，不动用户已用的
默认配置——`modelPresets` 只增不删）。

选型全部由脚本定案（纯规则，无需 LLM 判断），stdout 永远打印逐角色依据表，
用户想换取向就调参数重跑，而不是手改 YAML。

## Core loop

```bash
node .agents/skills/omp-roles-autogen/scripts/gen-roles.mjs \
  --domestic --exclude xiaomi --min-speed 60 --dry-run
```

去掉 `--dry-run` 才落盘。脚本自己负责数据时效：
`<dir>/aa-data.json`、`<dir>/data.json` 缺失或 mtime ≥ 24h 时，用
`MKL_DIR=<dir>` 子进程调用 `model-killing-line` 技能的 `fetch-aa.mjs` / `fetch.mjs`
（不 import，不改它们的契约）；`<dir>/omp-models.json` 不存在时才跑一次
`omp models --json` 缓存下来。fetch 失败 → 直接报错退出，**不拿旧数据硬选**。

`<dir>` 默认 `os.tmpdir()/model-killing-line`（与 `MKL_DIR` 同址），`--dir` 可换。

## 参数

| 参数 | 含义 |
|---|---|
| `--domestic` | 只在国产 creator 里选（DeepSeek / Alibaba / Z AI / Kimi / MiniMax / StepFun / Xiaomi / Tencent …） |
| `--exclude <a,b,...>` | 排除 creator，大小写不敏感，可重复出现（`--exclude xiaomi --exclude kimi` 等价于逗号写法） |
| `--min-speed <tok/s>` | AA 中位输出速度下限（默认 0＝不过滤；AA 显示 `--` 的行按 `-Infinity`，任何 >0 的下限都会过滤掉它） |
| `--preset <name>` | `modelPresets` 里的快照名，默认 `autogen-YYYYMMDD`（当天重跑＝覆盖同名快照，幂等） |
| `--dry-run` | 不写任何文件，打印将替换/新增的块全文 |
| `--dir <path>` | 榜单数据目录（默认 `os.tmpdir()/model-killing-line`） |
| `--out <path>` | `omp models --json` 缓存文件（默认 `<dir>/omp-models.json`） |

配置目标：`$OMP_AGENT_DIR/config.yml`，未设 `OMP_AGENT_DIR` 时为
`~/.omp/agent/config.yml`。`--profile` 场景需自己把 `OMP_AGENT_DIR` 指到该 profile。

## 选型规则（写死在脚本里，改规则改脚本）

- 候选池：AA 行（Index > 20 且 Cost 非空，fetch 已过滤）→ 去掉尾部 effort 括号段
  和日期串（`1017`、`(0902)`）后的名字与本机目录 `name` 匹配（全等优先，其次唯一包含；
  同名多行按「`models.yml` 里配了的 provider → id 更短 → `smartbrain/` 前缀」择一）；
  全等/唯一包含都失败（含多义）的 AA 行进 skipped 名单，不猜。
  creator 匹配大小写不敏感且 `-`/`_` 等同空格（`--exclude z-ai` 命中 AA 的 `Z AI`）。
- 评分 `score = index - 40 * ln(1 + cost / 0.05)`：智力为主，成本对数惩罚。
- 角色：`default` 最高 score；`slow`/`plan` 取 DeepSWE PASS@1 最高（同分取 DS avg cost 低）；
  `task` 取 PASS@1 ≥ 50 里 DS avg cost 最低；`smol`/`memory` 跟 default 但 thinking 取 `low`；
  `vision` 取有图像输入里 score 最高；`commit`/`tiny`/`widget` 取「其余角色没占用」里最便宜的；
  `advisor` 取与 default 不同 creator 里 score 最高。
- thinking 后缀：多数角色取模型 `thinking` 数组最高档；`smol`/`memory`/`commit` 取 `low`
  （无 `low` 档取第一档）；`tiny`/`widget` 取第一档；数组为空则不加后缀。
- `retry.fallbackChains`：每角色一条单元素链，优先「不同 creator 且没被任何角色占用」的
  最高 score，其次全池非自身最高 score；都选不出来就不写该角色的链。
- 同一模型在 AA 有多个 effort 变体（`GLM-5.3 (max)` / `(low)`）时按 selector 去重，
  保留 index 最高的一行。

## 输出与写入

1. stdout：`角色 | selector | AA index | AA cost | tok/s | DS pass | 规则命中` 表 +
   skipped（AA 行匹配不到目录模型）名单 + `UNRESOLVED`（池空导致无解）角色。
   **把这份表转述给用户**，并说明可调参数（`--domestic` / `--exclude` / `--min-speed` / `--preset`）。
2. `config.yml`：只重写 `modelRoles:` 整块、`retry:` 下的 `fallbackChains:` 子块、
   `modelPresets:` 下同名快照；其余键（缩进、注释、顺序）逐字保留。写回前按顶层键粗
   解析校验（原有顶层键一个不能少、目标三块都在），校验失败不落盘并退出 1。
   选中的模型若来自 `models.yml` 没配的 provider（内置 provider、没 key），stderr 打 warning。
3. `--dry-run` 只打印「将替换 / 将新增」的块全文。

## 完成判据

- stdout 的 11 角色表里没有 `UNRESOLVED`（除非候选池确实被参数筛空，此时脚本仍退出 0
  并在报告里明示）。
- 真写之后 `omp config get modelRoles` / `omp config get retry.fallbackChains` /
  `omp config get modelPresets` 都能解析，`modelPresets` 里用户原有快照仍在。
- 同参数再跑一次 `--dry-run`，diff 为空（幂等）。

## 注意

- omp 会话运行中也可能写 `config.yml`（设置面板）；脚本是整文件替换，建议在 omp 空闲时跑。
  不做文件锁，靠「顶层键粗解析校验」防写坏。
- AA 页面改版导致 `fetch-aa.mjs` 抛错时，本技能不修 fetch 脚本（那是 model-killing-line
  技能的契约），错误信息里照抄即可 —— 先修 `fetch-aa.mjs` 再跑本技能。
- AA 名字与本机目录名对不上（全等 / 唯一包含都失败）时该行直接弃用并进 skipped，不猜；
  主流模型被大面积 skip 时先看 skipped 名单是不是目录命名变了。
