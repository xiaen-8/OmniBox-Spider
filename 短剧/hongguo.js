// @name 红果短剧
// @version 2.0.0
// @description 红果短剧爬虫（JS）：home/category/search 走 fqnovel 签名；play 走 video_model

const OmniBox = require("omnibox_sdk");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");

// ==================== 配置区域 ====================
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 " +
  "Mobile/15E148 Safari/604.1";

// 允许的入口 host（避免请求任意外部域名）
const ALLOWED_HOSTS = new Set([
  "bmlxkyy.com",
  "www.bmlxkyy.com",
  "hongguoduanju.com",
  "www.hongguoduanju.com",
  "novelquickapp.com",
  "www.novelquickapp.com",
]);

// 直链最小剩余有效秒数：低于该值视为「即将过期」并降级提示
const DEFAULT_MIN_URL_TTL = 900;

// playId 中 series_id 与 vid 的分隔符（detail/play 共用）
const PLAY_ID_SEP = "__";

// 模块级缓存 TTL（秒）：App 分类 filters 缓存
const CACHE_TTL = 600;

// 外部签名搜索服务（fqnovel-unidbg）地址。配置后 search()/category()/home() 走 App 签名能力。
// 取值优先级：context.fqSignApi > 环境变量 FQ_SIGN_API。
// 未配置则 search()/category() 返回空（依赖签名服务）。
const FQ_SIGN_API = "http://192.168.10.13:9999";
// 红果 App 分类 tab 映射（aid=8662）：
//   8=找剧 38=真人剧 32=漫剧 14=电影 11=综合(短剧+电影混排) 21=影视
const FQ_APP_TABS = {
  recommend: "11", // 综合（搜索默认）
  zhaoju: "8", // 找剧
  zhenren: "38", // 真人剧
  manju: "32", // 漫剧
  movie: "14", // 电影
  yingshi: "21", // 影视
};
// 内容分类展示顺序（home/category 顶层分类）
const FQ_CATEGORY_ORDER = ["zhaoju", "zhenren", "manju", "movie"];
// 外部签名搜索单次超时（毫秒）
const FQ_SIGN_TIMEOUT = 25000;

// 外部 video_model 解析服务（fqnovel-unidbg/video_model_service）。
// 取值优先级：context.videoModelApi > 环境变量 VIDEO_MODEL_API。
const VIDEO_MODEL_API = "http://192.168.10.13:8800";
const VIDEO_MODEL_TIMEOUT = 240000;
const VIDEO_MODEL_CLEANUP_TIMEOUT = 5000;

// 列表分页大小（home/category/search 目标条数；短剧上游常 6 条/包，会连拉凑满）
const PAGE_SIZE = 12;

// 单请求 socket 超时（毫秒）
const HTTP_TIMEOUT = 20000;
// ==================== 配置区域结束 ====================

class ParseError extends Error {}

// ---------- 模块级缓存 ----------
const _CACHE = {
  // App 分类筛选项：{ [categoryId]: FilterDimension[] }
  filters: { ts: 0, byId: null },
  // App 分类翻页元数据：key = `${tabType}|${selectedItems}` → { cellId, sessionId, step }
  cursor: {},
};

// ---------- 通用工具 ----------

function makeHeaders() {
  return {
    "User-Agent": MOBILE_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
}

function ensureAllowedUrl(url) {
  let host;
  try {
    host = new URL(url).hostname || "";
  } catch (e) {
    throw new ParseError(`非法链接: ${url}`);
  }
  host = host.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new ParseError(`不支持的链接域名: ${host}（仅支持红果/番茄分享页）`);
  }
}

/**
 * 经全局 fetch 请求页面，自动跟随重定向、自动解压 gzip/deflate/br。
 * 返回 { html, finalUrl }。带重试与超时（AbortController）。
 */
async function fetchHtml(url, { referer = null, retries = 3, timeout = HTTP_TIMEOUT } = {}) {
  ensureAllowedUrl(url);
  const headers = makeHeaders();
  if (referer) {
    headers["Referer"] = referer;
    headers["Sec-Fetch-Site"] = "same-origin";
  }
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let resp;
      try {
        resp = await fetch(url, {
          method: "GET",
          headers,
          redirect: "follow",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (resp.status !== 200) {
        throw new ParseError(`HTTP ${resp.status}`);
      }
      const html = await resp.text();
      const finalUrl = resp.url || url;
      return { html, finalUrl };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new ParseError(`请求页面失败: ${url}: ${lastErr ? lastErr.message : "未知错误"}`);
}

/** Promise 超时包裹：ms 毫秒内未完成则 reject。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label || "操作"}超时 (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- SSR 解析（复用现有 _ROUTER_DATA 解析能力） ----------

function extractRouterData(html) {
  const idx = html.indexOf('_ROUTER_DATA = ');
  if (idx === -1) throw new ParseError("页面未包含 _ROUTER_DATA");
  const jsonStart = html.indexOf('{', idx);
  let depth = 0, inString = false, escape = false, jsonEnd = jsonStart;
  for (let i = jsonStart; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
  }
  try { return JSON.parse(html.slice(jsonStart, jsonEnd)); } catch (e) { throw new ParseError(e.message); }
}


function loaderData(router) {
  const data = router.loaderData;
  if (!data || typeof data !== "object") {
    throw new ParseError("loaderData 不存在");
  }
  return data;
}

function findLoaderPage(router, requiredKey) {
  const ld = loaderData(router);
  for (const key of Object.keys(ld)) {
    const value = ld[key];
    if (value && typeof value === "object" && requiredKey in value) {
      return value;
    }
  }
  throw new ParseError(`未找到包含 ${requiredKey} 的页面`);
}

function findShareLoader(router) {
  const ld = loaderData(router);
  const page = ld["video-list-share-ssr_page"];
  if (page && typeof page === "object") return page;
  return findLoaderPage(router, "pageData");
}

function shareFromRouter(router) {
  const page = findShareLoader(router);
  const pageData = page.pageData;
  if (!pageData || typeof pageData !== "object") {
    throw new ParseError("share pageData 不存在");
  }
  return [page, pageData];
}

function playerFromRouter(router) {
  const ld = loaderData(router);
  for (const key of Object.keys(ld)) {
    const value = ld[key];
    if (value && typeof value === "object" && value.video_player_info && typeof value.video_player_info === "object") {
      return value;
    }
  }
  throw new ParseError("video_player_info 不存在");
}

function toInt(value) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Math.trunc(value);
  const text = String(value).trim().replace(/,/g, "");
  const n = Number(text);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function extractSeriesIdFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  const q = u.searchParams;
  if (q.get("series_id")) return q.get("series_id");
  const parts = u.pathname.split("/").filter((p) => p);
  if (parts.length >= 2 && parts[0] === "player") return parts[1];
  return null;
}

function extractVidFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  const parts = u.pathname.split("/").filter((p) => p);
  if (parts.length >= 3 && parts[0] === "player") return parts[2];
  return null;
}

// ---------- 分享页 / player 页解析（detail/play 复用，保持原逻辑） ----------

function seriesFromShare(page, pageData) {
  const seriesData = pageData.series_data;
  if (!seriesData || typeof seriesData !== "object") {
    throw new ParseError("share series_data 不存在");
  }

  const linkParams = page.linkParams || {};
  const schemeParams = linkParams.schemeParams || {};
  const normalSeriesId =
    schemeParams.video_series_id || seriesData.series_id || pageData.series_id;
  const seriesId = normalSeriesId || schemeParams.video_id;
  if (!seriesId) {
    throw new ParseError("未解析到 series_id");
  }

  let chapterIds = pageData.chapter_ids || [];
  if (!Array.isArray(chapterIds)) chapterIds = [];

  let tags = seriesData.category_list || [];
  if (seriesData.category && tags.indexOf(seriesData.category) === -1) {
    tags = [seriesData.category, ...tags];
  }

  return {
    series_id: String(seriesId),
    title: seriesData.title || seriesData.series_title,
    description: seriesData.series_intro,
    tags: Array.from(new Set(tags.filter((x) => x).map(String))),
    episode_count: toInt(seriesData.serial_count || chapterIds.length),
    chapter_ids: chapterIds.map(String),
    current_play_url: seriesData.play_url,
    cover: seriesData.series_cover,
    actors: seriesData.actor_list || [],
  };
}

function buildShareUrl(
  seriesId,
  vid,
  { uid = null, did = null, uiExpGroup = "3", ugToken = "#HGjtJKwjmNGko#" } = {}
) {
  const rand = () => crypto.randomUUID().replace(/-/g, "");
  uid = uid || rand();
  did = did || uid;
  const schemeParams = {
    video_series_id: String(seriesId),
    vs_id_type: "1",
    source: "8",
    module_name: "share",
    vid: String(vid),
    share_toast_vid: String(vid),
    share_ab_group: 2,
  };
  const zlink =
    "https://applink.novelquickapp.com/dVu4P?schemeParams=" +
    encodeURIComponent(JSON.stringify(schemeParams));
  const reportParams = {
    content_id_key: "material_id",
    share_timestamp: Math.floor(Date.now() / 1000),
    entrance: "video_player_share_button",
    content_id: String(vid),
    if_full_screen: 0,
    type: "video_player",
    read_progress: "0.02",
    content_type: "short_video",
  };
  const query = {
    ui_exp_group: uiExpGroup,
    uid,
    zlink,
    gd_label: "click_schema_lhft_share_novelread_ios",
    use_open_launch_app_novel: "1",
    user_id: "",
    did,
    share_channel: "copy_link",
    report_params: JSON.stringify(reportParams),
    ug_token: ugToken,
    _cache: rand(),
  };
  return (
    "https://novelquickapp.com/hongguo/ug/pages/video-list-share-ssr?" +
    new URLSearchParams(query).toString()
  );
}

function mediaUrlExpiry(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  const q = u.searchParams;
  for (const key of ["x-expires", "expires", "expire"]) {
    const v = q.get(key);
    if (v && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  for (const part of u.pathname.split("/")) {
    if (/^[0-9a-fA-F]{8}$/.test(part)) {
      const value = parseInt(part, 16);
      if (value >= 1500000000 && value <= 4102444800) return value;
    }
  }
  return null;
}

function inspectMediaUrl(url) {
  const expiry = mediaUrlExpiry(url);
  if (expiry != null && expiry <= Math.floor(Date.now() / 1000)) {
    throw new ParseError("媒体直链已过期");
  }
  return expiry;
}

async function requestShareForVid(
  seriesId,
  vid,
  { referer = null, uid = null, minUrlTtl = DEFAULT_MIN_URL_TTL } = {}
) {
  let lastErr = null;
  let bestValid = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const attemptUid = attempt === 0 ? uid || crypto.randomUUID().replace(/-/g, "") : crypto.randomUUID().replace(/-/g, "");
      const url = buildShareUrl(seriesId, vid, { uid: attemptUid });
      const { html, finalUrl } = await fetchHtml(url, { referer });
      const router = extractRouterData(html);
      const [page, pageData] = shareFromRouter(router);
      const series = seriesFromShare(page, pageData);
      const playUrl = series.current_play_url;
      if (!playUrl) {
        throw new ParseError(`未找到 play_url (vid=${vid})`);
      }
      const expiry = inspectMediaUrl(String(playUrl));
      const candidate = {
        vid: String(vid),
        url: String(playUrl),
        source_url: finalUrl,
        expires_at: expiry,
      };
      if (expiry == null || expiry - Math.floor(Date.now() / 1000) >= minUrlTtl) {
        return candidate;
      }
      if (bestValid == null || (expiry || 0) > (bestValid.expires_at || 0)) {
        bestValid = candidate;
      }
      throw new ParseError(`媒体直链即将过期（剩余不足 ${minUrlTtl}s）`);
    } catch (e) {
      lastErr = e;
    }
  }
  if (bestValid != null) {
    bestValid.short_ttl = true;
    return bestValid;
  }
  throw new ParseError(`分享页解析失败 (vid=${vid}): ${lastErr ? lastErr.message : ""}`);
}

async function requestPlayerForVid(
  seriesId,
  vid,
  { referer = null, minUrlTtl = DEFAULT_MIN_URL_TTL } = {}
) {
  const playerUrl =
    "https://hongguoduanju.com/player/" +
    encodeURIComponent(String(seriesId)) +
    "/" +
    encodeURIComponent(String(vid));
  let bestValid = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { html, finalUrl } = await fetchHtml(playerUrl, { referer });
      if (!new URL(finalUrl).pathname.startsWith("/player/")) return null;
      const page = playerFromRouter(extractRouterData(html));
      const info = page.video_player_info || {};
      const mainUrl = info.main_url;
      if (!mainUrl) return null;
      const expiry = inspectMediaUrl(String(mainUrl));
      const candidate = {
        vid: String(vid),
        url: String(mainUrl),
        source_url: finalUrl,
        expires_at: expiry,
      };
      if (expiry == null || expiry - Math.floor(Date.now() / 1000) >= minUrlTtl) {
        return candidate;
      }
      if (bestValid == null || (expiry || 0) > (bestValid.expires_at || 0)) {
        bestValid = candidate;
      }
      throw new ParseError("player 媒体直链即将过期");
    } catch (e) {
      if (attempt === 2) break;
    }
  }
  if (bestValid != null) {
    bestValid.short_ttl = true;
    return bestValid;
  }
  return null;
}

async function loadSeriesSeed(inputUrl) {
  const { html, finalUrl } = await fetchHtml(inputUrl);
  const router = extractRouterData(html);
  const host = (new URL(finalUrl).hostname || "").toLowerCase();

  if (host.includes("novelquickapp.com")) {
    const [page, pageData] = shareFromRouter(router);
    const series = seriesFromShare(page, pageData);
    return [series, finalUrl];
  }

  if (host.includes("hongguoduanju.com")) {
    let detail = {};
    try {
      const page = findLoaderPage(router, "seriesDetail");
      detail = page.seriesDetail || {};
    } catch (e) {
      detail = {};
    }
    const series = {
      series_id: String(detail.series_id || ""),
      title: detail.series_name,
      description: detail.series_intro,
      cover: detail.series_cover,
      tags: (detail.tags || []).filter((x) => x).map(String),
      chapter_ids: (detail.vid_list || []).map(String),
      episode_count: toInt(
        ((detail.series_episode_info || {}).episode_total_cnt) ||
          detail.episode_cnt ||
          (detail.vid_list || []).length
      ),
    };
    if (!series.series_id) {
      const sid = extractSeriesIdFromUrl(finalUrl);
      if (sid) series.series_id = sid;
    }
    if (!series.chapter_ids || !series.chapter_ids.length) {
      const v = extractVidFromUrl(finalUrl);
      if (v) series.chapter_ids = [v];
    }
    return [series, finalUrl];
  }

  throw new ParseError(`不支持的链接域名: ${host}`);
}

function parseInputItems(raw) {
  raw = (raw || "").toString().trim();
  if (!raw) return [];
  try {
    const fs = require("fs");
    if (fs.existsSync(raw) && fs.statSync(raw).isFile()) {
      const text = fs.readFileSync(raw, "utf-8");
      return Array.from(new Set(text.match(/https?:\/\/[^\s"'<>]+/g) || []));
    }
  } catch (e) {
    // ignore
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) return [raw];
  const found = raw.match(/https?:\/\/[^\s"'<>]+/g) || [];
  return Array.from(new Set(found));
}

function buildPlayId(seriesId, vid) {
  return `${seriesId}${PLAY_ID_SEP}${vid}`;
}

function splitPlayId(playId) {
  if (playId.includes(PLAY_ID_SEP)) {
    const parts = playId.split(PLAY_ID_SEP, 2);
    return [parts[0], parts[1]];
  }
  return [playId, ""];
}

// ---------- home/category/search 专用工具 ----------

function proxiedPic(url) {
  // 返回封面直链，由前端直接加载，不走后端图片代理。
  url = (url || "").toString().trim();
  if (!url) return "";
  if (url.startsWith("http://")) url = "https://" + url.slice("http://".length);
  return url;
}

function looksLikeUrl(s) {
  return !!s && (s.startsWith("http://") || s.startsWith("https://"));
}

// ---------- 对外接口：home / category / detail / search / play ----------

async function home(params, context) {
  try {
    await OmniBox.log("info", "获取红果首页数据（App 分类体系：找剧/真人剧/漫剧/电影）");
    // 顶层分类直接映射红果 App 内容 tab
    const classes = [
      { type_id: "zhaoju", type_name: "找剧" },
      { type_id: "zhenren", type_name: "真人剧" },
      { type_id: "manju", type_name: "漫剧" },
      { type_id: "movie", type_name: "电影" },
    ];
    const apiBase = getFqSignApi(context);
    // 筛选项与找剧首屏并行；home.list 用找剧第 1 页填充
    const [filters, zhaojuPage] = await Promise.all([
      loadAppFilters(context),
      apiBase
        ? withTimeout(
            categoryViaSign(apiBase, FQ_APP_TABS.zhaoju, 1, {}),
            FQ_SIGN_TIMEOUT + 3000,
            "找剧首页"
          ).catch(() => null)
        : Promise.resolve(null),
    ]);
    const list = (zhaojuPage && Array.isArray(zhaojuPage.list) && zhaojuPage.list) || [];
    await OmniBox.log("info", `首页找剧首屏 ${list.length} 条`);
    return { class: classes, filters, list };
  } catch (e) {
    await OmniBox.log("error", `获取首页数据失败: ${e.message}`);
    return { class: [], filters: {}, list: [] };
  }
}

async function category(params, context) {
  try {
    const categoryId = params.categoryId || "zhaoju";
    const page = params.page || 1;
    const filters = params.filters || {};

    await OmniBox.log("info", `获取分类数据: categoryId=${categoryId}, page=${page}`);

    const apiBase = getFqSignApi(context);
    if (!apiBase) {
      await OmniBox.log("warn", "未配置 FQ_SIGN_API，分类返回空");
      return { page: Number(page), pagecount: 1, total: 0, list: [] };
    }

    const tabType = FQ_APP_TABS[categoryId] || FQ_APP_TABS.zhaoju;
    const signed = await withTimeout(
      categoryViaSign(apiBase, tabType, page, filters),
      FQ_SIGN_TIMEOUT + 3000,
      "App 分类"
    );
    if (signed != null) {
      await OmniBox.log("info", `App 分类命中 ${signed.list ? signed.list.length : 0} 条 page=${page}`);
      return signed;
    }
    await OmniBox.log("info", "App 分类无结果");
    return { page: Number(page), pagecount: Math.max(1, Number(page)), total: 0, list: [] };
  } catch (e) {
    await OmniBox.log("error", `获取分类数据失败: ${e.message}`);
    return { page: Number(params.page || 1), pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  try {
    const rawInput = (params.videoId || "").toString().trim();
    if (!rawInput) throw new Error("videoId 不能为空");

    await OmniBox.log("info", `解析红果详情: ${rawInput}`);

    // 进详情时顺带清理 video_model 落盘解密文件，避免磁盘堆积；失败不影响详情
    const videoModelApi = (context && context.videoModelApi) || VIDEO_MODEL_API;
    await cleanupVideoModelDisk(videoModelApi);

    let series, referer;
    if (looksLikeUrl(rawInput)) {
      [series, referer] = await loadSeriesSeed(rawInput);
    } else {
      [series, referer] = await detailBySeriesId(rawInput);
    }

    const seriesId = String(series.series_id || "");
    let chapterIds = (series.chapter_ids || []).map(String);
    if (!seriesId) throw new ParseError("未解析到 series_id");
    if (!chapterIds.length) throw new ParseError("未解析到剧集 vid 列表");

    // 分享页补全（仅当信息不全时）
    if (!series.title || chapterIds.length <= 1) {
      try {
        const first = await requestShareForVid(seriesId, chapterIds[0], { referer });
        const { html } = await fetchHtml(first.source_url, { referer });
        const [page, pageData] = shareFromRouter(extractRouterData(html));
        const fresh = seriesFromShare(page, pageData);
        if (fresh.title) series.title = fresh.title;
        if (fresh.chapter_ids && fresh.chapter_ids.length) {
          chapterIds = fresh.chapter_ids;
          series.chapter_ids = chapterIds;
        }
        if (fresh.cover) series.cover = fresh.cover;
      } catch (e) {
        await OmniBox.log("warn", `补充分享页信息失败: ${e.message}`);
      }
    }

    const episodes = chapterIds.map((vid, i) => ({
      name: `第${i + 1}集`,
      playId: buildPlayId(seriesId, vid),
    }));

    const vod = {
      vod_id: seriesId,
      vod_name: series.title || "红果短剧",
      vod_pic: proxiedPic(series.cover || ""),
      vod_content: series.description || "",
      type_name: "短剧",
      vod_remarks: series.tags && series.tags.length ? series.tags.join(" / ") : "",
      vod_year: "",
      vod_play_sources: [{ name: "红果直链", episodes }],
    };
    const actor = series.actors || [];
    if (actor.length) {
      vod.vod_actor = actor
        .filter((a) => a && a.nickname)
        .map((a) => a.nickname)
        .join(", ");
    }

    await OmniBox.log("info", `解析成功: ${vod.vod_name} 共 ${episodes.length} 集`);
    return { list: [vod] };
  } catch (e) {
    await OmniBox.log("error", `获取红果详情失败: ${e.message}`);
    return { list: [] };
  }
}

async function detailBySeriesId(seriesId) {
  const detailUrl =
    "https://hongguoduanju.com/detail?series_id=" + encodeURIComponent(String(seriesId));
  const { html, finalUrl } = await fetchHtml(detailUrl);
  const router = extractRouterData(html);
  let detail = {};
  try {
    const page = findLoaderPage(router, "seriesDetail");
    detail = page.seriesDetail || {};
  } catch (e) {
    detail = {};
  }
  if (!detail.series_id) detail.series_id = seriesId;
  const series = {
    series_id: String(detail.series_id || seriesId),
    title: detail.series_name,
    description: detail.series_intro,
    cover: detail.series_cover,
    tags: (detail.tags || []).filter((x) => x).map(String),
    chapter_ids: (detail.vid_list || []).map(String),
    episode_count: toInt(
      ((detail.series_episode_info || {}).episode_total_cnt) ||
        detail.episode_cnt ||
        (detail.vid_list || []).length
    ),
  };
  return [series, finalUrl];
}

function getFqSignApi(context) {
  const val = (context && context.fqSignApi) || FQ_SIGN_API;
  return (val || "").trim().replace(/\/+$/, "");
}

function bookToVod(book) {
  if (!book || typeof book !== "object") return null;
  const seriesId = String(book.bookId != null ? book.bookId : book.book_id || "").trim();
  if (!seriesId) return null;
  const name = book.bookName || book.book_name || "";
  const cover = book.coverUrl || book.thumb_url || book.detailPageThumbUrl || "";
  const tags = Array.isArray(book.tags) ? book.tags : [];
  let remarks = book.tagsStr || "";
  if (!remarks && tags.length) remarks = tags.slice(0, 3).join(" / ");
  const intro = book.description || book.abstract || "";
  // content_type 语义：5=电影 1004=短剧 1003=书籍卡 1001=UGC片段
  const contentType = book.contentType != null ? Number(book.contentType) : 0;
  const isMovie = contentType === 5;
  const vod = {
    vod_id: seriesId,
    vod_name: name,
    vod_pic: proxiedPic(cover),
    vod_remarks: remarks || (isMovie ? "电影" : ""),
    vod_content: intro,
    type_name: isMovie ? "电影" : "短剧",
    vod_year: book.score || "",
  };
  // 电影只有一集（episode_cnt=1），直接用 vid 构造 playId；短剧由详情补全vid_list
  if (isMovie && book.vid) {
    vod.vod_play_sources = [
      { name: "红果直链", episodes: [{ name: "正片", playId: buildPlayId(seriesId, book.vid) }] },
    ];
    vod.vod_remarks = remarks || `电影 · ${book.score || ""}分`;
  }
  return vod;
}

async function categoryViaSign(apiBase, tabType, page, filters = {}) {
  const selectedItems = buildSelectedItems(filters);
  const cursorKey = `${tabType}|${selectedItems}`;
  const pageNum = Math.max(1, Number(page) || 1);

  // OmniBox 一页目标条数 = PAGE_SIZE。
  // 短剧无限流上游常见每包只有 ~6 条（limit 不生效），需连拉多包凑满一页；
  // 电影等会按 count 返回，通常一包即可。
  let meta = _CACHE.cursor[cursorKey] || {};
  let offset = (pageNum - 1) * PAGE_SIZE;
  const collected = [];
  let hasMore = true;
  let guard = 0;

  while (collected.length < PAGE_SIZE && hasMore && guard++ < 6) {
    const data = await fetchCategoryPage(apiBase, {
      tabType,
      offset,
      count: PAGE_SIZE,
      cellId: meta.cellId || "",
      sessionId: meta.sessionId || "",
      selectedItems,
    });
    if (!data) {
      if (!collected.length && pageNum <= 1) return null;
      break;
    }
    if (data.cellId) meta.cellId = String(data.cellId);
    if (data.sessionId) meta.sessionId = String(data.sessionId);
    cacheCategoryFilters(tabType, data.filters);

    const books = Array.isArray(data.books) ? data.books : [];
    if (!books.length) {
      hasMore = false;
      break;
    }
    for (const book of books) collected.push(book);

    const next = Number(data.nextOffset);
    if (Number.isFinite(next) && next > offset) {
      offset = next;
    } else {
      offset += books.length;
    }
    hasMore = data.hasMore !== false;
  }

  meta = {
    cellId: meta.cellId || "",
    sessionId: meta.sessionId || "",
    step: PAGE_SIZE,
    nextOffset: offset,
  };
  _CACHE.cursor[cursorKey] = meta;

  return booksToCategoryResult(collected.slice(0, PAGE_SIZE), pageNum, !!hasMore && collected.length > 0);
}

function cacheCategoryFilters(tabType, filters) {
  if (!Array.isArray(filters) || !filters.length) return;
  const categoryId = Object.keys(FQ_APP_TABS).find((k) => String(FQ_APP_TABS[k]) === String(tabType));
  if (!categoryId || categoryId === "zhaoju") return;
  if (!_CACHE.filters.byId) _CACHE.filters.byId = {};
  _CACHE.filters.byId[categoryId] = filters;
  _CACHE.filters.ts = Date.now() / 1000;
}

function booksToCategoryResult(books, pageNum, hasMore) {
  const items = [];
  const seen = new Set();
  for (const book of books || []) {
    const vod = bookToVod(book);
    if (!vod) continue;
    const id = String(vod.vod_id || "");
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    items.push(vod);
  }
  if (!items.length && pageNum === 1) return null;
  return {
    page: pageNum,
    // 给 TVBox/网页足够余量：有更多时至少翻到下一页，并留出缓冲避免停在 pagecount=page+1
    pagecount: hasMore ? Math.max(pageNum + 1, 999) : pageNum,
    total: items.length,
    has_more: !!hasMore,
    list: items,
  };
}

async function fetchCategoryPage(apiBase, { tabType, offset, count, cellId, sessionId, selectedItems }) {
  const q = new URLSearchParams({
    tabType: String(tabType),
    offset: String(Math.max(0, Number(offset) || 0)),
    count: String(count || PAGE_SIZE),
  });
  if (cellId) q.set("cellId", String(cellId));
  if (sessionId) q.set("sessionId", String(sessionId));
  if (selectedItems) q.set("selectedItems", String(selectedItems));

  const url = apiBase + "/api/fqsearch/category?" + q.toString();
  const headers = { "User-Agent": MOBILE_UA, Accept: "application/json" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FQ_SIGN_TIMEOUT);
  let resp;
  try {
    resp = await fetch(url, { method: "GET", headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (resp.status !== 200) return null;
  let json;
  try {
    json = JSON.parse(await resp.text());
  } catch (e) {
    return null;
  }
  if (!json || json.code !== 0 || !json.data || typeof json.data !== "object") return null;
  return json.data;
}

function buildSelectedItems(filters) {
  if (!filters || typeof filters !== "object") return "";
  const ids = [];
  for (const k of Object.keys(filters)) {
    const v = filters[k];
    if (v === undefined || v === null || v === "") continue;
    ids.push(String(v));
  }
  return ids.join(",");
}

async function loadAppFilters(context) {
  const now = Date.now() / 1000;
  if (_CACHE.filters.byId && now - _CACHE.filters.ts < CACHE_TTL) {
    return _CACHE.filters.byId;
  }
  const apiBase = getFqSignApi(context);
  if (!apiBase) return {};
  const byId = {};
  // 并行拉四分类首屏：提取 filters（找剧 App 无 selector，通常为空）并预热翻页游标
  const jobs = FQ_CATEGORY_ORDER.map(async (cid) => {
    const tabType = FQ_APP_TABS[cid];
    try {
      const url =
        apiBase +
        "/api/fqsearch/category?" +
        new URLSearchParams({ tabType: String(tabType), offset: "0", count: "5" }).toString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FQ_SIGN_TIMEOUT);
      let resp;
      try {
        resp = await fetch(url, {
          method: "GET",
          headers: { "User-Agent": MOBILE_UA, Accept: "application/json" },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (resp.status !== 200) return;
      const json = JSON.parse(await resp.text());
      // 找剧不做标签筛选：即使将来返回 filters 也不挂到 home（产品决策）
      const filters = (json.data && json.data.filters) || [];
      if (cid !== "zhaoju" && Array.isArray(filters) && filters.length) byId[cid] = filters;
      // 顺便写游标，加快首次翻页
      const data = json.data || {};
      if (data.cellId) {
        const step =
          Number(data.nextOffset) > 0
            ? Number(data.nextOffset)
            : Math.max(1, ((data.books && data.books.length) || 6));
        _CACHE.cursor[`${tabType}|`] = {
          cellId: String(data.cellId),
          sessionId: data.sessionId ? String(data.sessionId) : "",
          step,
          nextOffset: step,
        };
      }
    } catch (e) {
      // ignore single tab failure
    }
  });
  await Promise.all(jobs);
  _CACHE.filters = { ts: now, byId };
  return byId;
}

async function searchViaSign(apiBase, keyword, page, searchId = "", offset = 0) {
  const q = new URLSearchParams({
    query: keyword,
    tabType: String(FQ_APP_TABS.recommend),
    offset: String(offset),
    count: String(PAGE_SIZE),
  });
  if (searchId) {
    q.set("searchId", searchId);
    q.set("passback", String(offset));
  }
  const url = apiBase + "/api/fqsearch/books?" + q.toString();
  const headers = { "User-Agent": MOBILE_UA, Accept: "application/json" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FQ_SIGN_TIMEOUT);
  let resp;
  try {
    resp = await fetch(url, { method: "GET", headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (resp.status !== 200 || !resp.body) return null;
  const body = await resp.text();
  if (!body) return null;
  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const data = json.data;
  if (!data || typeof data !== "object") return null;
  const books = data.books || [];
  if (!Array.isArray(books) || !books.length) return null;
  const hasMore = !!data.hasMore;
  const respSearchId = String(data.searchId || "");
  const items = [];
  for (const book of books) {
    const vod = bookToVod(book);
    if (vod) items.push(vod);
  }
  if (!items.length) return null;
  const total = items.length;
  return {
    page: Number(page),
    pagecount: Math.max(1, Number(page) + (hasMore ? 1 : 0)),
    total,
    has_more: hasMore,
    search_id: respSearchId,
    next_offset: Math.max(1, Number(page)) * PAGE_SIZE,
    list: items,
  };
}

async function search(params, context) {
  try {
    const keyword = (params.keyword || params.wd || "").toString().trim();
    const page = params.page || 1;
    if (!keyword) {
      return { page: 1, pagecount: 0, total: 0, list: [] };
    }

    const apiBase = getFqSignApi(context);
    if (!apiBase) {
      await OmniBox.log("error", "未配置 FQ_SIGN_API，无法执行 App 全量搜索");
      return { page: Number(page), pagecount: 0, total: 0, list: [] };
    }

    await OmniBox.log("info", `App 全量搜索红果短剧/电影: keyword=${keyword}, page=${page}`);
    try {
      const sid = String(params.search_id || "").trim();
      const off = toInt(params.next_offset) || (Math.max(1, Number(page)) - 1) * PAGE_SIZE;
      const signed = await withTimeout(
        searchViaSign(apiBase, keyword, page, sid, off),
        FQ_SIGN_TIMEOUT + 3000,
        "App 搜索"
      );
      if (signed != null) {
        await OmniBox.log("info", `App 搜索命中 ${signed.total} 条`);
        return signed;
      }
      await OmniBox.log("info", "App 搜索无结果");
      return {
        page: Number(page),
        pagecount: Math.max(1, Number(page)),
        total: 0,
        has_more: false,
        search_id: String(params.search_id || ""),
        next_offset: off,
        list: [],
      };
    } catch (e) {
      await OmniBox.log("error", `App 全量搜索失败: ${e.message}`);
      return { page: Number(page), pagecount: 0, total: 0, list: [] };
    }
  } catch (e) {
    await OmniBox.log("error", `搜索视频失败: ${e.message}`);
    return { page: Number(params.page || 1), pagecount: 0, total: 0, list: [] };
  }
}

async function play(params, context) {
  const playId = params.playId || "";
  if (!playId) throw new Error("playId 不能为空");
  const [seriesId, vid] = splitPlayId(playId);
  if (!seriesId || !vid) throw new Error("playId 格式应为 {series_id}__{vid}");

  await OmniBox.log("info", `解析播放地址: series=${seriesId}, vid=${vid}`);

  const apiBase = (context && context.videoModelApi) || VIDEO_MODEL_API;
  // 仅走 video_model 解析（含电影 DASH 流式合流）。不再回退 SSR 试看（仅 30 秒切片）。
  if (!apiBase) throw new ParseError("未配置 video_model 服务地址（videoModelApi / VIDEO_MODEL_API）");
  return await playViaVideoModel(apiBase, seriesId, vid, params, context);
}

async function cleanupVideoModelDisk(apiBase) {
  const base = (apiBase || "").toString().trim().replace(/\/+$/, "");
  if (!base) return;
  const url = `${base}/cleanup`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIDEO_MODEL_CLEANUP_TIMEOUT);
    let resp;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": MOBILE_UA },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (resp.status >= 400) {
      await OmniBox.log("warn", `video_model 清理落盘返回 HTTP ${resp.status}`);
      return;
    }
    await OmniBox.log("info", `已请求 video_model 清理落盘视频: ${url}`);
  } catch (e) {
    await OmniBox.log("warn", `video_model 清理落盘失败(已忽略): ${e.message}`);
  }
}

function rewriteLoopbackPlayUrl(playUrl, apiBase) {
  // video_model 若按 127.0.0.1 Host 绝对化，Docker/其它机器上的 OmniBox 无法回源。
  // 用爬虫自己的 apiBase 主机替换 loopback，保证 proxy-play 可达。
  try {
    const u = new URL(String(playUrl));
    const host = (u.hostname || "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return playUrl;
    const api = new URL(String(apiBase));
    u.protocol = api.protocol;
    u.hostname = api.hostname;
    u.port = api.port;
    return u.toString();
  } catch (_) {
    return playUrl;
  }
}

async function playViaVideoModel(apiBase, seriesId, vid, params, context) {
  const url = `${apiBase.replace(/\/+$/, "")}/api/videomodel?vid=${encodeURIComponent(String(vid))}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIDEO_MODEL_TIMEOUT);
    let resp;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": MOBILE_UA },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (resp.status !== 200) throw new ParseError(`video_model 服务返回 HTTP ${resp.status}`);
    const body = await resp.text();
    if (!body) throw new ParseError("video_model 服务返回空");
    const json = JSON.parse(body);
    if (json.code !== 0) throw new ParseError(`video_model 解析失败: ${json.message}`);
    const data = json.data || {};
    let playUrl = data.play_url || data.url || "";
    if (!playUrl) throw new ParseError("video_model 未返回可播放地址");
    playUrl = rewriteLoopbackPlayUrl(playUrl, apiBase);
    const header = { "User-Agent": MOBILE_UA };
    if (data.referer) header["Referer"] = data.referer;
    const playResponse = {
      urls: [{ name: "红果直链", url: playUrl }],
      flag: params.flag || "play",
      header,
      parse: 0,
    };
    if (data.needs_decrypt) {
      playResponse._warn = `该集为加密片源且服务端解密失败，播放可能失败；原因: ${data.decrypt_error || "unknown"}`;
    }
    return playResponse;
  } catch (e) {
    // 不再回退到 SSR 试看：SSR 仅 30 秒切片试看，且 video_model 已流式返回可播 HLS。
    // 若 video_model 失败，直接抛出明确错误，避免用户看到「只有 30 秒」的试看片。
    await OmniBox.log("error", `video_model 解析失败，未回退 SSR: ${e.message}`);
    throw new ParseError(`video_model 解析失败: ${e.message}`);
  }
}

async function playViaSsr(seriesId, vid, params) {
  try {
    let data;
    try {
      data = await requestShareForVid(seriesId, vid);
    } catch (e) {
      await OmniBox.log("warn", `分享页解析失败，回退 player 页: ${e.message}`);
      data = await requestPlayerForVid(seriesId, vid);
      if (data == null) throw new ParseError("分享页与 player 页均未能解析出直链");
    }
    const url = data.url;
    const referer = data.source_url || "https://novelquickapp.com/";
    const header = {
      "User-Agent": MOBILE_UA,
      Referer: referer,
    };
    const playResponse = {
      urls: [{ name: "红果直链", url }],
      flag: params.flag || "play",
      header,
      parse: 0,
    };
    if (data.short_ttl) {
      playResponse._warn = "直链剩余有效时间较短，播放可能超时";
    }
    return playResponse;
  } catch (e) {
    await OmniBox.log("error", `获取播放地址失败: ${e.message}`);
    return { urls: [], flag: params.flag || "", header: {} };
  }
}

// ==================== 入口 ====================
module.exports = { home, category, detail, search, play };

const runner = require("spider_runner");
runner.run(module.exports);
