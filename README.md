# AI Chat —— 部署在 Cloudflare Workers 上的 Web 版 AI

一个 ChatGPT 风格的对话应用，整个后端就是一个 Worker + 一个 R2 桶。
**在 Cloudflare 控制台连接 GitHub 部署时，R2 会自动创建、自动绑定**，你只需要填三个环境变量。

- 前端：单页应用，零外部依赖（不引任何 CDN），浅色/深色主题，移动端适配
- 后端：Cloudflare Worker，SSE 流式转发到任意 **OpenAI 兼容** 接口
- 存储：Cloudflare R2，存会话列表与全部对话历史
- 流式：逐字返回；中途点「停止」时已生成的部分也会落盘

![浅色](screenshots/03-对话完成-浅色.png)

---

## 一、准备三个环境变量

| 变量 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `API_URL` | ✅ | 上游接口地址（OpenAI 兼容） | `https://api.openai.com/v1` |
| `API_KEY` | ✅ | 上游密钥，**建议存为 Secret** | `sk-...` |
| `MODEL` | | 默认模型，不填为 `gpt-4o-mini` | `deepseek-chat` |
| `MODELS` | | 下拉框里的模型列表，逗号分隔 | `deepseek-chat,deepseek-reasoner` |
| `SYSTEM_PROMPT` | | 系统提示词 | `You are a helpful assistant.` |
| `SITE_TITLE` | | 页面标题 | `我的 AI` |
| `ACCESS_PASSWORD` | | 访问密码。**设了就必须先输密码**，不设则完全公开 | `my-secret` |

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

### 方式 A：控制台连接 GitHub（推荐，自动创建 R2）

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

### 方式 B：本地 CLI

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

### 部署前自检

```bash
npm run check
```

输出里应该能看到 `env.CHAT_BUCKET  R2 Bucket`，说明绑定配置被正确接受。

---

## 三、目录结构

```
├── wrangler.jsonc          部署配置（R2 自动创建的关键就在这里）
├── package.json
├── src/index.js            Worker 后端：路由、R2 读写、SSE 流式转发
├── public/index.html       前端单页（HTML + CSS + JS 全在一个文件里）
├── screenshots/            界面截图
└── .dev.vars.example       本地开发的环境变量模板
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

**想换用别的模型服务商**
只要对方兼容 OpenAI 的 `/chat/completions` 协议（DeepSeek、Kimi、通义、智谱、OpenRouter、硅基流动等），
改 `API_URL` + `API_KEY` + `MODEL` 三个变量即可，代码不用动。
