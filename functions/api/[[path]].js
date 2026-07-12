const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DOUYU_HOME = "https://www.douyu.com";

export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);
    const action = Array.isArray(context.params.path) ? context.params.path[0] : context.params.path;
    const site = url.searchParams.get("site") || "douyu";
    if (site !== "douyu") return fail("个人部署仅支持斗鱼直播", 400);
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const roomId = url.searchParams.get("roomId") || "";

    if (action === "stream") return streamProxy(context.request, url);
    if (action === "recommend") return ok(await recommendDouyu(page));
    if (action === "search") return ok(await searchDouyu(url.searchParams.get("keyword") || "", page));
    if (action === "room") return ok({ detail: await roomDouyu(roomId) });
    if (action === "danmaku") return ok({ danmaku: { roomId: assertRoomId(roomId) } });
    if (action === "douyu-sign") return ok(await douyuSignScript(roomId), "no-store");
    if (action === "play") return ok(await playDouyu(roomId, url.searchParams.get("sign") || ""), "no-store");
    return fail("接口不存在", 404);
  } catch (error) {
    return fail(error.message || "服务异常", 500);
  }
}

async function recommendDouyu(page) {
  const data = await getJson(`https://m.douyu.com/api/room/list?page=${page}&type=`, { headers: douyuHeaders("https://m.douyu.com/") });
  return { hasMore: page < Number(data.data?.pageCount || page), items: (data.data?.list || []).map((item) => normalizeRoom({ roomId: item.rid, title: item.roomName, cover: item.roomSrc, userName: item.nickname, online: parseHot(item.hn) })) };
}

async function searchDouyu(keyword, page) {
  if (!keyword.trim()) return recommendDouyu(page);
  const data = await getJson(urlWithParams(`${DOUYU_HOME}/japi/search/api/searchShow`, { kw: keyword, page, pageSize: 20 }), { headers: douyuHeaders(`${DOUYU_HOME}/search/`) });
  const rooms = data.data?.relateShow || [];
  return { hasMore: rooms.length >= 20, items: rooms.map((item) => normalizeRoom({ roomId: item.rid, title: item.roomName, cover: item.roomSrc, userName: item.nickName, online: parseHot(item.hot) })) };
}

async function roomDouyu(roomId) {
  roomId = assertRoomId(roomId);
  const data = await getJson(`${DOUYU_HOME}/swf_api/h5room/${encodeURIComponent(roomId)}`, { headers: douyuHeaders(`${DOUYU_HOME}/${roomId}`) });
  const item = data.data || {};
  return normalizeRoom({ roomId: item.room_id || roomId, title: item.room_name, cover: item.room_src || item.coverSrc, avatar: item.owner_avatar, userName: item.nickname, online: item.online, status: String(item.show_status) === "1", introduction: item.show_details });
}

async function douyuSignScript(roomId) {
  roomId = assertRoomId(roomId);
  const data = await getJson(`${DOUYU_HOME}/swf_api/homeH5Enc?rids=${encodeURIComponent(roomId)}`, { headers: douyuHeaders(`${DOUYU_HOME}/${roomId}`) });
  const script = data.data?.[`room${roomId}`];
  if (!script) throw new Error("播放签名脚本获取失败");
  return { roomId, did: "10000000000000000000000000001501", tt: String(Math.round(Date.now() / 1000)), script };
}

async function playDouyu(roomId, sign) {
  roomId = assertRoomId(roomId);
  if (!sign) throw new Error("缺少斗鱼播放签名");
  const first = await requestDouyuPlay(roomId, sign, "ws-h5", 0);
  const cdns = unique(["ws-h5", first.data?.rtmp_cdn, ...(first.data?.cdnsWithName || []).map((item) => item.cdn)]).slice(0, 4);
  const rates = (first.data?.multirates || []).filter((item) => Number.isFinite(Number(item.rate))).map((item) => ({ name: item.name || "默认", rate: Number(item.rate), bit: Number(item.bit || 0), highBit: Number(item.highBit || 0) })).sort((a, b) => scoreRate(b) - scoreRate(a));
  const urls = [];
  for (const rate of (rates.length ? rates.slice(0, 5) : [{ name: "默认", rate: 0, bit: 0, highBit: 0 }])) {
    for (const cdn of cdns) {
      try {
        const response = rate.rate === 0 && cdn === "ws-h5" ? first : await requestDouyuPlay(roomId, sign, cdn, rate.rate);
        const directUrl = buildStreamUrl(response.data);
        if (directUrl) urls.push({ quality: `${rate.name}${rate.bit ? ` ${rate.bit}K` : ""} · ${cdn || "线路"}`, bitrate: rate.bit, highBit: rate.highBit, directUrl, url: `/api/stream?site=douyu&format=flv&url=${encodeURIComponent(directUrl)}` });
      } catch { /* Individual quality and CDN combinations can be unavailable. */ }
    }
  }
  const seen = new Set();
  const uniqueUrls = urls.filter((item) => !seen.has(item.directUrl) && seen.add(item.directUrl)).sort((a, b) => scoreRate(b) - scoreRate(a));
  return { urls: uniqueUrls.slice(0, 8), notice: uniqueUrls.length ? "" : "没有获取到可播放线路" };
}

async function requestDouyuPlay(roomId, sign, cdn, rate) {
  const body = `${sign}&cdn=${encodeURIComponent(cdn || "")}&rate=${encodeURIComponent(rate)}&ver=Douyu_223061205&iar=0&ive=0&hevc=0&fa=0`;
  return getJson(`${DOUYU_HOME}/lapi/live/getH5Play/${encodeURIComponent(roomId)}`, { method: "POST", headers: { ...douyuHeaders(`${DOUYU_HOME}/${roomId}`), "Content-Type": "application/x-www-form-urlencoded" }, body });
}

function buildStreamUrl(data = {}) {
  if (!data.rtmp_url || !data.rtmp_live) return "";
  return `${String(data.rtmp_url).replace(":443", "")}/${String(data.rtmp_live).replace(/\\u0026/g, "&")}`;
}

async function streamProxy(request, requestUrl) {
  const target = requestUrl.searchParams.get("url") || "";
  if (!target) throw new Error("缺少播放地址");
  const targetUrl = new URL(target);
  if (!isAllowedStreamHost(targetUrl.hostname)) throw new Error("播放地址不在允许的斗鱼 CDN 范围内");
  const headers = { ...douyuHeaders(DOUYU_HOME), Origin: DOUYU_HOME };
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  const upstream = await fetch(targetUrl, { headers });
  if (!upstream.ok) throw new Error(`播放流请求失败：${upstream.status}`);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set("content-type", "video/x-flv");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function douyuHeaders(referer) { return { "User-Agent": USER_AGENT, Referer: referer }; }
function isAllowedStreamHost(hostname) { return hostname === "douyucdn.cn" || hostname.endsWith(".douyucdn.cn") || hostname === "douyucdn2.cn" || hostname.endsWith(".douyucdn2.cn") || hostname === "edgesrv.com" || hostname.endsWith(".edgesrv.com"); }
function normalizeRoom(item) { return { site: "douyu", platformName: "斗鱼直播", roomId: String(item.roomId || ""), title: item.title || "", cover: absoluteUrl(item.cover || ""), avatar: absoluteUrl(item.avatar || ""), userName: item.userName || "", online: Number(item.online || 0), status: Boolean(item.status ?? true), introduction: item.introduction || "", url: `${DOUYU_HOME}/${item.roomId}` }; }
function assertRoomId(roomId) { if (!roomId) throw new Error("缺少 roomId"); return String(roomId); }
function scoreRate(item) { return Number(item.highBit || 0) * 100000 + Number(item.bitrate || item.bit || 0) * 10 + Number(item.rate === 0); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function absoluteUrl(url) { if (!url) return ""; if (url.startsWith("//")) return `https:${url}`; return url.startsWith("http://") ? url.replace("http://", "https://") : url; }
function parseHot(value) { const text = String(value || "0"); const number = Number.parseFloat(text.replace("万", "")); return Number.isFinite(number) ? Math.round(text.includes("万") ? number * 10000 : number) : 0; }
function urlWithParams(base, params) { const url = new URL(base); Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value)); return url.toString(); }
async function getJson(url, init = {}) { const response = await fetch(url, init); const text = await response.text(); if (!response.ok) throw new Error(`上游请求失败：${response.status}`); try { const data = JSON.parse(text); if (data.code && ![0, 200].includes(Number(data.code))) throw new Error(data.message || data.msg || "上游接口返回错误"); if (data.error && Number(data.error) !== 0) throw new Error(data.msg || "上游接口返回错误"); return data; } catch (error) { if (error instanceof SyntaxError) throw new Error("上游返回不是 JSON"); throw error; } }
function ok(data, cacheControl = "public, max-age=20") { return new Response(JSON.stringify(data), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl } }); }
function fail(error, status) { return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
