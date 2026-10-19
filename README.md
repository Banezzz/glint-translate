# Glint 划词翻译

一个简洁的 Chrome 划词翻译插件：选中网页上的文字，就用**你自己的大模型**翻译。支持任何 OpenAI 兼容或 Anthropic（Claude）兼容的接口，填好地址和 Key 后会自动识别接口协议、拉取可用模型。

<p>
  <img src="docs/images/card-light.png" alt="划词翻译卡片" width="560" />
  <img src="docs/images/card-dictionary-dark.png" alt="单词词典模式（深色）" width="300" />
</p>

## 功能

- **划词即译**：选中文本后出现小图标，点击即在原地弹出翻译卡片；也可以设成"选中直接翻译"或"仅快捷键 / 右键菜单"。
- **流式输出**：译文逐字出现，不必等整段生成完毕。
- **单词模式**：选中单个外文单词或短语时，显示音标、词性释义和例句。
- **智能方向**：原文已经是目标语言时，自动改译为第二语言（例如中文 → 英文）。
- **卡片操作**：切换目标语言、复制、朗读、重新翻译、固定、拖动，`Esc` 关闭。
- **自动检测接口**：粘贴根地址、`/v1` 地址或完整的 `/chat/completions`、`/messages` 地址都可以，Glint 会找到正确的 API 根路径并判断协议。
- **模型列表**：自动拉取并过滤掉 embedding、语音、图像等非对话模型，默认挑选速度快、成本低的模型，也可以手动输入任意模型名。
- **明暗主题**：跟随系统，或固定浅色 / 深色。
- **按网站禁用**：在弹出面板中一键关闭当前网站的划词。
- **兼容严格 CSP 的网站**：页面内 UI 用 Shadow DOM 隔离，不使用 `innerHTML`。

<p>
  <img src="docs/images/options-provider.png" alt="设置页：自动检测接口与模型" width="560" />
  <img src="docs/images/popup.png" alt="弹出面板" width="260" />
</p>

## 安装

1. 下载本仓库（`git clone` 或下载 zip 后解压）。也可以在 GitHub Actions 的 CI 运行结果里下载打包好的 `glint-translate-extension` 制品，解压后使用。
2. 打开 `chrome://extensions`，开启右上角的**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择仓库根目录（包含 `manifest.json` 的目录）。
4. 首次安装会自动打开设置页。

需要 Chrome 123 或更新版本（Edge 等 Chromium 内核浏览器同样可用）。

## 配置模型服务

在设置页的「模型服务」中：

1. 点击一个预设（OpenAI、Anthropic、DeepSeek、OpenRouter、Gemini、硅基流动、Ollama），或填写任意自定义地址。
2. 填入 API Key。本地模型（如 Ollama）可以留空。
3. 停止输入约 1 秒后自动检测，状态栏会显示协议、模型数量和延迟。
4. 在「模型」中选择或直接输入模型名。

「接口协议」默认为**自动检测**。如果某个中转服务同时支持两种协议，也可以手动固定为 OpenAI 兼容或 Anthropic 兼容。

### 自动检测是怎么工作的

1. **归一化地址**：补全协议（局域网和 localhost 用 `http`），去掉末尾的 `/chat/completions`、`/messages`、`/models` 等接口路径。
2. **候选根路径**：如果地址已经以版本段结尾（`/v1`、`/v4`、`/v1beta/openai` 等），就直接使用；否则同时尝试 `<地址>/v1` 和 `<地址>` 本身。
3. **探测模型列表**：对每个候选地址并行请求两次 `GET /models`，一次用 OpenAI 风格（`Authorization: Bearer`），一次用 Anthropic 风格（`x-api-key` + `anthropic-version`）。
4. **按响应形状判断协议**：Anthropic 的列表项带 `type: "model"`（列表还带 `has_more` / `first_id`），OpenAI 的列表是 `{ object: "list", data }`。只看哪个请求返回成功并不可靠，因为有些服务（如 OpenRouter）的模型列表不需要鉴权。两种协议都可用时，地址里含 `anthropic` / `claude` 就优先 Anthropic，否则优先 OpenAI。
5. **没有模型列表时**：向对话接口发送一个空请求体。返回 400 / 422 说明接口存在且 Key 有效（这种请求不会生成内容，也不计费），此时模型名需要手动填写。
6. **明确的错误提示**：Key 无效时会指出是哪种协议的接口，同时区分连不上、超时、限流和服务端错误。

## 使用

| 方式 | 说明 |
| --- | --- |
| 划词图标 | 选中文本 → 点击出现的 ✦ 图标 |
| 快捷键 | 默认 `Alt+T`（macOS 为 `⌥T`），可在 `chrome://extensions/shortcuts` 修改 |
| 右键菜单 | 选中文本后右键 →「用 Glint 翻译」 |
| 弹出面板 | 点击工具栏图标。打开时会自动带入当前页面选中的文字 |

## 隐私

- API 地址、Key 和偏好设置只保存在本机的 `chrome.storage.local` 中，不会同步到云端。
- 选中的文本只会发送到你配置的 API 地址，插件没有任何统计或第三方请求。
- 插件需要访问所有网站，原因有两个：在任意页面上划词，以及请求你自定义的 API 地址。

## 开发

```bash
npm ci                    # 安装 ESLint 与 Playwright
npm run lint              # ESLint
npm run check             # 校验 manifest 和页面、模块引用的文件都存在
npm test                  # 单元测试（node:test）
npx playwright install chromium
npm run e2e               # 在真实 Chromium 中加载插件，对接本地 mock 接口
npm run pack              # 打包到 dist/glint-translate-v<version>.zip
npm run mock              # 启动 mock OpenAI / Anthropic 接口（端口 8787），用于手动调试
npm run icons             # 重新生成图标
```

项目没有构建步骤，源码就是插件本身，改完在 `chrome://extensions` 中点「重新加载」即可。E2E 截图保存在 `.e2e-artifacts/`，设置 `HEADED=1` 可以看到浏览器窗口。

### 目录结构

```
manifest.json
src/
  background/service-worker.js   流式翻译端口、右键菜单、快捷键、语言识别与缓存
  content/                       划词图标与翻译卡片（Shadow DOM，经典脚本）
  options/                       设置页：接口检测、模型选择、偏好、试一试
  popup/                         工具栏弹出面板
  shared/
    providers.js                 地址归一化、协议检测、模型列表
    translator.js                OpenAI / Anthropic 请求构建与 SSE 流解析
    prompt.js  lang.js           提示词、语言识别与目标语言选择
    settings.js                  设置的默认值、读写和生效配置
    languages.js dictionary.js   同时供内容脚本与 ES 模块使用的共享数据和解析器
  ui/                            扩展页面共用的样式与工具函数
test/unit/                       单元测试
test/e2e/                        Playwright 端到端测试与 mock 接口
```
