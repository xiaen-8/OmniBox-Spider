// @name 豆瓣推荐
// @author lampon
// @description 豆瓣推荐爬虫脚本（整合多个豆瓣数据源，支持选电影/选剧集/选综艺/动漫剧集/筛选/Top250）
// @version 1.0.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/导航/豆瓣推荐.js

const OmniBox = require("omnibox_sdk");
const crypto = require("crypto");
const runner = require("spider_runner");

// ===================== 导出接口 =====================
module.exports = {
  home,
  category,
};
runner.run(module.exports);

// ===================== 豆瓣 API 基础配置 =====================
const DOUBAN_HOST = "https://frodo.douban.com/api/v2";
const DOUBAN_API_KEY = "0ac44ae016490db2204ce0a042db2916";
const DOUBAN_UA = "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.143 Safari/537.36 MicroMessenger/7.0.9.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat";
const DOUBAN_REFERER = "https://servicewechat.com/wx2f9b06c1de1ccfca/84/page-frame.html";
const DOUBAN_APP_UA_BASE = "Rexxar-Core/0.1.3 api-client/1 com.douban.frodo/7.9.0(216) Android/28 product/Xiaomi11 rom/android network/wifi";
const DOUBAN_SIGN_SECRET = "bf7dddc7c9cfe6f7";
const DOUBAN_APP_KEY = "0dad551ec0f84ed02907ff5c42e8ec70";
const DOUBAN_DEVICE_ID = crypto.randomBytes(20).toString("hex");
const DOUBAN_APP_UA = `${DOUBAN_APP_UA_BASE} udid/${DOUBAN_DEVICE_ID} platform/mobile com.douban.frodo/7.9.0(216) Rexxar/1.2.151 platform/mobile 1.2.151`;

// ===================== 时间显示开关 =====================
// 0 = 只显示年份（例如：2026 / 7.0分），1 = 显示完整日期（例如：2026.06.16 / 7.0分）
const FULL_DATE_DEFAULT = 0;

// ===================== 请求封装 =====================
const requestDouban = async (url, extraHeaders = {}) => {
  try {
    const separator = url.includes("?") ? "&" : "?";
    const finalUrl = `${url}${separator}apikey=${DOUBAN_API_KEY}`;
    const response = await OmniBox.request(finalUrl, {
      method: "GET",
      headers: {
        "User-Agent": DOUBAN_UA,
        "Referer": DOUBAN_REFERER,
        "Host": "frodo.douban.com",
        "Connection": "Keep-Alive",
        ...extraHeaders,
      },
    });
    if (response.statusCode === 200 && response.body) {
      return typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    }
    return null;
  } catch (e) {
    await OmniBox.log("error", `豆瓣请求失败: ${url}, 原因: ${e.message}`);
    return null;
  }
};

const buildSignedDoubanUrl = (url) => {
  const withBase = `${url}${url.includes("?") ? "&" : "?"}udid=${DOUBAN_DEVICE_ID}&uuid=${DOUBAN_DEVICE_ID}&&rom=android&apikey=${DOUBAN_APP_KEY}&s=rexxar_new&channel=Yingyongbao_Market&timezone=Asia/Shanghai&device_id=${DOUBAN_DEVICE_ID}&os_rom=android&apple=c52fbb99b908be4d026954cc4374f16d&mooncake=0f607264fc6318a92b9e13c65db7cd3c&sugar=0`;
  const pathname = new URL(withBase).pathname;
  const ts = Math.floor(Date.now() / 1000).toString();
  const signText = `GET&${encodeURIComponent(pathname)}&${ts}`;
  const sig = encodeURIComponent(crypto.createHmac("sha1", DOUBAN_SIGN_SECRET).update(signText).digest("base64"));
  return `${withBase}&_sig=${sig}&_ts=${ts}`;
};

const requestDoubanSigned = async (url) => {
  try {
    const response = await OmniBox.request(buildSignedDoubanUrl(url), {
      method: "GET",
      headers: { "User-Agent": DOUBAN_APP_UA },
    });
    if (response.statusCode === 200 && response.body) {
      return typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    }
    return null;
  } catch (e) {
    await OmniBox.log("error", `豆瓣签名请求失败: ${url}, 原因: ${e.message}`);
    return null;
  }
};

// m.douban.com 请求封装
const requestMDouban = async (url, referer = "https://movie.douban.com/tv/") => {
  try {
    const response = await OmniBox.request(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": referer,
        "Accept": "*/*",
        "Connection": "keep-alive",
      },
    });
    if (response.statusCode === 200 && response.body) {
      return typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    }
    return null;
  } catch (e) {
    await OmniBox.log("error", `m.douban请求失败: ${url}, 原因: ${e.message}`);
    return null;
  }
};

// m.douban.com 单页最多 20 条，并行请求多页凑齐 40 条
const fetchMDoubanItems = async (buildUrlFn, start, count, referer = "https://movie.douban.com/tv/") => {
  const pageSize = 20;
  const numReqs = Math.ceil(count / pageSize);
  const urls = [];
  for (let i = 0; i < numReqs; i++) {
    urls.push(buildUrlFn(start + i * pageSize, pageSize));
  }
  const results = await Promise.all(urls.map(url => requestMDouban(url, referer)));
  let allItems = [];
  let total = 0;
  for (const data of results) {
    if (data && data.items) {
      allItems.push(...data.items);
      total = Math.max(total, data.total || data.count || 0);
    }
  }
  return { items: allItems, total };
};

// 将 m.douban.com 条目归一化为统一的映射结构
const normalizeMDoubanItem = (rawItem) => {
  const item = { ...rawItem };
  if (rawItem.pic) {
    item.pic = {
      url: rawItem.pic.large || rawItem.pic.normal || '',
      normal: rawItem.pic.normal || ''
    };
  }
  if (rawItem.card_subtitle) {
    const yearMatch = String(rawItem.card_subtitle).match(/^(\d{4})/);
    if (yearMatch) item.year = yearMatch[1];
  }
  item._fromMDouban = true;
  return item;
};

// 从 m.douban.com 拉取剧集更新进度（episodes_info）
const fetchEpisodesInfoMap = async (id, filters, start, count) => {
  const map = new Map();

  const t1U = String(filters?.u || '');
  const isTvT1 = id === 't1' && (t1U.includes('tv') || t1U.includes('show') || t1U.includes('animation'));
  const isHotTv = id === 'hot_tv' || id === 'hot_show';
  if (!isTvT1 && !isHotTv) return map;

  const urls = [];
  const M_BASE = "https://m.douban.com/rexxar/api/v2";

  if (isHotTv) {
    let category = 'tv', mtype = 'tv';
    if (id === 'hot_show') { category = 'show'; mtype = 'show'; }
    for (let s = start; s < start + count; s += 20) {
      urls.push(`${M_BASE}/subject/recent_hot/tv?start=${s}&limit=20&category=${category}&type=${mtype}`);
    }
  } else {
    let category = 'tv', mtype = 'tv';
    if (t1U.includes('show')) { category = 'show'; mtype = 'show'; }
    for (let s = start; s < start + count; s += 20) {
      urls.push(`${M_BASE}/subject/recent_hot/tv?start=${s}&limit=20&category=${category}&type=${mtype}`);
    }
  }

  if (urls.length === 0) return map;

  const results = await Promise.all(urls.map((url) => requestMDouban(url)));
  for (const data of results) {
    if (!data || !data.items) continue;
    for (const item of data.items) {
      const itemId = String(item.id || '');
      if (itemId && item.episodes_info && String(item.episodes_info).trim()) {
        map.set(itemId, String(item.episodes_info).trim());
      }
    }
  }

  await OmniBox.log("info", `[m.douban] 剧集进度补充: 请求 ${urls.length} 页, 获取 ${map.size} 条 episodes_info`);
  return map;
};

// ===================== 分类筛选配置 =====================
const FULL_DATE_FILTER = {
  key: "fullDate",
  name: "日期",
  init: "0",
  value: [
    { name: "只显示年份", value: "0" },
    { name: "显示完整日期", value: "1" },
  ],
};

const filterConfig = {
  // 选电影（m.douban.com recent_hot/movie）
  "movie":[
    { "key": "category", "name": "类型", "init": "热门", "value":[
      { "name": "热门", "value": "热门" }, { "name": "最新", "value": "最新" }, { "name": "豆瓣高分", "value": "豆瓣高分" }, { "name": "冷门佳片", "value": "冷门佳片" }
    ]},
    { "key": "type", "name": "地区", "init": "全部", "value":[
      { "name": "全部", "value": "全部" }, { "name": "华语", "value": "华语" }, { "name": "欧美", "value": "欧美" }, { "name": "韩国", "value": "韩国" }, { "name": "日本", "value": "日本" }
    ]},
    FULL_DATE_FILTER
  ],
  // 选剧集（m.douban.com recent_hot/tv）
  "tv":[
    { "key": "type", "name": "类型", "init": "tv", "value":[
      { "name": "综合", "value": "tv" }, { "name": "国产剧", "value": "tv_domestic" }, { "name": "欧美剧", "value": "tv_american" },
      { "name": "日剧", "value": "tv_japanese" }, { "name": "韩剧", "value": "tv_korean" }, { "name": "动漫", "value": "tv_animation" }, { "name": "纪录片", "value": "tv_documentary" }
    ]},
    FULL_DATE_FILTER
  ],
  // 选综艺（m.douban.com recent_hot/tv）
  "show":[
    { "key": "type", "name": "类型", "init": "show", "value":[
      { "name": "综合", "value": "show" }, { "name": "国内", "value": "show_domestic" }, { "name": "国外", "value": "show_foreign" }
    ]},
    FULL_DATE_FILTER
  ],
  // 动漫剧集（frodo API tv/recommend，按"动画"标签聚合）
  "anime":[
    { "key": "genre", "name": "类型", "init": "", "value":[{ "name": "全部类型", "value": "" }, { "name": "动画", "value": "动画" }, { "name": "日本动画", "value": "日本动画" }, { "name": "国产动画", "value": "国产动画" }, { "name": "欧美动画", "value": "欧美动画" }, { "name": "剧场版", "value": "剧场版" }, { "name": "番剧", "value": "番剧" }] },
    { "key": "region", "name": "地区", "init": "", "value":[{ "name": "全部地区", "value": "" }, { "name": "日本", "value": "日本" }, { "name": "中国大陆", "value": "中国大陆" }, { "name": "美国", "value": "美国" }, { "name": "欧美", "value": "欧美" }] },
    { "key": "year", "name": "年代", "init": "", "value":[{ "name": "全部年代", "value": "" }, { "name": "2026", "value": "2026" }, { "name": "2025", "value": "2025" }, { "name": "2024", "value": "2024" }, { "name": "2023", "value": "2023" }, { "name": "2022", "value": "2022" }, { "name": "2021", "value": "2021" }, { "name": "2020", "value": "2020" }, { "name": "2010年代", "value": "2010年代" }] },
    { "key": "sort", "name": "排序", "init": "U", "value":[{ "name": "近期热度", "value": "U" }, { "name": "综合排序", "value": "T" }, { "name": "首播时间", "value": "R" }, { "name": "高分优先", "value": "S" }] },
    FULL_DATE_FILTER
  ],
  // 电影筛选（m.douban.com movie/recommend）
  "movie_filter":[
    { "key": "genre", "name": "类型", "init": "", "value":[
      { "name": "全部", "value": "" }, { "name": "喜剧", "value": "喜剧" }, { "name": "爱情", "value": "爱情" }, { "name": "动作", "value": "动作" }, { "name": "科幻", "value": "科幻" },
      { "name": "动画", "value": "动画" }, { "name": "悬疑", "value": "悬疑" }, { "name": "犯罪", "value": "犯罪" }, { "name": "惊悚", "value": "惊悚" }, { "name": "冒险", "value": "冒险" },
      { "name": "音乐", "value": "音乐" }, { "name": "历史", "value": "历史" }, { "name": "奇幻", "value": "奇幻" }, { "name": "恐怖", "value": "恐怖" }, { "name": "战争", "value": "战争" },
      { "name": "传记", "value": "传记" }, { "name": "歌舞", "value": "歌舞" }, { "name": "武侠", "value": "武侠" }, { "name": "情色", "value": "情色" }, { "name": "灾难", "value": "灾难" },
      { "name": "西部", "value": "西部" }, { "name": "纪录片", "value": "纪录片" }, { "name": "短片", "value": "短片" }
    ]},
    { "key": "region", "name": "地区", "init": "", "value":[
      { "name": "全部", "value": "" }, { "name": "华语", "value": "华语" }, { "name": "欧美", "value": "欧美" }, { "name": "韩国", "value": "韩国" }, { "name": "日本", "value": "日本" },
      { "name": "中国大陆", "value": "中国大陆" }, { "name": "美国", "value": "美国" }, { "name": "中国香港", "value": "中国香港" }, { "name": "中国台湾", "value": "中国台湾" },
      { "name": "英国", "value": "英国" }, { "name": "法国", "value": "法国" }, { "name": "德国", "value": "德国" }, { "name": "意大利", "value": "意大利" }, { "name": "西班牙", "value": "西班牙" },
      { "name": "印度", "value": "印度" }, { "name": "泰国", "value": "泰国" }, { "name": "俄罗斯", "value": "俄罗斯" }, { "name": "加拿大", "value": "加拿大" },
      { "name": "澳大利亚", "value": "澳大利亚" }, { "name": "爱尔兰", "value": "爱尔兰" }, { "name": "瑞典", "value": "瑞典" }, { "name": "巴西", "value": "巴西" }, { "name": "丹麦", "value": "丹麦" }
    ]},
    { "key": "year", "name": "年代", "init": "", "value":[
      { "name": "全部", "value": "" }, { "name": "2026", "value": "2026" }, { "name": "2025", "value": "2025" }, { "name": "2024", "value": "2024" }, { "name": "2023", "value": "2023" },
      { "name": "2022", "value": "2022" }, { "name": "2021", "value": "2021" }, { "name": "2020", "value": "2020" }, { "name": "2019", "value": "2019" },
      { "name": "2020年代", "value": "2020年代" }, { "name": "2010年代", "value": "2010年代" }, { "name": "2000年代", "value": "2000年代" },
      { "name": "90年代", "value": "90年代" }, { "name": "80年代", "value": "80年代" }, { "name": "70年代", "value": "70年代" }, { "name": "60年代", "value": "60年代" }, { "name": "更早", "value": "更早" }
    ]},
    { "key": "sort", "name": "排序", "init": "U", "value":[
      { "name": "热度", "value": "U" }, { "name": "评分", "value": "S" }, { "name": "时间", "value": "R" }
    ]},
    FULL_DATE_FILTER
  ],
  // 电视剧筛选（m.douban.com tv/recommend）
  "tv_filter":[
    { "key": "genre", "name": "类型", "init": "", "value":[
      { "name": "全部", "value": "" }, { "name": "喜剧", "value": "喜剧" }, { "name": "爱情", "value": "爱情" }, { "name": "悬疑", "value": "悬疑" }, { "name": "动画", "value": "动画" },
      { "name": "武侠", "value": "武侠" }, { "name": "古装", "value": "古装" }, { "name": "家庭", "value": "家庭" }, { "name": "犯罪", "value": "犯罪" }, { "name": "科幻", "value": "科幻" },
      { "name": "恐怖", "value": "恐怖" }, { "name": "历史", "value": "历史" }, { "name": "战争", "value": "战争" }, { "name": "动作", "value": "动作" }, { "name": "冒险", "value": "冒险" },
      { "name": "传记", "value": "传记" }, { "name": "剧情", "value": "剧情" }, { "name": "奇幻", "value": "奇幻" }, { "name": "惊悚", "value": "惊悚" },
      { "name": "灾难", "value": "灾难" }, { "name": "歌舞", "value": "歌舞" }, { "name": "音乐", "value": "音乐" }
    ]},
    { "key": "region", "name": "地区", "init": "", "value":[
      { "name": "全部", "value": "" }, { "name": "华语", "value": "华语" }, { "name": "欧美", "value": "欧美" }, { "name": "国外", "value": "国外" }, { "name": "韩国", "value": "韩国" },
      { "name": "日本", "value": "日本" }, { "name": "中国大陆", "value": "中国大陆" }, { "name": "中国香港", "value": "中国香港" }, { "name": "美国", "value": "美国" },
      { "name": "英国", "value": "英国" }, { "name": "泰国", "value": "泰国" }, { "name": "中国台湾", "value": "中国台湾" }, { "name": "意大利", "value": "意大利" },
      { "name": "法国", "value": "法国" }, { "name": "德国", "value": "德国" }, { "name": "西班牙", "value": "西班牙" }, { "name": "俄罗斯", "value": "俄罗斯" },
      { "name": "瑞典", "value": "瑞典" }, { "name": "巴西", "value": "巴西" }, { "name": "丹麦", "value": "丹麦" }, { "name": "印度", "value": "印度" },
      { "name": "加拿大", "value": "加拿大" }, { "name": "爱尔兰", "value": "爱尔兰" }, { "name": "澳大利亚", "value": "澳大利亚" }
    ]},
    { "key": "year", "name": "年代", "init": "", "value":[
      { "name": "全部", "value": "" }, { "name": "2026", "value": "2026" }, { "name": "2025", "value": "2025" }, { "name": "2024", "value": "2024" }, { "name": "2023", "value": "2023" },
      { "name": "2022", "value": "2022" }, { "name": "2021", "value": "2021" }, { "name": "2020", "value": "2020" }, { "name": "2019", "value": "2019" },
      { "name": "2020年代", "value": "2020年代" }, { "name": "2010年代", "value": "2010年代" }, { "name": "2000年代", "value": "2000年代" },
      { "name": "90年代", "value": "90年代" }, { "name": "80年代", "value": "80年代" }, { "name": "70年代", "value": "70年代" }, { "name": "60年代", "value": "60年代" }, { "name": "更早", "value": "更早" }
    ]},
    { "key": "platform", "name": "平台", "init": "", "value":[
      { "name": "全部", "value": "" }, { "name": "腾讯视频", "value": "腾讯视频" }, { "name": "爱奇艺", "value": "爱奇艺" }, { "name": "优酷", "value": "优酷" },
      { "name": "湖南卫视", "value": "湖南卫视" }, { "name": "Netflix", "value": "Netflix" }, { "name": "HBO", "value": "HBO" }, { "name": "BBC", "value": "BBC" },
      { "name": "NHK", "value": "NHK" }, { "name": "CBS", "value": "CBS" }, { "name": "NBC", "value": "NBC" }, { "name": "tvN", "value": "tvN" }
    ]},
    { "key": "sort", "name": "排序", "init": "U", "value":[
      { "name": "热度", "value": "U" }, { "name": "评分", "value": "S" }, { "name": "时间", "value": "R" }
    ]},
    FULL_DATE_FILTER
  ],
  // 综艺筛选（frodo /tv/recommend）
  "show_filter":[
    { "key": "genre", "name": "类型", "init": "", "value":[{ "name": "全部类型", "value": "" }, { "name": "真人秀", "value": "真人秀" }, { "name": "脱口秀", "value": "脱口秀" }, { "name": "音乐", "value": "音乐" }, { "name": "喜剧", "value": "喜剧" }, { "name": "纪实", "value": "纪实" }] },
    { "key": "region", "name": "地区", "init": "", "value":[{ "name": "全部地区", "value": "" }, { "name": "中国大陆", "value": "中国大陆" }, { "name": "韩国", "value": "韩国" }, { "name": "港台", "value": "港台" }, { "name": "欧美", "value": "欧美" }] },
    { "key": "year", "name": "年代", "init": "", "value":[{ "name": "全部年代", "value": "" }, { "name": "2026", "value": "2026" }, { "name": "2025", "value": "2025" }, { "name": "2024", "value": "2024" }, { "name": "2023", "value": "2023" }, { "name": "2022", "value": "2022" }, { "name": "2021", "value": "2021" }, { "name": "2020", "value": "2020" }] },
    { "key": "sort", "name": "排序", "init": "U", "value":[{ "name": "近期热度", "value": "U" }, { "name": "综合排序", "value": "T" }, { "name": "首播时间", "value": "R" }, { "name": "高分优先", "value": "S" }] },
    FULL_DATE_FILTER
  ],
  // 电影Top250（frodo API）
  "top_250":[
    { "key": "slug", "name": "榜单", "init": "movie_top250", "value":[{ "name": "豆瓣电影Top250", "value": "movie_top250" }] },
    FULL_DATE_FILTER
  ]
};

// ===================== 分类名称 =====================
const categoryNames = {
  movie: "选电影",
  tv: "选剧集",
  show: "选综艺",
  anime: "动漫剧集",
  movie_filter: "电影筛选",
  tv_filter: "电视剧筛选",
  show_filter: "综艺筛选",
  top_250: "电影Top250",
};

// ===================== 整页缓存与详情缓存 =====================
const pageCache = new Map();

const subjectCache = new Map();
const subjectPending = new Map();
const SUBJECT_CACHE_TTL = 6 * 60 * 60 * 1000;

const requestSubjectDetail = async (subjectId) => {
  subjectId = String(subjectId || '').trim();
  if (!/^\d+$/.test(subjectId)) return null;

  const now = Date.now();
  const cached = subjectCache.get(subjectId);
  if (cached && now - cached.time < SUBJECT_CACHE_TTL) {
    return cached.data;
  }

  if (subjectPending.has(subjectId)) {
    return await subjectPending.get(subjectId);
  }

  const pending = requestDouban(`${DOUBAN_HOST}/subject/${subjectId}`)
    .then((data) => {
      if (data) subjectCache.set(subjectId, { data, time: Date.now() });
      return data;
    })
    .finally(() => subjectPending.delete(subjectId));

  subjectPending.set(subjectId, pending);
  return await pending;
};

// 为各分类补齐缺省的筛选参数
const normalizeFilters = (id, filters = {}) => {
  const f = { ...(filters || {}) };
  if (id === 'movie' && !f.category) f.category = '热门';
  if (id === 'movie' && !f.type) f.type = '全部';
  if ((id === 'tv' || id === 'show') && !f.type) f.type = id;
  if (id === 'anime' && !f.sort) f.sort = 'U';
  if ((id === 'movie_filter' || id === 'tv_filter') && !f.sort) f.sort = 'U';
  if (id === 'show_filter' && !f.sort) f.sort = 'U';
  if ((id === 'hot_movie' || id === 'hot_tv' || id === 'hot_show') && !f.slug) f.slug = 'all';
  if (id === 'top_250' && !f.slug) f.slug = 'movie_top250';
  return f;
};

// 生成页面缓存键
const getPageCacheKey = (id, page, filters) => {
  return `${id}_${page}_${JSON.stringify(normalizeFilters(id, filters))}`;
};

// recommend 接口会夹带榜单/类型入口卡片，这些不是影视条目
const getDoubanSubjectId = (item) => {
  const candidates = [item?.subject?.id, item?.id];
  const id = candidates.find((value) => /^\d+$/.test(String(value || '').trim()));
  return id ? String(id).trim() : '';
};

// 解析时间显示开关：filters 里的 fullDate 优先，未设置时回退到 FULL_DATE_DEFAULT
const resolveFullDate = (filters) => {
  const v = filters && filters.fullDate;
  if (v === 1 || v === '1' || v === true) return 1;
  if (v === 0 || v === '0' || v === false) return 0;
  return FULL_DATE_DEFAULT;
};

// 从 pubdate 中提取完整日期并格式化为 yyyy.mm.dd
const extractFullDate = (str) => {
  if (!str) return '';
  const m = String(str).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return '';
  const y = m[1];
  const mo = String(m[2]).padStart(2, '0');
  const d = String(m[3]).padStart(2, '0');
  return `${y}.${mo}.${d}`;
};

// 图片代理（通过 context.baseURL 通用代理接口）
const buildProxyPic = (pic, context) => {
  let p = String(pic || '').replace(/img\d\.doubanio\.com/g, 'img1.doubanio.com');
  if (!p) return '';
  const baseURL = (context && context.baseURL) || '';
  const urlWithHeaders = `${p}@Referer=https://movie.douban.com`;
  if (baseURL) {
    return `${baseURL}/api/proxy/image?url=${encodeURIComponent(urlWithHeaders)}`;
  }
  return urlWithHeaders;
};

const buildDoubanSubjectLink = (vodId) => `https://movie.douban.com/subject/${vodId}`;

// ===================== 分类列表抓取主逻辑 =====================
const fetchCategoryLive = async ({ id, page, filters, context }) => {
  let pg = parseInt(page);
  if (isNaN(pg) || pg < 1) pg = 1;

  const count = 40;
  const start = (pg - 1) * count;

  let items = [];
  let total = 0;
  filters = normalizeFilters(id, filters);

  let mDoubanUrlFn = null;
  let mDoubanReferer = "https://movie.douban.com/tv/";

  const mergeUniqueItems = (arr = []) => {
    const seen = new Set(items.map(getDoubanSubjectId).filter(Boolean));
    for (const x of arr) {
      const k = getDoubanSubjectId(x);
      if (!k) continue;
      if (!seen.has(k)) {
        seen.add(k);
        items.push(x);
      }
    }
  };

  try {
    // 电影Top250（frodo API）
    if (id === 'top_250') {
      const data = await requestDouban(`${DOUBAN_HOST}/subject_collection/movie_top250/items?start=${start}&count=${count}`);
      if (data) {
        mergeUniqueItems(data.subject_collection_items || data.items || []);
        total = data.total || (data.subject_collection ? data.subject_collection.total : 0) || 250;
      }
    }
    // 电影/剧集/综艺榜单（首页推荐使用）
    else if (id === 'hot_movie' || id === 'hot_tv' || id === 'hot_show') {
      let slugs = [];
      if (id === 'hot_movie') slugs = ['movie_real_time_hotest', 'movie_weekly_best'];
      else if (id === 'hot_tv') slugs = ['tv_real_time_hotest', 'tv_chinese_best_weekly', 'tv_global_best_weekly'];
      else if (id === 'hot_show') slugs = ['tv_variety_show', 'show_chinese_best_weekly'];

      const slug = filters.slug || 'all';
      if (slug === 'all') {
        const datas = await Promise.all(slugs.map((s) =>
          requestDouban(`${DOUBAN_HOST}/subject_collection/${s}/items?start=${start}&count=${count}`)
        ));
        for (const data of datas) {
          if (data) mergeUniqueItems(data.subject_collection_items || data.items || []);
        }
        total = Math.max(items.length, count);
      } else {
        const data = await requestDouban(`${DOUBAN_HOST}/subject_collection/${slug}/items?start=${start}&count=${count}`);
        if (data) {
          mergeUniqueItems(data.subject_collection_items || data.items || []);
          total = data.total || (data.subject_collection ? data.subject_collection.total : 0) || 100;
        }
      }
    }
    // 动漫剧集（frodo API tv/recommend，按"动画"标签聚合）
    else if (id === 'anime') {
      const tags = [filters?.genre, filters?.region, filters?.year, filters?.platform, '动画'].filter(Boolean).join(',');
      const sort = filters?.sort || 'U';
      const data = await requestDouban(`${DOUBAN_HOST}/tv/recommend?tags=${encodeURIComponent(tags)}&sort=${sort}&start=${start}&count=${count}`);
      if (data && data.items) {
        mergeUniqueItems(data.items);
        total = data.total || 999;
      }
    }
    // 选电影（m.douban.com recent_hot/movie）
    else if (id === 'movie') {
      const category = filters.category || '热门';
      const type = filters.type || '全部';
      mDoubanUrlFn = (s, limit) =>
        `https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie?start=${s}&limit=${limit}&category=${encodeURIComponent(category)}&type=${encodeURIComponent(type)}`;
      mDoubanReferer = "https://movie.douban.com/explore";
      const { items: fetchedItems, total: fetchedTotal } = await fetchMDoubanItems(mDoubanUrlFn, start, count, mDoubanReferer);
      mergeUniqueItems(fetchedItems.map(normalizeMDoubanItem));
      total = fetchedTotal || 999;
    }
    // 选剧集 / 选综艺（m.douban.com recent_hot/tv）
    else if (id === 'tv' || id === 'show') {
      const type = filters.type || id;
      mDoubanUrlFn = (s, limit) =>
        `https://m.douban.com/rexxar/api/v2/subject/recent_hot/tv?start=${s}&limit=${limit}&category=${id}&type=${encodeURIComponent(type)}`;
      mDoubanReferer = "https://movie.douban.com/tv/";
      const { items: fetchedItems, total: fetchedTotal } = await fetchMDoubanItems(mDoubanUrlFn, start, count, mDoubanReferer);
      mergeUniqueItems(fetchedItems.map(normalizeMDoubanItem));
      total = fetchedTotal || 999;
    }
    // 电影筛选（m.douban.com movie/recommend）
    else if (id === 'movie_filter') {
      const genre = filters.genre || '';
      const region = filters.region || '';
      const year = filters.year || '';
      const sort = filters.sort || 'U';
      const selectedCategories = {};
      if (genre) selectedCategories["类型"] = genre;
      if (region) selectedCategories["地区"] = region;
      const selectedCategoriesStr = JSON.stringify(selectedCategories);
      const tagsArray = [genre, region, year].filter(Boolean);
      const tags = tagsArray.join(",");
      mDoubanUrlFn = (s, limit) =>
        `https://m.douban.com/rexxar/api/v2/movie/recommend?refresh=0&start=${s}&count=${limit}&selected_categories=${encodeURIComponent(selectedCategoriesStr)}&uncollect=false&score_range=0,10&tags=${encodeURIComponent(tags)}&sort=${sort}`;
      mDoubanReferer = "https://movie.douban.com/explore";
      const { items: fetchedItems, total: fetchedTotal } = await fetchMDoubanItems(mDoubanUrlFn, start, count, mDoubanReferer);
      mergeUniqueItems(fetchedItems.map(normalizeMDoubanItem));
      total = fetchedTotal || 999;
    }
    // 电视剧筛选（m.douban.com tv/recommend）
    else if (id === 'tv_filter') {
      const genre = filters.genre || '';
      const region = filters.region || '';
      const year = filters.year || '';
      const platform = filters.platform || '';
      const sort = filters.sort || 'U';
      const selectedCategories = { "形式": "电视剧" };
      if (genre) selectedCategories["类型"] = genre;
      if (region) selectedCategories["地区"] = region;
      const selectedCategoriesStr = JSON.stringify(selectedCategories);
      const tagsArray = [genre, region, year, platform].filter(Boolean);
      const tags = tagsArray.join(",");
      mDoubanUrlFn = (s, limit) =>
        `https://m.douban.com/rexxar/api/v2/tv/recommend?refresh=0&start=${s}&count=${limit}&selected_categories=${encodeURIComponent(selectedCategoriesStr)}&uncollect=false&score_range=0,10&tags=${encodeURIComponent(tags)}&sort=${sort}`;
      mDoubanReferer = "https://movie.douban.com/tv/";
      const { items: fetchedItems, total: fetchedTotal } = await fetchMDoubanItems(mDoubanUrlFn, start, count, mDoubanReferer);
      mergeUniqueItems(fetchedItems.map(normalizeMDoubanItem));
      total = fetchedTotal || 999;
    }
    // 综艺筛选（frodo /tv/recommend）
    else if (id === 'show_filter') {
      const tags = [filters?.genre, filters?.region, filters?.year, '综艺'].filter(Boolean).join(',');
      const sort = filters?.sort || 'U';
      const data = await requestDouban(`${DOUBAN_HOST}/tv/recommend?tags=${encodeURIComponent(tags)}&sort=${sort}&start=${start}&count=${count}`);
      if (data && data.items) {
        mergeUniqueItems(data.items);
        total = data.total || 999;
      }
    }

    // 不足 40 条时自动翻页补齐（最多 3 轮）
    let offset = start + count;
    for (let round = 0; round < 3 && items.length < count; round++) {
      const before = items.length;

      if (id === 'top_250') {
        const data = await requestDouban(`${DOUBAN_HOST}/subject_collection/movie_top250/items?start=${offset}&count=${count}`);
        if (data) mergeUniqueItems(data.subject_collection_items || data.items || []);
      } else if (id === 'hot_movie' || id === 'hot_tv' || id === 'hot_show') {
        let slugs = [];
        if (id === 'hot_movie') slugs = ['movie_real_time_hotest', 'movie_weekly_best'];
        else if (id === 'hot_tv') slugs = ['tv_real_time_hotest', 'tv_chinese_best_weekly', 'tv_global_best_weekly'];
        else if (id === 'hot_show') slugs = ['tv_variety_show', 'show_chinese_best_weekly'];
        const slug = filters.slug || 'all';
        if (slug === 'all') {
          const datas = await Promise.all(slugs.map((s) =>
            requestDouban(`${DOUBAN_HOST}/subject_collection/${s}/items?start=${offset}&count=${count}`)
          ));
          for (const data of datas) {
            if (data) mergeUniqueItems(data.subject_collection_items || data.items || []);
          }
        } else {
          const data = await requestDouban(`${DOUBAN_HOST}/subject_collection/${slug}/items?start=${offset}&count=${count}`);
          if (data) mergeUniqueItems(data.subject_collection_items || data.items || []);
        }
      } else if (id === 'anime') {
        const tags = [filters?.genre, filters?.region, filters?.year, filters?.platform, '动画'].filter(Boolean).join(',');
        const sort = filters?.sort || 'U';
        const data = await requestDouban(`${DOUBAN_HOST}/tv/recommend?tags=${encodeURIComponent(tags)}&sort=${sort}&start=${offset}&count=${count}`);
        if (data && data.items) mergeUniqueItems(data.items);
      } else if (id === 'show_filter') {
        const tags = [filters?.genre, filters?.region, filters?.year, '综艺'].filter(Boolean).join(',');
        const sort = filters?.sort || 'U';
        const data = await requestDouban(`${DOUBAN_HOST}/tv/recommend?tags=${encodeURIComponent(tags)}&sort=${sort}&start=${offset}&count=${count}`);
        if (data && data.items) mergeUniqueItems(data.items);
      } else if (mDoubanUrlFn) {
        const { items: fillItems } = await fetchMDoubanItems(mDoubanUrlFn, offset, count, mDoubanReferer);
        if (fillItems.length) mergeUniqueItems(fillItems.map(normalizeMDoubanItem));
      }

      if (items.length === before) break;
      offset += count;
    }

    // 先取前 40 条再补详情
    const pickedItems = [];
    const pickedSeen = new Set();
    for (const it of items) {
      const rawId = getDoubanSubjectId(it);
      if (!rawId || pickedSeen.has(String(rawId))) continue;
      pickedSeen.add(String(rawId));
      pickedItems.push(it);
      if (pickedItems.length >= count) break;
    }
    items = pickedItems;

    // 从 m.douban.com 补充剧集更新进度
    try {
      const episodesInfoMap = await fetchEpisodesInfoMap(id, filters, start, count);
      if (episodesInfoMap.size > 0) {
        for (const it of items) {
          const rawId = getDoubanSubjectId(it);
          if (rawId && episodesInfoMap.has(String(rawId))) {
            it.episodes_info = episodesInfoMap.get(String(rawId));
          }
        }
      }
    } catch (e) {
      await OmniBox.log("warn", `[m.douban] 剧集进度补充失败: ${e.message}`);
    }

    const hasFullPubdate = (it) => {
      const sub = it.subject || {};
      const raw = sub.pubdate || sub.release_date || it.pubdate || it.release_date || '';
      return /\d{4}[-/.年]\d{1,2}/.test(String(raw));
    };

    const fullDateOn = resolveFullDate(filters);

    const isTvCategory = ['tv', 'tv_filter', 'show', 'hot_tv', 'hot_show'].includes(id);

    const needYearDetail = items.filter((it) => {
      if (it._fromMDouban) {
        if (fullDateOn === 1 && !hasFullPubdate(it)) return true;
        if (isTvCategory) {
          const hasEp = it.episodes_info || it.episodes_count || it.current_episode;
          if (!hasEp) return true;
        }
        return false;
      }
      if (!hasFullPubdate(it)) return true;
      if (isTvCategory) {
        const hasEp = it.episodes_info || (it.subject && it.subject.episodes_info) || it.episodes_count || (it.subject && it.subject.episodes_count);
        if (!hasEp) return true;
      }
      return false;
    });

    for (let i = 0; i < needYearDetail.length; i += 40) {
      const batch = needYearDetail.slice(i, i + 40);
      await Promise.all(batch.map(async (it) => {
        const rawId = getDoubanSubjectId(it);
        if (!rawId) return;

        const detail = await requestSubjectDetail(String(rawId));
        if (!detail) return;

        const pubdates = Array.isArray(detail.pubdates) ? detail.pubdates.filter(Boolean) : [];
        const firstPubdate = pubdates[0] || '';

        if (detail.pubdate) it.pubdate = detail.pubdate;
        else if (firstPubdate) it.pubdate = firstPubdate;

        if (detail.release_date) it.release_date = detail.release_date;
        if (detail.year && !it.year) it.year = detail.year;
        if (detail.episodes_info) it.episodes_info = detail.episodes_info;
        if (detail.episodes_count) it.episodes_count = detail.episodes_count;
        if (detail.current_episode) it.current_episode = detail.current_episode;
      }));
    }

    // 映射为 Omnibox 卡片格式
    const list = items.map((it) => {
      const title = it.title || (it.subject && it.subject.title) || '未知';
      const rawId = getDoubanSubjectId(it);
      if (!rawId) return null;

      const ratingObj = it.rating || (it.subject && it.subject.rating);
      const picObj = it.cover || it.pic || (it.subject && it.subject.pic);
      const pic = picObj ? (picObj.url || picObj.normal || '') : '';
      if (!pic) return null;

      let pubdate = '';
      let yearStr = '';

      const sub = it.subject || {};
      if (sub.pubdate) { pubdate = sub.pubdate; }
      else if (sub.release_date) { pubdate = sub.release_date; }
      else if (it.pubdate) { pubdate = it.pubdate; }
      else if (it.release_date) { pubdate = it.release_date; }
      else if (sub.year) { yearStr = sub.year; }
      else if (it.year) { yearStr = it.year; }

      if (!pubdate && !yearStr && title) {
        const titleYear = String(title).match(/\((\d{4})\)/) || String(title).match(/\[(\d{4})\]/) || String(title).match(/[-\s](\d{4})[-\s]/) || String(title).match(/(\d{4})年/);
        if (titleYear) yearStr = titleYear[1];
      }

      let yearOnly = '';
      if (pubdate) {
        const ym = String(pubdate).match(/\d{4}/);
        if (ym) yearOnly = ym[0];
      }
      if (!yearOnly && yearStr) {
        const ym = String(yearStr).match(/\d{4}/);
        if (ym) yearOnly = ym[0];
      }

      const fullDateOn = resolveFullDate(filters);
      let dateLabel = yearOnly;
      if (fullDateOn === 1) {
        const fd = extractFullDate(pubdate) || extractFullDate(yearStr);
        if (fd) dateLabel = fd;
      }

      let episodeInfo = '';
      const rawEpInfo = it.episodes_info || (it.subject && it.subject.episodes_info) || '';
      if (rawEpInfo && String(rawEpInfo).trim()) {
        let epStr = String(rawEpInfo).trim();
        epStr = epStr.replace(/更新至第(\d+)集/, '更新至$1集');
        epStr = epStr.replace(/共(\d+)集/, '全$1集');
        epStr = epStr.replace(/(\d+)集全/, '全$1集');
        episodeInfo = epStr;
      } else {
        const epCount = it.episodes_count || (it.subject && it.subject.episodes_count);
        const currentEp = it.current_episode || (it.subject && it.subject.current_episode);
        if (currentEp) {
          episodeInfo = `更新至${currentEp}集`;
        } else if (epCount) {
          episodeInfo = `全${epCount}集`;
        }
      }

      // 卡片副标题：时间 / 评分
      const scoreStr = ratingObj?.value ? ratingObj.value.toFixed(1) : '0';
      let vodRemarks = dateLabel ? `${dateLabel} / ${scoreStr}分` : scoreStr + '分';

      // 卡片左上角：剧集更新进度
      const vodYear = episodeInfo || '';

      return {
        vod_id: String(rawId).trim(),
        link: buildDoubanSubjectLink(String(rawId).trim()),
        vod_name: title,
        vod_pic: buildProxyPic(pic, context),
        vod_remarks: vodRemarks,
        vod_year: vodYear,
        vod_douban_score: ratingObj?.value ? ratingObj.value.toFixed(1) : '',
        type_id: id,
        type_name: categoryNames[id] || '',
        search: true,
      };
    }).filter(Boolean);

    const seenVod = new Set();
    const finalList = [];
    for (const v of list) {
      if (!seenVod.has(v.vod_id)) {
        seenVod.add(v.vod_id);
        finalList.push(v);
      }
      if (finalList.length >= count) break;
    }

    return {
      list: finalList,
      page: pg,
      pagecount: Math.ceil((total || finalList.length) / count) || pg + 1,
      limit: count,
      total: Math.max(total || 0, finalList.length)
    };
  } catch (error) {
    await OmniBox.log("error", `获取豆瓣分类失败 [${id}]: ${error.message}`);
    return { list: [], page: pg, pagecount: 1, limit: count, total: 0 };
  }
};

// ===================== 读写分离缓存包装 =====================
const _category = async ({ id, page, filters, context }) => {
  const cacheKey = getPageCacheKey(id, page, filters);

  const cachedPage = pageCache.get(cacheKey);
  if (cachedPage) {
    cachedPage.lastAccess = Date.now();
    return cachedPage.data;
  }

  await OmniBox.log("info", `[首次加载] 正在实时抓取豆瓣分类: ${cacheKey}`);
  const liveData = await fetchCategoryLive({ id, page, filters, context });
  pageCache.set(cacheKey, { data: liveData, lastAccess: Date.now() });
  return liveData;
};

// ===================== 首页推荐混合列表 =====================
// 使用 hot_movie / hot_tv / hot_show 榜单，按 2 电影 + 2 剧集 + 1 综艺 循环交错
const buildHomeList = async (configFilters = {}, context) => {
  const fullDate = resolveFullDate(configFilters);
  const sources = [
    { id: "hot_movie", filters: { slug: "all", fullDate }, take: 2 },
    { id: "hot_tv", filters: { slug: "all", fullDate }, take: 2 },
    { id: "hot_show", filters: { slug: "all", fullDate }, take: 1 }
  ];

  const results = sources.map((source) => ({
    ...source,
    list: [],
    seen: new Set(),
    cursor: 0,
    nextPage: 1,
    pagecount: Infinity,
    noMore: false
  }));

  const loadUntilEnough = async (result, need) => {
    while (result.list.length - result.cursor < need && !result.noMore) {
      if (result.nextPage > result.pagecount) {
        result.noMore = true;
        break;
      }

      const data = await _category({ id: result.id, page: result.nextPage, filters: result.filters, context });
      result.nextPage++;

      if (!data?.list?.length) {
        result.noMore = true;
        break;
      }

      result.pagecount = data.pagecount || result.pagecount;
      for (const item of data.list) {
        if (!item?.vod_id || result.seen.has(item.vod_id)) continue;
        result.seen.add(item.vod_id);
        result.list.push(item);
      }
    }

    return result.list.length - result.cursor >= need;
  };

  const merged = [];
  const seen = new Set();
  const movieIndex = 0;
  const tvIndex = 1;
  const showIndex = 2;
  const pattern = [movieIndex, movieIndex, tvIndex, tvIndex, showIndex];

  const takeAvailable = async (index) => {
    const result = results[index];

    while (true) {
      await loadUntilEnough(result, 1);

      while (result.cursor < result.list.length) {
        const item = result.list[result.cursor++];
        if (!item?.vod_id || seen.has(item.vod_id)) continue;
        return item;
      }

      if (result.noMore) return null;
    }
  };

  const getFallbackOrder = (primaryIndex) => {
    if (primaryIndex === movieIndex) return [movieIndex, tvIndex, showIndex];
    if (primaryIndex === tvIndex) return [tvIndex, movieIndex, showIndex];
    return [showIndex, movieIndex, tvIndex];
  };

  while (merged.length < 120) {
    let addedThisRound = 0;

    for (const primaryIndex of pattern) {
      let item = null;

      for (const index of getFallbackOrder(primaryIndex)) {
        item = await takeAvailable(index);
        if (item) break;
      }

      if (!item) return merged;

      seen.add(item.vod_id);
      merged.push(item);
      addedThisRound++;

      if (merged.length >= 120) return merged;
    }

    if (addedThisRound === 0) break;
  }

  return merged;
};

// ===================== 首页 =====================
async function home(params, context) {
  try {
    const classes = [
      { type_id: "movie", type_name: "选电影" },
      { type_id: "tv", type_name: "选剧集" },
      { type_id: "show", type_name: "选综艺" },
      { type_id: "anime", type_name: "动漫剧集" },
      { type_id: "movie_filter", type_name: "电影筛选" },
      { type_id: "tv_filter", type_name: "电视剧筛选" },
      { type_id: "show_filter", type_name: "综艺筛选" },
      { type_id: "top_250", type_name: "电影Top250" },
    ];

    const homeFilters = (params && params.filters) || {};

    let list = [];
    try {
      list = await buildHomeList(homeFilters, context);
    } catch (listError) {
      await OmniBox.log("warn", `获取首页推荐列表失败: ${listError.message}`);
    }

    return {
      class: classes,
      list: list,
      filters: filterConfig,
    };
  } catch (error) {
    return {
      class: [],
      list: [],
      filters: {},
    };
  }
}

// ===================== 分类 =====================
async function category(params, context) {
  try {
    const categoryId = params.categoryId || "movie";
    const page = parseInt(params.page || "1", 10) || 1;
    const filters = params.filters || {};

    const data = await _category({ id: categoryId, page, filters, context });

    const result = {
      list: data.list || [],
      page: data.page || page,
      pagecount: data.pagecount || 1,
      total: data.total || 0,
    };

    if (page === 1) {
      result.filters = filterConfig[categoryId] || [];
    }

    return result;
  } catch (error) {
    return {
      page: params.page || 1,
      pagecount: 0,
      total: 0,
      list: [],
    };
  }
}