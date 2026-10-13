# AI Chat —— 部署在 Cloudflare Workers 上的 Web 版 AI


一个 ChatGPT 风格的对话应用，整个后端就是一个 Worker + 一个 R2 桶。
**部署时 R2 会自动创建、自动绑定**，你只需要填三个环境变量。

- 前端：单页应用，零外部依赖（不引任何 CDN），浅色/深色主题，移动端适配
- 后端：Cloudflare Worker，SSE 流式转发到任意 **OpenAI 兼容** 接口
- 存储：Cloudflare R2，存会话列表与全部对话历史
- 流式：逐字返回；中途点「停止」时已生成的部分也会落盘
- 消息操作用内联 SVG 图标（复制 / 重新生成），复制成功会变成对勾

> 👆 点上面这个按钮，Cloudflare 会自动克隆仓库、创建并绑定 R2、构建部署，全程不用碰命令行。
> 详细说明见 [「二、部署」](#二部署)。


---

## 一、准备三个环境变量

| 变量 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `API_URL` | ✅ | 上游接口地址（OpenAI 兼容） | `https://api.openai.com/v1` |
| `API_KEY` | ✅ | 上游密钥，**建议存为 Secret** | `sk-...` |
| `MODEL` | | 默认模型，不填为 `gpt-4o-mini`。**支持自定义显示名** | `deepseek-chat:DeepSeek V3` |
| `MODELS` | | 下拉框里的模型列表，逗号分隔。**每项都支持自定义显示名** | `deepseek-chat:DeepSeek V3,deepseek-reasoner:DeepSeek R1` |
| `SYSTEM_PROMPT` | | 系统提示词 | `You are a helpful assistant.` |
| `SITE_TITLE` | | 页面标题 | `我的 AI` |
| `ACCESS_PASSWORD` | | 访问密码。**设了就必须先输密码**，不设则完全公开 | `my-secret` |

### 给模型起自定义名字

`MODEL` 和 `MODELS` 的每一项都支持 `模型id:显示名` 的写法。**提交给上游接口的始终是真实模型 id，
只有界面上显示的是你起的名字**：

```
MODELS=deepseek-chat:DeepSeek V3,deepseek-reasoner:DeepSeek R1,gpt-4o:GPT-4o
```

效果：下拉框里显示 `DeepSeek V3` / `DeepSeek R1` / `GPT-4o`，鼠标悬停能看到真实 id，
底部提示会同时给出两者（`模型：DeepSeek V3（deepseek-chat）`）。

等号 `=` 和冒号 `:` 都行，两者同时出现时**以 `=` 为准**。之所以两种都支持，是因为模型 id 本身可能含冒号 ——
比如 Ollama 的 `llama3:8b`，这种情况请用等号写：

```
MODELS=llama3:8b=Llama 3 8B,qwen2.5:7b=Qwen2.5 7B
```

其它细节：

- 没写显示名时，显示名就等于 id（`MODELS=gpt-4o-mini` 显示成 `gpt-4o-mini`）
- 显示名留空会自动回退成 id（`MODELS=a:` → 显示 `a`）
- 按 id 去重，重复时保留第一个显示名
- 选中的模型记在浏览器本地，刷新后还记得
- 接口只会接受 `MODELS` 里出现过的模型 id，传别的会回退到默认模型，避免有人拿你的 Key 调更贵的模型

`API_URL` 的写法很宽松，下面这些都能正确识别：

```
https://api.openai.com                    → https://api.openai.com/v1/chat/completions
https://api.openai.com/v1                 → https://api.openai.com/v1/chat/completions
https://api.deepseek.com                  → https://api.deepseek.com/v1/chat/completions
https://api.deepseek.com/v1/chat/completions  → 原样使用
https://openrouter.ai/api/v1              → https://openrouter.ai/api/v1/chat/completions
```

---

## 二、部署

### 方式 A：一键部署按钮（推荐，全程不用碰命令行）

**前提**：本项目代码必须已经推到一个 **公开的** GitHub 或 GitLab 仓库 ——
Cloudflare 的部署按钮不支持私有仓库，也不支持自建 Git 服务。

本项目的仓库地址：<https://github.com/jinhuaitao/Ai-Chat>

**直接点这个按钮：**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jinhuaitao/Ai-Chat)

> 💡 如果你 fork 或搬运到了别的仓库，把按钮链接里的 `?url=` 后面换成你自己的仓库地址即可；
> 也可以部署过一次后，去控制台该 Worker 的详情页点「分享」按钮，直接复制 Cloudflare 官方生成的片段。

**点下去之后，四步走完**

| 步骤 | Cloudflare 会做什么 | 你需要做什么 |
| --- | --- | --- |
| 1. 克隆仓库 | 把项目复制一份到你自己的 GitHub/GitLab 账号下（之后可以在自己仓库里继续改） | 授权 GitHub App |
| 2. 配置项目 | 显示 Worker 名称、仓库名、**R2 桶名** | 想改就改，不改用默认值 |
| 3. 填写变量 | 读取仓库里的 `.dev.vars.example`，自动生成 `API_URL` / `API_KEY` / `MODEL` 三个填写框，并加密存为 Secret | 把 `API_KEY` 换成你自己的 |
| 4. 构建部署 | 跑 `npm install` → `npx wrangler deploy`，**自动创建 R2 桶并绑定**，然后返回一个可访问的地址 | 等它跑完，点开就能用 |

全程不用提前去控制台建 R2，也不用配绑定 —— Cloudflare 会读 `wrangler.jsonc` 自己搞定。

> ⚠️ **首次使用 R2 的账号，请先手动开通一次 R2**（Dashboard → R2 页面 → 点一次同意条款）。
> 否则自动创建桶会失败，这是这类部署最常见的失败原因。

部署完成后想换模型、加访问密码、换服务商，去 **Dashboard → 该 Worker → Settings → Variables and Secrets**
改完再重新部署一次即可。

### 方式 B：控制台连接 GitHub（手动版）

和方式 A 等价，只是自己填一遍配置：

1. 把本项目推到一个 GitHub 仓库。
2. 打开 **Cloudflare Dashboard → Workers & Pages → Create → Workers → Connect to Git**，选中该仓库。
3. 构建配置按下表填写：

   | 配置项 | 值 |
   | --- | --- |
   | Project name | **必须与 `wrangler.jsonc` 里的 `name` 完全一致**（默认 `ai-chat-worker`） |
   | Build command | `npm install` |
   | Deploy command | `npx wrangler deploy` |

4. 部署完成后，去 **Settings → Variables and Secrets** 添加 `API_URL`、`API_KEY`（点 **Encrypt** 存成 Secret）、`MODEL` 等，然后重新部署一次让变量生效。

R2 桶不需要你手动创建 —— `wrangler.jsonc` 里写的是：

```jsonc
"r2_buckets": [{ "binding": "CHAT_BUCKET" }]   // 故意不写 bucket_name
```

**绑定里不写 `bucket_name`，Cloudflare 就会在部署时自动创建并以 Worker 名称为前缀命名，然后自动绑定。**

> ⚠️ **两个必须知道的坑**
>
> 1. **首次使用 R2 的账号必须先手动开通一次 R2**（Dashboard → R2 → 点一次同意条款）。
>    否则自动创建 bucket 会失败，这是最常见的部署失败原因。
> 2. **通过 Dashboard 部署时，资源会被创建，但 ID 不会写回仓库。** 以后如果改用本地 `wrangler deploy`，
>    要先去 Dashboard 把桶名复制回来填进 `bucket_name`，否则 wrangler 会当成「没配」再创建一套新的，
>    你会以为「线上数据丢了」。

### 方式 C：本地 CLI

```bash
npm install
npx wrangler login
npx wrangler secret put API_KEY     # 密钥走 Secret
npx wrangler deploy                 # 首次部署会自动创建 R2 并绑定，并把桶名写回配置
```

`API_URL` / `MODEL` 这类非密钥可以 `npx wrangler secret put API_URL`，
也可以取消 `wrangler.jsonc` 里 `vars` 的注释后直接写进去。

### 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入真实值，该文件已被 .gitignore 忽略
npm run dev                      # http://localhost:8787
```

本地 `wrangler dev` 会自动创建一个**本地**的 R2（存在 `.wrangler/` 目录），不会碰线上数据。

> 📌 `.dev.vars.example` 不只是给本地开发用的 —— **「Deploy to Cloudflare」按钮会读它**，
> 按里面的变量名在部署页生成填写框。所以这个文件请保持 dotenv 格式，变量名别写错。

### 部署前自检

```bash
npm run check
```

输出里应该能看到 `env.CHAT_BUCKET  R2 Bucket`，说明绑定配置被正确接受。

---

## 三、目录结构

```
├── wrangler.jsonc          部署配置（R2 自动创建的关键就在这里）
├── package.json            含 cloudflare.bindings，给部署页的变量加说明文案
├── src/index.js            Worker 后端：路由、R2 读写、SSE 流式转发
├── public/index.html       前端单页（HTML + CSS + JS 全在一个文件里）
├── screenshots/            界面截图
└── .dev.vars.example       本地开发变量模板 + 部署按钮的变量清单
```

R2 里的数据结构：

```
index.json          会话列表（侧边栏一次读取，不用遍历）
conv/<id>.json      单个会话，含全部消息
sess/<token>.json   登录会话（仅在设置了 ACCESS_PASSWORD 时使用）
login_fail/<ip>.json 登录失败限流记录
```

---

## 四、接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 聊天页面 |
| GET | `/api/config` | 站点配置（是否需要登录、可用模型）。未登录返回 `401` |
| POST | `/api/login` | 校验访问密码，成功下发 HttpOnly Cookie |
| POST | `/api/logout` | 退出登录，服务端立即吊销 token |
| GET | `/api/conversations` | 会话列表 |
| POST | `/api/conversations` | 新建会话 |
| GET | `/api/conversations/:id` | 读取会话（含全部消息） |
| PATCH | `/api/conversations/:id` | 重命名 |
| DELETE | `/api/conversations/:id` | 删除 |
| POST | `/api/chat` | 发消息，`text/event-stream` 流式返回 |

`GET /api/config` 的返回（`models` 是 `{id, label}` 数组，前端用它渲染下拉框）：

```json
{
  "needsAuth": false,
  "authed": true,
  "title": "AI Chat",
  "models": [
    { "id": "deepseek-chat", "label": "DeepSeek V3" },
    { "id": "deepseek-reasoner", "label": "DeepSeek R1" }
  ],
  "defaultModel": "deepseek-chat",
  "endpointHost": "api.deepseek.com"
}
```

`/api/chat` 的 SSE 事件：

```
data: {"type":"meta","conversationId":"...","title":"...","model":"..."}
data: {"type":"delta","text":"你"}
data: {"type":"delta","text":"好"}
data: {"type":"done","conversationId":"...","title":"...","messageCount":2}
```

---

## 五、实现上的一些取舍

- **访问密码是可选的。** 不设置 `ACCESS_PASSWORD` 时接口完全公开 —— 任何人拿到链接都能消耗你的 API 额度。
  公开分享的地址强烈建议设上。密码用 SHA-256 比对（恒定时间），登录失败按 IP 限流（10 分钟内 8 次）。
- **登录态不跳转。** 未登录时 `/` 照常返回页面，由前端调 `/api/config` 拿到 401 后弹出登录层。
  这样 API 永远不会返回 HTML，前端 `res.json()` 不会解析到一坨 HTML 再被 catch 吞掉。
- **流式中断也保存。** 点「停止」或关闭页面时，Worker 的 `TransformStream.cancel` 会把已生成的部分写入 R2，
  刷新后还能看到，并能从最后一条消息「重新生成」。
- **用户消息先落盘再请求上游。** 上游挂了也不会丢用户输入。
- **前端渲染全部走 `createElement` + `textContent`**，Markdown 渲染器先做 HTML 转义再套用格式，
  `javascript:` 之类的伪协议链接不会被转换成 `<a>`。
- **图标全部是手写内联 SVG**，不引 FontAwesome / iconfont 之类的图标库 —— 保持零外部依赖，
  同时用 `stroke="currentColor"` 让图标自动跟随主题色。图标按钮的 `title` 和 `aria-label` 都写全，
  鼠标悬停能看懂、读屏软件也能读出来。
- **无任何外部 CDN 依赖**，离线也能打开界面，也不受第三方 CDN 可用性影响。

## 六、常见问题

**部署成功但打开是 500，提示 `binding_missing`**
R2 绑定没生效。检查 `wrangler.jsonc` 里 `r2_buckets` 的 `binding` 是否叫 `CHAT_BUCKET`，然后重新部署。

**自动创建 R2 失败**
先确认账号已开通 R2（Dashboard → R2 页面点一次同意条款）。若仍失败，改为手动建桶并把 `bucket_name` 填进配置。

**发消息提示「上游接口返回 401」**
`API_KEY` 不对，或者 `API_URL` 指错了服务商。检查 Variables and Secrets 里变量名有没有拼错。

**模型下拉框是空的 / 只有一个**
`MODELS` 没配时会退化成只有 `MODEL` 一个。想看多个模型就配 `MODELS=a,b,c`。

**配了显示名但下拉框里还是原始 id**
检查分隔符。`MODELS=deepseek-chat:DeepSeek V3` 应该显示成 `DeepSeek V3`。
如果模型 id 本身含冒号（例如 Ollama 的 `llama3:8b`），程序会误把 `llama3` 当 id，这种情况请用等号：
`MODELS=llama3:8b=Llama 3 8B`。

**下拉框里显示的名字对了，但请求报「模型不存在」**
说明 id 写错了。鼠标悬停在下拉框选项或顶部标签上可以看到实际提交的 id，底部提示也会同时显示
`模型：显示名（真实id）`，照这个 id 去核对服务商文档即可。

**想换用别的模型服务商**
只要对方兼容 OpenAI 的 `/chat/completions` 协议（DeepSeek、Kimi、通义、智谱、OpenRouter、硅基流动等），
改 `API_URL` + `API_KEY` + `MODEL` 三个变量即可，代码不用动。

**点了部署按钮没反应 / 提示找不到仓库**
仓库必须是**公开**的 GitHub 或 GitLab 仓库。私有仓库、自建 Git、以及非 GitHub/GitLab 的仓库都不支持。

**部署页上没有出现变量填写框**
Cloudflare 是靠读取仓库根目录的 `.dev.vars.example` 来生成填写框的，确认这个文件存在且是 dotenv 格式
（`KEY=value`，一行一个，变量名不要改）。实在没有也可以在部署完成后去
**Settings → Variables and Secrets** 手动加。

**部署页上的构建命令是空的**
`package.json` 里已经有 `build` 和 `deploy` 两个脚本，Cloudflare 会自动读出来预填
（`npm install` / `wrangler deploy`）。如果没读到，手动填上这两个即可。

**想改部署页上变量填写框旁边的说明文案**
改 `package.json` 里的 `cloudflare.bindings` 字段，支持 `code`、**加粗**、[链接](https://example.com) 这类内联 markdown。
