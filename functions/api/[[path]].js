const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";

const SITES = {
  douyu: { id: "douyu", name: "斗鱼直播", home: "https://www.douyu.com" },
  huya: { id: "huya", name: "虎牙直播", home: "https://www.huya.com" },
  bilibili: { id: "bilibili", name: "哔哩哔哩直播", home: "https://live.bilibili.com" },
  douyin: { id: "douyin", name: "抖音直播", home: "https://live.douyin.com" }
};

export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);
    const path = context.params.path || "";
    const action = Array.isArray(path) ? path[0] : path;
    const site = url.searchParams.get("site") || "douyu";
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const roomId = url.searchParams.get("roomId") || "";
    const keyword = url.searchParams.get("keyword") || "";
    const sign = url.searchParams.get("sign") || "";

    if (action === "sites") return ok({ sites: Object.values(SITES) });
    if (action === "stream") return streamProxy(context.request, url);
    assertSite(site);

    if (action === "recommend") return ok(await recommend(site, page));
    if (action === "search") return ok(await search(site, keyword, page));
    if (action === "room") return ok({ detail: await room(site, roomId) });
    if (action === "douyu-sign") return ok(await douyuSignScript(roomId));
    if (action === "play") return ok(await play(site, roomId, sign));

    return fail("接口不存在", 404);
  } catch (error) {
    return fail(error.message || "服务异常", 500);
  }
}

async function recommend(site, page) {
  if (site === "douyu") return recommendDouyu(page);
  if (site === "huya") return recommendHuya(page);
  if (site === "bilibili") return searchBilibili("直播", page);
  if (site === "douyin") throw new Error("抖音 Web 接口依赖 a_bogus 签名和风控 Cookie，当前 Cloudflare 版默认不启用。");
}

async function search(site, keyword, page) {
  if (!keyword.trim()) return recommend(site, page);
  if (site === "douyu") return searchDouyu(keyword, page);
  if (site === "huya") return searchHuya(keyword, page);
  if (site === "bilibili") return searchBilibili(keyword, page);
  if (site === "douyin") throw new Error("抖音搜索受风控限制，建议打开原站搜索。");
}

async function room(site, roomId) {
  if (!roomId) throw new Error("缺少 roomId");
  if (site === "douyu") return roomDouyu(roomId);
  if (site === "huya") return roomHuya(roomId);
  if (site === "bilibili") return roomBilibili(roomId);
  if (site === "douyin") {
    return {
      site,
      platformName: SITES[site].name,
      roomId,
      title: `抖音直播间 ${roomId}`,
      url: `${SITES[site].home}/${roomId}`,
      status: false
    };
  }
}

async function play(site, roomId, sign) {
  if (site === "douyu") return playDouyu(roomId, sign);
  if (site === "bilibili") return playBilibili(roomId);
  return {
    urls: [],
    notice: "该平台播放地址需要客户端签名、专用请求头或原站权限校验，Cloudflare 版不代理视频流。"
  };
}

async function recommendDouyu(page) {
  const data = await getJson(`https://m.douyu.com/api/room/list?page=${page}&type=`, {
    headers: { "User-Agent": USER_AGENT, Referer: "https://m.douyu.com/" }
  });
  return {
    hasMore: page < Number(data.data?.pageCount || page),
    items: (data.data?.list || []).map((item) => normalizeRoom("douyu", {
      roomId: item.rid,
      title: item.roomName,
      cover: item.roomSrc,
      userName: item.nickname,
      online: parseHot(item.hn),
      url: `https://www.douyu.com/${item.rid}`
    }))
  };
}

async function searchDouyu(keyword, page) {
  const data = await getJson(urlWithParams("https://www.douyu.com/japi/search/api/searchShow", {
    kw: keyword,
    page,
    pageSize: 20
  }), {
    headers: { "User-Agent": USER_AGENT, Referer: "https://www.douyu.com/search/" }
  });
  return {
    hasMore: (data.data?.relateShow || []).length >= 20,
    items: (data.data?.relateShow || []).map((item) => normalizeRoom("douyu", {
      roomId: item.rid,
      title: item.roomName,
      cover: item.roomSrc,
      userName: item.nickName,
      online: parseHot(item.hot),
      url: `https://www.douyu.com/${item.rid}`
    }))
  };
}

async function roomDouyu(roomId) {
  const data = await getJson(`https://www.douyu.com/swf_api/h5room/${encodeURIComponent(roomId)}`, {
    headers: { "User-Agent": USER_AGENT, Referer: `https://www.douyu.com/${roomId}` }
  });
  const item = data.data || {};
  return normalizeRoom("douyu", {
    roomId: item.room_id || roomId,
    title: item.room_name,
    cover: item.room_src || item.coverSrc,
    avatar: item.owner_avatar,
    userName: item.nickname,
    online: item.online,
    status: String(item.show_status) === "1",
    introduction: item.show_details,
    url: `https://www.douyu.com/${roomId}`
  });
}

async function douyuSignScript(roomId) {
  if (!roomId) throw new Error("缺少 roomId");
  const data = await getJson(`https://www.douyu.com/swf_api/homeH5Enc?rids=${encodeURIComponent(roomId)}`, {
    headers: { "User-Agent": USER_AGENT, Referer: `https://www.douyu.com/${roomId}` }
  });
  const script = data.data?.[`room${roomId}`];
  if (!script) throw new Error("斗鱼签名脚本获取失败。");
  return {
    roomId,
    did: "10000000000000000000000000001501",
    tt: Math.round(Date.now() / 1000).toString(),
    script
  };
}

async function playDouyu(roomId, sign) {
  if (!sign) throw new Error("缺少斗鱼播放签名。");
  const first = await requestDouyuPlay(roomId, sign, "ws-h5", 0);
  const cdns = (first.data?.cdnsWithName || []).map((item) => item.cdn).filter(Boolean);
  const rates = (first.data?.multirates || []).filter((item) => Number.isFinite(Number(item.rate)));
  const selectedRates = rates.length ? rates.slice(0, 4) : [{ name: "默认", rate: 0 }];
  const selectedCdns = cdns.length ? cdns.slice(0, 2) : [first.data?.rtmp_cdn || ""];
  const urls = [];

  for (const rate of selectedRates) {
    for (const cdn of selectedCdns) {
      try {
        const data = rate.rate === 0 && cdn === "ws-h5" ? first : await requestDouyuPlay(roomId, sign, cdn, rate.rate);
        const rawUrl = buildDouyuStreamUrl(data.data);
        if (rawUrl) {
          urls.push({
            quality: `${rate.name || "默认"} · ${cdn || data.data?.rtmp_cdn || "线路"}`,
            directUrl: rawUrl,
            url: `/api/stream?site=douyu&format=flv&url=${encodeURIComponent(rawUrl)}`
          });
        }
      } catch {
        // Some CDN and quality combinations are not available for every room.
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const item of urls) {
    if (seen.has(item.directUrl)) continue;
    seen.add(item.directUrl);
    unique.push(item);
  }
  unique.sort((a, b) => Number(isPreferredDouyuCdn(b.directUrl)) - Number(isPreferredDouyuCdn(a.directUrl)));

  return {
    urls: unique.slice(0, 8),
    notice: unique.length ? "" : "没有获取到斗鱼播放地址。"
  };
}

function isPreferredDouyuCdn(url) {
  try {
    const host = new URL(url).hostname;
    return host.includes("douyucdn");
  } catch {
    return false;
  }
}

async function requestDouyuPlay(roomId, sign, cdn, rate) {
  const body = `${sign}&cdn=${encodeURIComponent(cdn || "")}&rate=${encodeURIComponent(rate)}&ver=Douyu_223061205&iar=1&ive=1&hevc=0&fa=0`;
  return getJson(`https://www.douyu.com/lapi/live/getH5Play/${encodeURIComponent(roomId)}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Referer: `https://www.douyu.com/${roomId}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
}

function buildDouyuStreamUrl(data = {}) {
  if (!data.rtmp_url || !data.rtmp_live) return "";
  const path = String(data.rtmp_live).replace(/\\u0026/g, "&");
  return `${String(data.rtmp_url).replace(":443", "")}/${path}`;
}

async function recommendHuya(page) {
  const data = await getJson(urlWithParams("https://www.huya.com/cache.php", {
    m: "LiveList",
    do: "getLiveListByPage",
    tagAll: 0,
    page
  }), {
    headers: { "User-Agent": USER_AGENT, Referer: "https://www.huya.com/" }
  });
  const list = data.data?.datas || [];
  return {
    hasMore: page < Number(data.data?.totalPage || page),
    items: list.map((item) => huyaRoom(item))
  };
}

async function searchHuya(keyword, page) {
  const data = await getJson(urlWithParams("https://search.cdn.huya.com/", {
    m: "Search",
    do: "getSearchContent",
    q: keyword,
    uid: 0,
    v: 4,
    typ: -5,
    livestate: 0,
    rows: 20,
    start: (page - 1) * 20
  }), {
    headers: { "User-Agent": USER_AGENT, Referer: "https://www.huya.com/search/" }
  });
  const docs = data.response?.["3"]?.docs || [];
  return {
    hasMore: Number(data.response?.["3"]?.numFound || 0) > page * 20,
    items: docs.map((item) => normalizeRoom("huya", {
      roomId: item.room_id,
      title: item.game_introduction || item.game_roomName,
      cover: ensureHuyaCover(item.game_screenshot),
      avatar: item.game_avatarUrl180,
      userName: item.game_nick,
      online: item.game_total_count,
      url: `https://www.huya.com/${item.room_id}`
    }))
  };
}

async function roomHuya(roomId) {
  return normalizeRoom("huya", {
    roomId,
    title: `虎牙直播间 ${roomId}`,
    url: `https://www.huya.com/${roomId}`,
    introduction: "虎牙播放地址需要 TARS token 和防盗链参数，本 Web 版保留原站入口。"
  });
}

function huyaRoom(item) {
  return normalizeRoom("huya", {
    roomId: item.profileRoom,
    title: item.introduction || item.roomName,
    cover: ensureHuyaCover(item.screenshot),
    avatar: item.avatar180,
    userName: item.nick,
    online: item.totalCount,
    url: `https://www.huya.com/${item.profileRoom}`
  });
}

async function searchBilibili(keyword, page) {
  const headers = await biliHeaders();
  const data = await getJson(urlWithParams("https://api.bilibili.com/x/web-interface/search/type", {
    context: "",
    search_type: "live",
    cover_type: "user_cover",
    order: "",
    keyword,
    category_id: "",
    __refresh__: "",
    _extra: "",
    highlight: 0,
    single_column: 0,
    page
  }), { headers });

  const rooms = data.data?.result?.live_room || [];
  return {
    hasMore: rooms.length >= 40,
    items: rooms.map((item) => normalizeRoom("bilibili", {
      roomId: item.roomid,
      title: stripHtml(item.title),
      cover: absoluteUrl(item.user_cover || item.cover),
      avatar: absoluteUrl(item.uface),
      userName: stripHtml(item.uname),
      online: item.online,
      status: item.live_status === 1,
      url: `https://live.bilibili.com/${item.roomid}`
    }))
  };
}

async function roomBilibili(roomId) {
  const data = await getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`, {
    headers: await biliHeaders()
  });
  const item = data.data || {};
  return normalizeRoom("bilibili", {
    roomId: item.room_id || roomId,
    title: item.title,
    cover: item.user_cover || item.keyframe,
    userName: item.uname || "Bilibili",
    online: item.online,
    status: item.live_status === 1,
    introduction: item.description || item.tags,
    url: `https://live.bilibili.com/${roomId}`
  });
}

async function playBilibili(roomId) {
  const data = await getJson(urlWithParams("https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo", {
    room_id: roomId,
    protocol: "0,1",
    format: "0,2",
    codec: "0",
    platform: "web",
    qn: "10000"
  }), {
    headers: await biliHeaders()
  });
  const playurl = data.data?.playurl_info?.playurl;
  if (!playurl) return { urls: [], notice: "没有获取到播放地址。" };

  const qnMap = new Map((playurl.g_qn_desc || []).map((item) => [String(item.qn), item.desc]));
  const urls = [];
  for (const stream of playurl.stream || []) {
    for (const format of stream.format || []) {
      for (const codec of format.codec || []) {
        const quality = qnMap.get(String(codec.current_qn)) || format.format_name || stream.protocol_name;
        for (const info of codec.url_info || []) {
          const url = `${info.host}${codec.base_url}${info.extra}`;
          urls.push({ quality: `${quality} · ${format.format_name}`, url });
        }
      }
    }
  }

  urls.sort((a, b) => Number(b.url.includes(".m3u8")) - Number(a.url.includes(".m3u8")));
  const hlsUrls = urls
    .filter((item) => item.url.includes(".m3u8"))
    .map((item) => ({
      ...item,
      directUrl: item.url,
      url: `/api/stream?site=bilibili&url=${encodeURIComponent(item.url)}`
    }));
  return {
    urls: hlsUrls.slice(0, 6),
    headers: { Referer: "https://live.bilibili.com/" }
  };
}

async function streamProxy(request, requestUrl) {
  const site = requestUrl.searchParams.get("site") || "";
  const target = requestUrl.searchParams.get("url") || "";
  if (!["bilibili", "douyu"].includes(site)) throw new Error("当前只开放 B 站 HLS 和斗鱼 FLV 同域播放代理。");
  if (!target) throw new Error("缺少播放地址");

  const targetUrl = new URL(target);
  if (!isAllowedStreamHost(site, targetUrl.hostname)) throw new Error("播放地址不在允许的直播 CDN 范围内。");

  const headers = {
    "User-Agent": USER_AGENT,
    Referer: site === "douyu" ? "https://www.douyu.com/" : "https://live.bilibili.com/",
    Origin: site === "douyu" ? "https://www.douyu.com" : "https://live.bilibili.com"
  };
  const range = request.headers.get("range");
  if (range) headers.Range = range;

  const upstream = await fetch(targetUrl.toString(), { headers });
  if (!upstream.ok) throw new Error(`播放流请求失败：${upstream.status}`);

  const contentType = upstream.headers.get("content-type") || "";
  const isPlaylist = targetUrl.pathname.endsWith(".m3u8") || contentType.includes("mpegurl");
  if (isPlaylist) {
    const text = await upstream.text();
    const rewritten = rewriteM3u8(text, targetUrl);
    return new Response(rewritten, {
      status: upstream.status,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*"
      }
    });
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("access-control-allow-origin", "*");
  if (site === "douyu") responseHeaders.set("content-type", "video/x-flv");
  responseHeaders.set("cache-control", "public, max-age=3600");
  responseHeaders.delete("set-cookie");
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
}

function rewriteM3u8(text, baseUrl) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes("URI=")) {
        return line.replace(/URI="([^"]+)"/, (_, uri) => {
          const resolved = new URL(uri, baseUrl).toString();
          return `URI="/api/stream?site=bilibili&url=${encodeURIComponent(resolved)}"`;
        });
      }
      if (trimmed.startsWith("#")) return line;
      const resolved = new URL(trimmed, baseUrl).toString();
      return `/api/stream?site=bilibili&url=${encodeURIComponent(resolved)}`;
    })
    .join("\n");
}

function isAllowedStreamHost(site, hostname) {
  if (site === "bilibili") return hostname === "bilivideo.com" || hostname.endsWith(".bilivideo.com");
  if (site === "douyu") {
    return (
      hostname === "douyucdn.cn" ||
      hostname.endsWith(".douyucdn.cn") ||
      hostname === "douyucdn2.cn" ||
      hostname.endsWith(".douyucdn2.cn") ||
      hostname === "edgesrv.com" ||
      hostname.endsWith(".edgesrv.com")
    );
  }
  return false;
}

async function biliHeaders() {
  const base = { "User-Agent": USER_AGENT, Referer: "https://live.bilibili.com/" };
  try {
    const data = await getJson("https://api.bilibili.com/x/frontend/finger/spi", { headers: base });
    return {
      ...base,
      Cookie: `buvid3=${data.data?.b_3 || ""}; buvid4=${data.data?.b_4 || ""};`
    };
  } catch {
    return base;
  }
}

async function getJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`上游请求失败：${response.status}`);
  try {
    const data = JSON.parse(text);
    if (data.code && ![0, 200].includes(Number(data.code))) throw new Error(data.message || data.msg || "上游接口返回错误");
    if (data.error && Number(data.error) !== 0) throw new Error(data.msg || "上游接口返回错误");
    return data;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("上游返回不是 JSON");
    throw error;
  }
}

function normalizeRoom(site, item) {
  return {
    site,
    platformName: SITES[site].name,
    roomId: String(item.roomId || ""),
    title: item.title || "",
    cover: absoluteUrl(item.cover || ""),
    avatar: absoluteUrl(item.avatar || ""),
    userName: item.userName || "",
    online: Number(item.online || 0),
    status: Boolean(item.status ?? true),
    introduction: item.introduction || "",
    url: item.url || `${SITES[site].home}/${item.roomId}`
  };
}

function assertSite(site) {
  if (!SITES[site]) throw new Error("不支持的平台");
}

function ok(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=20"
    }
  });
}

function fail(error, status) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function urlWithParams(base, params) {
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function absoluteUrl(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

function ensureHuyaCover(url = "") {
  const cover = absoluteUrl(url);
  if (!cover || cover.includes("?")) return cover;
  return `${cover}?x-oss-process=style/w338_h190&`;
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]*>/g, "");
}

function parseHot(value) {
  const text = String(value || "0");
  const num = Number.parseFloat(text.replace("万", ""));
  if (!Number.isFinite(num)) return 0;
  return Math.round(text.includes("万") ? num * 10000 : num);
}
