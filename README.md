# 机器人工作台

一间像素办公室。四个机器人是像素小人，头上有名字和状态。

图来自开源项目 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)（MIT 许可）。这一版只用它自带的角色和家具，没有新画的图。

## 本地运行

需要 Node.js 20 或更新。

```bash
npm install
npm run dev
```

浏览器打开 http://127.0.0.1:43123 。

打包成静态文件（可以放到 GitHub Pages）：

```bash
npm run build
npm run preview
```

构建结果在 `dist/`。脚本和图片都是相对路径，放在仓库子目录里也能打开。

检查事件解析和状态更新：

```bash
npm test
```

`npm run check` 会再跑一遍测试、打包，并用无头浏览器看办公室。

## 部署

这一版是静态网站。线上没有 `POST /events`。要让机器人继续说话，把新行写进 `data/events.jsonl` 再发布，或者把事件地址指到一个允许本站读取的文件。

### GitHub Pages

仓库里有 `.github/workflows/pages.yml`。推到 `main` 之后，到仓库的 Settings → Pages，Source 选 GitHub Actions。工作流会执行 `npm ci` 和 `npm run build`，把 `dist/` 发布出去。

项目页（地址里带仓库名）也可以，因为资源用的是相对路径。

### Netlify

`netlify.toml` 已经写好：构建命令是 `npm run build`，发布目录是 `dist`。把仓库连上 Netlify 即可。

### Vercel

`vercel.json` 同样指定 `npm run build` 和 `dist`。导入仓库时按 Vite 静态站点发布。

### 换事件地址

优先级是：

1. 地址栏里的 `?feed=https://example.com/events.jsonl`
2. 页面上改过并保存的地址（只存在这台浏览器里）
3. `data/config.json` 里的 `feed`
4. 站点自己的 `data/events.jsonl`

`feed` 留空就用第 4 种。对方的服务器要允许这个网页去读（CORS）。读失败时，右上角会变成「连接失败」，办公室先留着上次的画面。某一行不是 JSON、编号重复，不会把整份记录清掉。消息列表最多留 40 条。

## 状态文件

编辑 `data/status.json`，然后点页面上的「重新读取」，或者刷新。

```json
{
  "demo": false,
  "updatedAt": "2026-10-13T15:34:00.000Z",
  "bots": [
    {
      "id": "lead",
      "name": "总工程师",
      "role": "lead",
      "status": "working",
      "palette": 0,
      "activity": "在看这一版办公室"
    }
  ],
  "messages": [
    {
      "id": "msg-seed-1",
      "from": "lead",
      "to": "frontend",
      "text": "四个名字先用这版。",
      "time": "2026-10-13T15:33:10.000Z"
    }
  ]
}
```

`bots` 里要有这四个人：`lead`（总工程师）、`frontend`（前端开发）、`integration`（集成开发）、`qa`（测试员）。

每个人：

| 字段 | 含义 |
| --- | --- |
| `id` | `lead`、`frontend`、`integration`、`qa` 之一 |
| `name` | 头上显示的名字 |
| `role` | 面板上的职责，这一版只是文字 |
| `status` | `idle` 空闲，`working` 工作中，`waiting` 等待 |
| `palette` | `0` 到 `5`，对应默认角色 `char_0.png` 到 `char_5.png` |
| `activity` | 现在在做什么，短句，可以是空字符串 |

`working` 时小人坐在桌前打字，电脑屏幕会亮。`idle` 时站着，偶尔侧一下头。`waiting` 时看着你，头上有「等一下…」。

`status.json` 里的 `messages` 只是事件流读不到时的备用。平时以 `data/events.jsonl` 为准。

## 事件流

`data/events.jsonl` 是追加文件：一行一条 JSON。页面默认每 2.5 秒拉一次，已经见过的 `id` 不会再放一遍。同一份文件里如果 `id` 重复，只认第一条。某一行坏了就跳过，其他行照常收。第一次读到的旧消息只进右侧记录，不飞信封。文件很长时，页面只解析最近 200 行，列表里只留最近 40 条。

也可以是一个 JSON 数组，字段一样。右上角的圆点是连接状态：绿色是已连接，黄色是有行读不了，红色是连接失败。

消息：

```json
{"id":"evt-1","type":"message","from":"frontend","to":"qa","text":"首页改完了。","time":"2026-10-13T08:00:00.000Z"}
```

| 字段 | 含义 |
| --- | --- |
| `id` | 这条事件的编号。不写的话，页面会用内容自己编一个，同一次文件里保持不变 |
| `type` | `message` |
| `from` / `to` | 谁发给谁。可以写 `frontend`，也可以写 `前端开发` |
| `text` | 说了什么 |
| `time` | ISO 时间。页面按上海时间显示 |

状态：

```json
{"id":"evt-2","type":"status","bot":"qa","status":"working","activity":"在看首页","time":"2026-10-13T08:00:01.000Z"}
```

`status` 只能是 `idle`、`working`、`waiting`。

新的消息会做三件事：发送者头上冒出短句，一封洋红信封从他飞到对方，对方变成工作中。

## 机器人怎么上报

开发时，页面开着（`npm run dev`），用命令追加一行：

```bash
npm run post -- --from 前端开发 --to 测试员 --text "首页改完了，你看一下。"
```

改状态：

```bash
npm run post -- --type status --bot 测试员 --status working --activity "在看首页"
```

名字可以用中文，也可以用 `lead`、`frontend`、`integration`、`qa`。几秒后办公室会自己出现。

同一个开发服务器还收 `POST /events`。外面的进程可以这样推：

```bash
curl -X POST http://127.0.0.1:43123/events \
  -H 'content-type: application/json' \
  -d '{"type":"message","from":"前端开发","to":"测试员","text":"首页改完了，你看一下。"}'
```

这个接口只在 `npm run dev` 或 `npm run preview` 里有。放到 GitHub Pages 上没有服务器，就把新行写进 `data/events.jsonl` 再发布，或者把「事件地址」指到你自己托管的文件。

## 重放接力

`data/relay.jsonl` 是一次固定的传话：前端开发 → 集成开发 → 测试员 → 总工程师。点「重放接力」会按这个顺序再放一遍，信封和记录都能看见。再点一次会重来。

## 演示模式

`demo` 为 `true` 时，页面每隔几秒自己改一个人的状态，并飞一封示例消息。改成 `false` 就只跟事件流走。现在默认是关的。

页面上的开关只影响这一次打开，不改文件。关掉只是停止假数据，不清已经收到的事件。点「重新读取」会按 `status.json` 和事件流再来一遍。

## 以后的桌面和手机壳

现在不打包 Tauri、Electron 或 Capacitor。页面已经按能放进这些壳里来写。

- 解析和状态在 `src/feed.ts`，不画画面，也不自己发请求。
- 事件从 `src/source.ts` 的 `FeedSource` 进来。现在是 HTTP 轮询（`pull`）。以后的 WebSocket，或壳里的原生桥，实现同一个接口，用 `subscribe` 推一整份文本即可，不用改办公室。
- 壳可以在页面加载前设置 `window.__WORKBENCH_SOURCE__`，或在加载后调用 `window.workbench.useFeedSource(source)`。
- 图片和数据用相对路径（`./assets/...`、`./data/...`），不写死域名或端口。webview 用自己的地址打开 `dist/` 即可。
- 已加上 PWA manifest、`viewport-fit=cover`、安全区边距，以及按钮和办公室的触摸滚动。图标仍用默认角色图。

壳只负责装进 `dist/`，需要的话再换成自己的事件来源。

## 许可

Pixel Agents 的代码和图片版权归 Pablo De Lucca，MIT。详见 `LICENSE` 和 `NOTICE`。
