/**
 * POST /api/resolve   { url, language?, transport? }
 * GET  /api/health
 *
 * 铁律（见 lib/resolve-core.mjs）：请求 B 站时不发 User-Agent、不发 Origin，
 * 必须带 Referer: https://www.bilibili.com/
 */

import { resolveVideo, ResolveError } from "../lib/resolve-core.mjs";

const CORS_ORIGIN = (
  process.env.RV_CORS_ORIGIN ??
  "https://survivorno1.github.io,http://localhost:4186,http://127.0.0.1:4186"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_BODY = Number(process.env.RV_MAX_BODY ?? 8192);
const RATE_PER_MIN = Number(process.env.RV_RATE_PER_IP ?? 20);
const START_AT = Date.now();

// 单实例内的简易限流；Serverless 实例会被回收，不当作全局限流
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= RATE_PER_MIN) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 2000) hits.clear();
  return false;
}

function cors(origin) {
  const allow = origin && CORS_ORIGIN.includes(origin) ? origin : null;
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
  if (allow) h["Access-Control-Allow-Origin"] = allow;
  return h;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const base = cors(origin);
  for (const [k, v] of Object.entries(base)) res.setHeader(k, v);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const path = (req.url || "/").split("?")[0];

  if (path.endsWith("/health")) {
    res.status(200).json({ ok: true, uptime: Math.floor((Date.now() - START_AT) / 1000) });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed", message: "请用 POST" });
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (rateLimited(ip)) {
    res.status(429).json({ error: "rate_limited", message: "请求过于频繁，请稍后再试" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BODY) {
      res.status(413).json({ error: "bad_request", message: "请求体过大" });
      return;
    }
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: "bad_request", message: "请求体不是合法 JSON" });
      return;
    }
  }

  const video = typeof body?.url === "string" ? body.url : "";
  if (!video) {
    res.status(400).json({ error: "bad_request", message: "缺少 url 字段" });
    return;
  }

  try {
    const language = typeof body?.language === "string" ? body.language : "auto";
    const payload = await resolveVideo(video, { language });
    res.status(200).json(payload);
  } catch (e) {
    const status = e instanceof ResolveError ? e.status : 502;
    res.status(status).json({
      error: status >= 500 ? "upstream_error" : "bad_request",
      message: e.message || "解析失败",
    });
  }
}


