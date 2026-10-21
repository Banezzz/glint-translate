# Chrome 应用商店上架指南

按 [Chrome Web Store 开发者控制台](https://chrome.google.com/webstore/devconsole) 的标签页顺序，逐个字段列出要填的内容。代码块里的文字可以直接复制粘贴。

控制台的字段名称偶尔会调整，以实际页面为准；有疑问时参考官方文档 [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)。

## 0. 准备

| 事项 | 说明 |
| --- | --- |
| 开发者账号 | 用 Google 账号登录控制台（需开启两步验证），支付一次性注册费 5 美元，填写开发者名称和联系邮箱并完成邮箱验证 |
| 交易商声明 | 个人免费发布、不收费也不做商业推广时，一般选「非交易商（non-trader）」 |
| 安装包 | 在仓库根目录运行 `npm run pack`，上传 `dist/glint-translate-v<版本号>.zip` |
| 隐私政策 | <https://banezzz.github.io/glint-translate/privacy.html>（源文件 `docs/privacy.html`，GitHub Pages 从 `main` 分支的 `docs/` 发布） |
| 素材 | `store/assets/`，可用 `npm run store:assets` 重新生成（见文末） |

上传后，插件名称和简短说明会从安装包的 `_locales` 自动读取，控制台里不能修改：

| 语言 | 名称 | 简短说明 |
| --- | --- | --- |
| 中文（简体） | Glint 划词翻译 | 划词翻译与网页双语对照翻译，接入你自己的 OpenAI / Claude 兼容大模型，自动识别接口协议与可用模型。 |
| English | Glint Translate | Translate selections and whole pages side by side with your own OpenAI / Claude compatible model. Detects the API and models. |

默认语言是中文（简体），由 `manifest.json` 的 `default_locale` 决定。

## 1. 商品详情（Store listing）

先在页面顶部的语言下拉中选「中文（简体）」填写一遍，再切到「English」填写英文版。详细说明和截图可以按语言分别设置。

### 详细说明 · 中文

```text
Glint 是一个简洁的翻译插件：选中网页上的文字，或者一键把整个网页翻译成双语对照，用的都是你自己的大模型。

【网页双语对照翻译】
· 点击页面右侧的悬浮球（或按 Alt+A），译文插在每一段原文下方，保留原网页的排版和字体
· 悬停悬浮球可在「原文 / 双语 / 仅译文」之间切换，切换不会重新请求模型
· 只翻译滚动到的段落，多段合并成一次请求并逐段回填，省时也省 Token
· 无限滚动、展开的菜单等后加载的内容也会自动翻译
· 自动跳过代码块、表单、文件名、域名以及已经是目标语言的段落

【划词翻译】
· 选中文本后点击小图标，原地弹出翻译卡片，译文逐字流式出现
· 选中单个外文单词时显示音标、词性释义和例句
· 原文已经是目标语言时，自动改译为第二语言
· 卡片可切换目标语言、复制、朗读、重新翻译、固定和拖动

【用你自己的模型】
· 支持 OpenAI 兼容和 Anthropic 兼容两种接口协议，云端服务和本机运行的模型都可以
· 粘贴地址和 Key 后自动识别接口协议、拉取可用模型
· 划词翻译、单词词典、网页翻译三类提示词都可以自定义

【界面】
· 浅色 / 深色 / 跟随系统，一键切换
· 简体中文和 English 两套界面
· 可以按网站关闭划词或隐藏悬浮球

【隐私】
· 没有自己的服务器，不含任何统计或追踪代码
· API Key 和设置只保存在本机浏览器
· 要翻译的文字只发送到你自己配置的 API 地址
· 开源：https://github.com/Banezzz/glint-translate

使用前需要准备一个大模型服务的 API 地址和 Key，或在本机运行的模型服务。
```

### 详细说明 · English

```text
Glint translates what you select, or a whole page side by side, with the language model you already use.

BILINGUAL PAGE TRANSLATION
• Click the floating ball on the right edge (or press Alt+A): each translation appears right below its paragraph, keeping the page's own layout and fonts
• Hover the ball to switch between Original, Bilingual and Translation only, without asking the model again
• Only paragraphs you scroll to are translated, several per request, filled in as they stream back
• Content loaded later, such as infinite scroll or opened menus, is translated too
• Code blocks, forms, file names, domains and text already in your language are skipped

SELECTION TRANSLATION
• Select text and click the small icon: a card opens in place and the translation streams in
• Select a single foreign word to get pronunciation, meanings and an example
• Text already in your target language is translated into your second language instead
• Change the target language, copy, read aloud, retranslate, pin and drag the card

YOUR OWN MODEL
• Works with OpenAI-compatible and Anthropic-compatible APIs, from cloud services to models running on your own computer
• Paste an endpoint and key; Glint detects the protocol and lists the models
• Customize the prompts for selections, dictionary entries and pages

INTERFACE
• Light, dark or system theme, one click away
• Chinese and English interface
• Turn off selection translation or hide the ball per site

PRIVACY
• No servers of our own, no analytics, no tracking
• Your API key and settings stay in this browser
• Text is sent only to the API endpoint you configure
• Open source: https://github.com/Banezzz/glint-translate

You need an API endpoint and key for a model service, or a model server running on your computer.
```

> 第一次提交（2026-10-21）因「产品说明中有过多关键字」被拒（违规参考 ID：Yellow Argon），原因是详细说明里逐个列出了各家模型服务的名字。现在的说明只写接口协议，不再罗列品牌名。以后修改说明时也不要堆砌服务名或关键词。

### 其余字段

| 字段 | 填写 |
| --- | --- |
| 类别（Category） | 效率 → 工具（Productivity → Tools） |
| 语言（Language） | 中文（简体）、English |
| 商店图标（Store icon，128×128） | `store/assets/store-icon-128.png` |
| 截图（1280×800，最多 5 张） | 中文：`store/assets/zh_CN/screenshot-1.png` … `screenshot-5.png`<br>English：`store/assets/en/screenshot-1.png` … `screenshot-5.png` |
| 小型宣传图块（Small promo tile，440×280） | `store/assets/zh_CN/promo-small.png` / `store/assets/en/promo-small.png` |
| 顶部宣传图块（Marquee promo tile，1400×560，选填） | `store/assets/zh_CN/promo-marquee.png` / `store/assets/en/promo-marquee.png` |
| 宣传视频（选填） | 留空 |
| 官方网址（Official URL，选填） | 留空。需要先在 Google Search Console 验证网站所有权，暂不需要 |
| 首页网址（Homepage URL） | `https://github.com/Banezzz/glint-translate` |
| 支持网址（Support URL） | `https://github.com/Banezzz/glint-translate/issues` |
| 成人内容（Mature content） | 不勾选 |

截图依次是：

1. 网页双语对照，悬浮球旁的「原文 / 双语 / 译文」切换
2. 仅译文模式
3. 划词翻译卡片
4. 深色模式（中文版带单词词典卡片）
5. 设置页与弹出面板

## 2. 隐私权（Privacy）

### 单一用途说明（Single purpose）

```text
用用户自己配置的大模型服务，翻译用户选中的文字和用户正在浏览的网页。
```

English：

```text
Translate text the user selects, and the web page the user is reading, with a language model service the user configures.
```

### 权限理由（Permission justification）

`storage`

```text
Saves the user's settings on this device: the API endpoint and key they enter, the chosen model, target language, theme, interface language and custom prompts. Nothing is synced or sent to the developer.
```

`contextMenus`

```text
Adds two context menu items: "Translate with Glint" for selected text, and "Translate this page / Show original" for the current page.
```

`scripting`

```text
Injects the extension's own bundled content scripts into tabs that were already open when the extension was installed or updated, and into a tab where the user invokes the context menu, shortcut or popup before the script has loaded, so translation works without reloading the page. The popup also uses it to read the text currently selected on the active page, to prefill the translation box. No remote code is executed.
```

主机权限（Host permissions，`<all_urls>`）

```text
Selection translation and whole-page translation must work on any website the user reads, so the content script runs on all sites. The extension also sends translation requests to an API endpoint that the user types in, which can be any host (a cloud provider, a self-hosted relay or a local server such as Ollama), so the endpoint cannot be listed in advance. Page text is read only when the user selects text or turns on page translation, and is sent only to the user's own endpoint.
```

### 远程代码（Remote code）

选「否，我不使用远程代码」（No, I am not using remote code）。扩展执行的全部代码都在安装包内。

### 数据使用（Data usage）

勾选以下两项：

- **网站内容（Website content）**：选中的文字、开启网页翻译后页面上的段落文字和标题，会发送到用户配置的 API 进行翻译。
- **身份验证信息（Authentication information）**：用户填写的 API Key 保存在本机，并随翻译请求发送给用户自己配置的 API。

其余类别（个人身份信息、健康、财务、个人通讯、位置、网络历史记录、用户活动）都不勾选。

再勾选页面下方的三项声明：

- 不会出售或转让用户数据给第三方（已批准的用例除外）
- 不会将用户数据用于与单一用途无关的目的
- 不会将用户数据用于确定信用状况或贷款目的

### 隐私权政策网址（Privacy policy URL）

```text
https://banezzz.github.io/glint-translate/privacy.html
```

## 3. 分发（Distribution）

| 字段 | 填写 |
| --- | --- |
| 付款 | 免费 |
| 公开范围 | 先选「不公开（Unlisted）」自己和朋友试用，确认没问题后改为「公开（Public）」；或直接选「公开」 |
| 地区 | 所有地区 |

## 4. 测试说明（Test instructions，选填）

审核员需要一个模型服务才能看到翻译效果。可以填：

```text
Glint needs a model service the user provides. Two ways to test:

1. Any OpenAI-compatible API key: open the extension's Settings, click the "OpenAI" preset, paste the key, and pick a model such as gpt-4o-mini once detection finishes.
2. Without a key: run Ollama locally (ollama run qwen2.5:7b), click the "Ollama" preset in Settings and pick the model.

Then select text on any page and click the small icon, or click the floating ball on the right edge to translate the whole page.
```

如果愿意提供一个限额的测试 Key，可以写在这里，审核会更顺利。

## 5. 提交

1. 「商品详情」「隐私权」「分发」三个标签页都显示已完成后，点右上角「提交审核」。
2. 申请了所有网站的访问权限，通常会进入更严格的人工审核，比一般插件多等几天，有时要一两周。
3. 被拒时，邮件里会写明违反的政策条款。按要求修改后重新上传、提交即可。

## 以后更新版本

1. 把 `manifest.json` 和 `package.json` 里的 `version` 同时改大（`npm run check` 会检查两者一致）。
2. 运行 `npm run pack`，在控制台的「软件包」标签页上传新的 zip，提交审核。
3. 界面有明显变化时，运行 `npm run store:assets` 重新生成截图，并在「商品详情」中替换。

## 重新生成素材

```bash
NODE_ENV=development npm run store:assets
```

脚本在本机启动一个模仿 Ollama 的演示服务（`127.0.0.1:11434`）和一篇演示文章，在无界面的 Chromium 中加载真实的插件后截图，不会访问外网。运行前需要关掉本机的 Ollama，因为两者使用同一个端口。演示文章和译文在 `scripts/store/showcase.mjs`。
