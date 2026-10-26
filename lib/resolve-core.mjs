/**
 * readvideo 解析核心（与运行平台无关）
 *
 * 被三个入口共用：
 *   - server.mjs        自建 HTTP 服务（VPS）
 *   - serverless.mjs    云函数 / Serverless（阿里云 FC、腾讯云 SCF、Vercel、Deno、CF）
 *
 * ── 铁律（改之前先看这里）──────────────────────────────────
 * 1. 请求 api.bilibili.com 时【不发 User-Agent】。
 *    实测：Chrome UA → 412 / curl UA → 200 / 空 UA → 200。
 * 2. 【不发 Origin】。B 站 API 有 Origin 白名单，带了直接 403。
 * 3. 必须带 `Referer: https://www.bilibili.com/`。
 *    实测：API 的 Referer 校验是【严格锚定】，只有这个值能过；
 *    查询参数/路径/仿冒域名里含 bilibili 一律 403（与 CDN 的子串弱校验不同）。
 * 4. 只返回域名在 bilivideo.com / bilivideo.cn 且【不带端口】的地址。
 *    前端 audioURL() 会拒绝带端口的地址（如 *.mountaintoys.cn:4483）。
 * 5. urls 必须是同一音轨的镜像，不能混码率。
 */

const UPSTREAM_HEADERS = {
  // ★ 这里绝不能出现 User-Agent
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.bilibili.com/",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

const UPSTREAM_ALLOW = new Set([
  "api.bilibili.com",
  "www.bilibili.com",
  "b23.tv",
]);

const AUDIO_HOST_OK = (hostname) => {
  const h = hostname.toLowerCase();
  return (
    h === "bilivideo.com" || h.endsWith(".bilivideo.com") ||
    h === "bilivideo.cn" || h.endsWith(".bilivideo.cn")
  );
};

const RE_BV = /(BV[0-9A-Za-z]{10})/;
const RE_AV = /(?:^|\/|av)(\d{1,12})(?:[/?#]|$)/i;
const RE_P = /[?&]p=(\d{1,4})/;

export class ResolveError extends Error {
  constructor(message, status = 502, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sanitizeAudioUrls(candidates) {
  const out = [];
  const seen = new Set();
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw) continue;
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== "https:") continue;
    if (u.username || u.password) continue;
    if (u.port) continue;
    if (!AUDIO_HOST_OK(u.hostname)) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push(u.href);
    if (out.length >= 4) break;
  }
  return out;
}

export function parseVideoId(input) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s || s.length > 2048) return null;
  const bv = RE_BV.exec(s);
  if (bv) return { bvid: bv[1], page: Number(RE_P.exec(s)?.[1] || 1), short: null };
  if (/^BV[0-9A-Za-z]{10}$/.test(s)) return { bvid: s, page: 1, short: null };
  const av = RE_AV.exec(s);
  if (av) return { bvid: null, aid: Number(av[1]), page: 1, short: null };
  if (/^b23\.tv\//.test(s) || /^https?:\/\/b23\.tv\//.test(s))
    return { bvid: null, aid: null, page: 1, short: s.startsWith("http") ? s : "https://" + s };
  return null;
}

async function upstreamJson(url, { timeoutMs = 6000, maxBytes = 2_000_000 } = {}) {
  const u = new URL(url);
  if (!UPSTREAM_ALLOW.has(u.hostname))
    throw new ResolveError("上游地址不在白名单内", 500);

  let res;
  try {
    res = await fetch(url, {
      headers: UPSTREAM_HEADERS,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ResolveError(`上游请求失败: ${e.name}`, 504);
  }

  if ([301, 302, 303, 307, 308].includes(res.status))
    throw new ResolveError("上游返回重定向，已拒绝跟随", 502);
  if (res.status === 412)
    throw new ResolveError("平台返回 412（出口 IP 被风控）", 503, 412);
  if (!res.ok) throw new ResolveError(`上游 HTTP ${res.status}`, 502);

  const text = await res.text();
  if (text.length > maxBytes) throw new ResolveError("上游响应过大", 502);
  try {
    return JSON.parse(text);
  } catch {
    throw new ResolveError("上游返回非 JSON", 502);
  }
}

async function expandShort(shortUrl) {
  let res;
  try {
    res = await fetch(shortUrl, {
      headers: UPSTREAM_HEADERS,
      redirect: "manual",
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    throw new ResolveError("短链解析失败", 504);
  }
  const loc = res.headers.get("location");
  if (!loc) throw new ResolveError("短链无重定向目标", 400);
  const bv = RE_BV.exec(loc);
  if (!bv) throw new ResolveError("短链未指向有效视频", 400);
  return { bvid: bv[1], page: Number(RE_P.exec(loc)?.[1] || 1), short: null };
}

async function fetchCaptions(bvid, cid) {
  try {
    const d = await upstreamJson(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
      { timeoutMs: 4000 },
    );
    if (d?.code !== 0) return null;
    const subs = d?.data?.subtitle?.subtitles || [];
    if (!subs.length) return null;
    const pick =
      subs.find((s) => s.lan === "zh-CN") ||
      subs.find((s) => /^ai-zh/.test(s.lan || "")) ||
      subs[0];
    if (!pick?.subtitle_url) return null;

    let subUrl = pick.subtitle_url;
    if (subUrl.startsWith("//")) subUrl = "https:" + subUrl;
    if (!/^https:\/\/[a-z0-9.-]*\.(bilibili\.com|hdslb\.com|bilivideo\.com)\//i.test(subUrl))
      return null;

    const res = await fetch(subUrl, {
      headers: UPSTREAM_HEADERS,
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const body = Array.isArray(json?.body) ? json.body : [];
    const segments = body
      .map((b) => ({
        start: Number(b.from),
        end: Number(b.to),
        text: String(b.content ?? "").trim(),
      }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text);
    if (!segments.length) return null;
    return {
      segments,
      language: pick.lan || "zh-CN",
      automatic: /^ai-/.test(pick.lan || ""),
    };
  } catch {
    return null;
  }
}

// ─────────────────────────── YouTube ───────────────────────────
//
// 铁律（实测得来，违反任何一条都会失败）：
//   1. 【不发 Origin】。发了会被 Google 判为自动化请求，直接 403「We're sorry...」。
//   2. 【不发 User-Agent】。和 B 站一样的教训，验证过不需要。
//   3. 客户端必须是 IOS 系。WEB 返回 UNPLAYABLE，ANDROID 返回 400。
//      只有 IOS 拿到的 captionTracks 地址不需要 PoToken。
//   4. 裸调 api/timedtext 一律 200 + 0 字节（八种参数组合都试过），
//      只能走 captionTracks 里的 baseUrl。
//   5. 数据中心 IP 会被风控（"Sign in to confirm you're not a bot"）。
//      所以要带 visitorData，并且准备多套客户端轮换，任一套通过就行。

const YT_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const YT_API = `https://www.youtube.com/youtubei/v1`;

const YT_CLIENTS = [
  {
    name: "IOS",
    client: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      hl: "en",
    },
  },
  {
    name: "IOS-OLD",
    client: {
      clientName: "IOS",
      clientVersion: "19.45.4",
      deviceMake: "Apple",
      deviceModel: "iPhone14,3",
      osName: "iPhone",
      osVersion: "16.6.0.20G75",
      hl: "en",
    },
  },
  {
    name: "ANDROID-VR",
    client: {
      clientName: "ANDROID_VR",
      clientVersion: "1.62.27",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12L",
      androidSdkVersion: 32,
      hl: "en",
    },
  },
  {
    name: "TV",
    client: {
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
      hl: "en",
    },
  },
];

const RE_YT =
  /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([\w-]{11})/;

export function parseYouTubeId(input) {
  const m = String(input).match(RE_YT);
  return m ? m[1] : null;
}

/** 取一个 visitorData。数据中心 IP 没有它很容易被要求 "Sign in to confirm"。 */
async function ytVisitorData(client) {
  try {
    const res = await fetch(`${YT_API}/visitor_id?key=${YT_KEY}&prettyPrint=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: { client } }),
      signal: AbortSignal.timeout(4000),
    });
    const d = await res.json();
    return d?.responseContext?.visitorData || "";
  } catch {
    return "";
  }
}

async function ytPlayerOnce(videoId, entry, visitorData) {
  const client = visitorData
    ? { ...entry.client, visitorData }
    : entry.client;
  const res = await fetch(`${YT_API}/player?key=${YT_KEY}&prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
    },
    body: JSON.stringify({
      videoId,
      context: { client },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) return null;
  return res.json();
}

/** 依次尝试多套客户端 + 有无 visitorData，返回第一个能拿到字幕轨的响应。 */
async function ytPlayer(videoId) {
  let lastStatus = "";
  for (const entry of YT_CLIENTS) {
    for (const withVisitor of [true, false]) {
      let vd = "";
      if (withVisitor) vd = await ytVisitorData(entry.client);
      let data;
      try {
        data = await ytPlayerOnce(videoId, entry, vd);
      } catch {
        continue;
      }
      if (!data) continue;
      const status = data?.playabilityStatus?.status;
      const tracks =
        data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (status === "OK" && tracks.length) return data;
      lastStatus = status || lastStatus;
    }
  }
  if (/SIGN_IN|LOGIN_REQUIRED|BOT/i.test(lastStatus))
    throw new ResolveError(
      "YouTube 要求验证（数据中心 IP 被风控）。可以打开原页并授权本页音频来转写。",
      403,
      lastStatus,
    );
  throw new ResolveError(
    `拿不到 YouTube 播放信息（最后状态：${lastStatus || "无响应"}）。` +
      "可以打开原页并授权本页音频来转写。",
    404,
    lastStatus || "no_response",
  );
}

function parseJson3Captions(text) {
  const data = JSON.parse(text);
  const segments = [];
  for (const e of data?.events || []) {
    if (e?.tStartMs == null || !Array.isArray(e.segs)) continue;
    const body = e.segs
      .map((s) => s?.utf8 || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    const start = e.tStartMs / 1000;
    const end = (e.tStartMs + (e.dDurationMs || 0)) / 1000;
    segments.push({ start, end: Math.max(end, start + 0.05), text: body });
  }
  return segments;
}

async function resolveYouTube(videoId, input, language = "auto") {
  const data = await ytPlayer(videoId);

  if (!data) {
    throw new ResolveError(
      "拿不到 YouTube 的播放信息。这个视频可能已删除、受限地区，或需要登录。" +
        "可以打开原页并授权本页音频来转写。",
      404,
      "no_player_data",
    );
  }

  const status = data?.playabilityStatus?.status;
  if (status && status !== "OK") {
    const reason = data?.playabilityStatus?.reason || status;
    throw new ResolveError(
      `YouTube 无法播放这个视频：${String(reason).slice(0, 120)}。` +
        "可以打开原页并授权本页音频来转写。",
      403,
      status,
    );
  }

  const title = String(data?.videoDetails?.title || "YouTube 视频").slice(0, 1000);
  const duration = Number(data?.videoDetails?.lengthSeconds) || 0;
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  if (!tracks.length) {
    throw new ResolveError(
      "这个 YouTube 视频没有可用字幕。可以打开原页并授权本页音频来转写。",
      404,
      "no_captions",
    );
  }

  const want = String(language || "auto").toLowerCase();
  const matches = (t) =>
    want !== "auto" && String(t.languageCode || "").toLowerCase().startsWith(want);

  const pick =
    tracks.find((t) => matches(t) && !t.kind) ||
    tracks.find((t) => matches(t)) ||
    tracks.find((t) => String(t.languageCode || "").startsWith("en") && !t.kind) ||
    tracks.find((t) => String(t.languageCode || "").startsWith("en")) ||
    tracks[0];

  const base = pick.baseUrl || pick.url;
  if (!base) throw new ResolveError("YouTube 没有返回字幕地址", 502);

  const sub = await fetch(base + "&fmt=json3", {
    signal: AbortSignal.timeout(8000),
  });
  if (!sub.ok) throw new ResolveError(`获取字幕失败：HTTP ${sub.status}`, 502);
  const segments = parseJson3Captions(await sub.text());
  if (!segments.length)
    throw new ResolveError(
      "这个视频的字幕是空的。可以打开原页并授权本页音频来转写。",
      404,
      "empty_captions",
    );

  return {
    kind: "captions",
    title,
    duration,
    language: pick.languageCode || "unknown",
    automatic: pick.kind === "asr",
    tracks: tracks.slice(0, 12).map((t) => ({
      language: t.languageCode || "unknown",
      automatic: t.kind === "asr",
    })),
    segments,
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export async function resolveVideo(input, { totalTimeoutMs = 15000, language = "auto" } = {}) {
  const ytId = parseYouTubeId(input);
  if (ytId) return resolveYouTube(ytId, input, language);

  const parsed = parseVideoId(input);
  if (!parsed) throw new ResolveError("无法识别视频链接", 400);

  let { bvid, aid, page } = parsed;
  if (parsed.short) {
    const e = await expandShort(parsed.short);
    bvid = e.bvid;
    page = e.page;
  }

  const viewUrl = bvid
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${aid}`;
  const view = await upstreamJson(viewUrl);
  if (view?.code !== 0) {
    const code = view?.code;
    if (code === -404) throw new ResolveError("视频不存在、已下架，或在服务所在地区不可见", 404, code);
    if (code === -403) throw new ResolveError("该视频需要登录或更高权限", 403, code);
    if (code === -400 || code === -626) throw new ResolveError("视频 ID 无效或该视频不存在", 400, code);
    if (code === -412) throw new ResolveError("平台触发风控（412），请稍后再试", 503, code);
    throw new ResolveError(`平台返回 ${code ?? "未知错误"}：${view?.message ?? ""}`, 502, code);
  }

  const info = view.data;
  const pages = Array.isArray(info.pages) ? info.pages : [];
  const safePage = Math.max(1, Math.min(page || 1, pages.length || 1));
  const cid = pages.length >= safePage ? pages[safePage - 1].cid : info.cid;
  const partTitle = pages.length > 1 ? pages[safePage - 1]?.part || "" : "";
  const title = (partTitle ? `${info.title} - ${partTitle}` : info.title || "B站视频").slice(0, 1000);

  const caps = await fetchCaptions(bvid || String(info.bvid), cid);
  if (caps) {
    return {
      kind: "captions",
      title,
      language: caps.language,
      automatic: caps.automatic,
      segments: caps.segments,
    };
  }

  const play = await upstreamJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid || info.bvid)}`
    + `&cid=${cid}&fnval=16&fourk=1`,
  );
  if (play?.code !== 0)
    throw new ResolveError(`获取音轨失败：${play?.code} ${play?.message ?? ""}`, 502, play?.code);

  const audios = play?.data?.dash?.audio || [];
  if (!audios.length)
    throw new ResolveError("该视频没有可用的独立音轨（可能需要登录或为付费内容）", 404);

  const best = audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  const urls = sanitizeAudioUrls([
    best.baseUrl || best.base_url,
    ...(best.backupUrl || best.backup_url || []),
  ]);
  if (!urls.length)
    throw new ResolveError("平台返回的音轨地址不在允许的 CDN 域名内", 502);

  // 稳定的任务 id（前端用来做断点续传的缓存键）
  const idSource = `${bvid || info.bvid}:${cid}:${best.id}:${best.bandwidth}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idSource));
  const id = "rv-" + Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

  return {
    kind: "media",
    transport: "direct-cdn",
    title,
    source_url: input.startsWith("http")
      ? input
      : `https://www.bilibili.com/video/${bvid || "av" + aid}/`,
    id,
    urls,
    duration: Number(info.duration) || undefined,
    quality: best.bandwidth || undefined,
    codecs: best.codecs || undefined,
  };
}
