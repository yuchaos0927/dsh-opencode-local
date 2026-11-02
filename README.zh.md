# dsh-opencode-local

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）中使用你自己机器上
[OpenCode](https://opencode.ai) 客户端的模型，包括**免费模型**，同时保持 DSH 自己的工具系统。

## 为什么需要这个插件

opencode.ai 的免费模型**只接受 OpenCode 客户端自己发出的请求**。官方文档写得很明确：

> Free-tier chat models are only available from within OpenCode. Other harnesses
> receive HTTP `403` for those models, even with a Console API key.
> — [opencode.ai/v2/docs/console/harnesses](https://opencode.ai/v2/docs/console/harnesses)

所以「让 DSH 直接请求 opencode.ai」这条路走不通，伪造请求头也只会拿到 `FreeUsageLimitError`。

## 本插件怎么做

**不伪造任何东西，直接复用你机器上已经装好的 OpenCode 客户端。**

```
DSH  →  本插件  →  127.0.0.1:<随机端口>  →  opencode serve（官方客户端）
                                                        ↓
                                                  免费模型 ✅
```

插件会：

1. 自动找到本机的 `opencode-cli`（跟随桌面版自动更新的版本目录，也会看 `PATH`）
2. 在**第一次真正用到模型时**启动 `opencode serve` 监听本地回环地址（不在 DSH 启动阶段启动，见下）
3. 读取启动时打印的随机密码，用 Basic Auth 认证
4. 把 DSH 的对话请求转成它的 `session/prompt` + `session/*` 事件流
5. 插件卸载时结束子进程，不残留端口

请求由**官方客户端自己发出**，因此符合上游策略。全程不经过公网代理，流量只到 `127.0.0.1`。

### 为什么不在启动时拉起服务

早期版本在插件 `apply()` 里就 spawn `opencode serve`，等于把一个**不受本插件控制的外部程序**
放进 DSH 的启动关键路径：它慢、它失败、它卡住，都会拖住甚至打断 DSH 的启动。

现在改为**懒启动**：DSH 启动阶段只做注册（adapter、provider 目录、模型发现），
一行子进程代码都不跑；等到你真的选了这个 provider 的模型、或模型选择器去列模型时，才拉起服务。

同时 `apply()` 整体包在守卫里并且会先归一化配置，因此插件**不可能**因为自身问题中断 DSH 启动，
也不会因为配置缺失而抛错。


## 工具调用怎么工作（重要）

OpenCode 本身是一个完整的 agent：它自己声明工具、自己执行工具，并且**不提供**让外部注入工具列表的接口。
DSH 的流式协议里也没有「工具已由提供方执行」这种语义，所以不能把工具当协议通道转发。

本插件采用**提示词层 function calling**：

```
1. 插件把 DSH 的工具 schema 渲染进 prompt
2. 模型需要工具时，输出一个 ```dsh-tool 围栏，内含 JSON 数组
3. 插件从流式文本中识别该围栏，转成原生 DSH tool-call 块
4. DSH 真正执行工具（权限、审批、skills 全部由 DSH 掌管）
5. 工具结果在下一轮以 Tool result 形式回传给模型
```

**好处**：DSH 的工具系统、权限控制、多轮编排保持原样，OpenCode 只当模型后端。

**代价**：依赖模型的指令遵循能力，而不是协议级 function calling。强模型遵循稳定；弱模型可能需要重试。

## 前置条件

- 已安装 **OpenCode 桌面版**（提供 `opencode-cli`），或 `opencode` 在 `PATH` 中
- macOS（路径发现目前按 macOS 桌面版布局实现）
- DSH `0.2.1-rc.2` 或更新的运行时

不需要：OpenCode 桌面版保持运行、OpenCode Go 订阅、Console API key。

## 安装

```sh
dsh plugin --profile desktop add /path/to/dsh-opencode-local
```

或手动在 profile 的 `package.json` 中加：

```jsonc
"dependencies": { "dsh-opencode-local": "link:/path/to/dsh-opencode-local" },
"dsh": { "profile": { "bundles": [ ..., "dsh-opencode-local" ] } }
```

然后重启 DSH，在模型选择器中选择 **OpenCode** 下的模型。

### 装完必须重启

装完请**完全退出 DSH 再重新启动**，然后再期待它工作。装进正在运行的 Host
并不可靠：安装可能返回 `application: failed`，错误是 `failed to import` /
`ERR_MODULE_NOT_FOUND`，指向一个明明已经装好的包。

实测过的一种情形：安装过程中运行时会把 `@deepseek-ai/*` 里的一部分包（如
`dsh-llm`、`cordis`）以软链方式指向一个临时目录，而那个目录在导入发生时可能已经
不在。此时插件本身已正确解包，只是当时那次导入失败了；**完全退出再启动**后即可正常加载。

判断是否真的生效，看插件条目的实际状态（`fiberPhase: "active"`），不要只看安装返回的
提示。我们这边就是安装报了 failed、重启后状态为 active 且没有产生任何崩溃。

另外：`~/.dsh/profiles/<name>/node_modules/@deepseek-ai/` 下出现悬空软链是这套安装
方式的**正常现象**（部分包在运行时由打包运行时直接提供，不经 profile）。**不要**去“修复”
这些软链——实测把 profile 的 `@deepseek-ai/*` 换成自建副本后，`llm`、`session`、
`settings` 等核心插件会一起加载失败。它们不影响插件工作。

## 配置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `providers` | `["opencode-local"]` | 本插件应答的 provider id。改了会让已保存的模型选择失效 |
| `cliPath` | 自动发现 | 手动指定 `opencode-cli` 路径 |
| `port` | `0`（自动） | 本地服务端口 |
| `directory` | 进程 cwd | 传给本地服务的工作目录 |
| `modelRefreshIntervalMs` | `600000` | 模型列表缓存时长 |
| `logLevel` | `warn` | `debug`/`info`/`warn`/`error`/`off` |
| `logDir` | `~/.dsh/logs/dsh-opencode-local` | 日志目录 |
| `logMaxBytes` / `logMaxFiles` | `524288` / `5` | 单个日志上限与保留份数 |

日志不会记录对话内容、工具参数或凭据。

## 测试

无需安装任何依赖——测试通过 stub 加载，克隆下来就能跑：

```sh
npm test
```

其中两个套件必须带 `--import ./test/loader.mjs`：否则运行时解析不到只存在于
DSH 安装内的 `@deepseek-ai/*` peer 依赖。`npm test` 已经带上了；单独跑时按下面写：

```sh
node --import ./test/loader.mjs --test test/startup.test.mjs
node --test test/local-service.test.mjs
node --import ./test/loader.mjs --test test/adapter.test.mjs
```

共 20 个测试，覆盖三块：

- **启动契约**（`test/startup.test.mjs`）：配置缺失/畸形不抛错、启动阶段不 spawn 任何进程、
  重复注册 adapter 时保持惰性、卸载时释放全部注册。
- **子进程生命周期**（`test/local-service.test.mjs`）：并发 `start()` 只拉起一个进程、
  `stop()` 真的回收进程、启动中崩溃会 reject 而不是假装就绪。
- **懒启动与适配器**（`test/adapter.test.mjs`）：首次列模型才启动服务，目录归一化正确。

这些测试用假 CLI 驱动，不需要安装 OpenCode。

## 已知限制

- **依赖本机 OpenCode CLI**。未安装时插件会报 `OpenCode CLI not found`（在首次使用时，不在启动时）。
- **免费额度是上游的限时策略，且有上限**。耗尽后免费模型返回空响应；可切到付费模型绕过。
- **暂无设置界面**。调整请改 profile 配置。
- **无工具调用的 GUI 卡片**。工具确实由 DSH 执行，但协议层不产生原生工具事件，界面可见性受限。
- **图片输入未在真实会话中验证**。底层（本地服务接受 data URL）已测通。

## 许可

MIT。`lib/logger.js`、`lib/logger.d.ts` 的部分代码派生自 MIT 许可的 `dsh-opencode-bridge`，
其版权声明保留在 [LICENSE](LICENSE) 中。插件其余部分（本地服务生命周期、提示词层工具协议、LLM 适配器）为本项目自有实现。
