# readvideo-resolve

readvideo 的 Bilibili 轻量解析服务。**只解析地址，不中转音视频。**

部署在 Vercel（AWS us-east-1）。实测出口 `3.81.132.67`（AS14618 Amazon）可以正常访问 B 站。

## 接口

```
GET  /api/health            （暂时由 resolve 处理）
POST /api/resolve
```

请求：

```json
{ "url": "https://www.bilibili.com/video/BV1QAnB67EL3/", "transport": "direct-cdn" }
```

有字幕：

```json
{ "kind": "captions", "title": "…", "language": "zh-CN",
  "segments": [{ "start": 0, "end": 2.5, "text": "…" }] }
```

无字幕：

```json
{ "kind": "media", "transport": "direct-cdn", "title": "…", "id": "rv-…",
  "urls": ["https://…bilivideo.com/…"], "duration": 2512 }
```

## 三条铁律（改代码前必读）

写在 `lib/resolve-core.mjs` 里，都是从实测里换来的：

1. 请求 `api.bilibili.com` 时**不发 `User-Agent`**
   实测：Chrome UA → 412；curl UA → 200；空 UA → 200。
2. **不发 `Origin`**
   B 站 API 有 Origin 白名单，带了直接 403。
3. 必须带 `Referer: https://www.bilibili.com/`
   API 的 Referer 校验是**严格锚定**，只有这个值能过；
   查询参数/路径/仿冒域名里含 bilibili 一律 403（与 CDN 的子串弱校验不同）。

另外：只返回 `bilivideo.com` / `bilivideo.cn` 且**不带端口**的地址，`urls` 必须是同一音轨的镜像。

## 为什么不用 Cloudflare

实测 Cloudflare Workers 的出口（AS13335）**整站 412**，连 `www.bilibili.com` 主页都打不开。

| 出口 | 结果 |
|---|---|
| Cloudflare Workers（SEA/US） | ❌ 412 |
| Vercel（AWS iad1） | ✅ 200 |
| GitHub Actions（Azure） | ✅ 200 |
| 国内校园网 | ✅ 200 |

**结论：不是"大厂云都被封"，是 Cloudflare 的 IP 段被 B 站整段拉黑。**

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RV_CORS_ORIGIN` | `https://survivorno1.github.io,...` | 允许的前端来源，逗号分隔 |
| `RV_MAX_BODY` | `8192` | 请求体上限 |
| `RV_RATE_PER_IP` | `20` | 单实例内每 IP 每分钟次数 |

## 本地开发

```bash
npx vercel dev
```

## 部署

推送到 `main` 即自动部署（Vercel Git 集成）。
