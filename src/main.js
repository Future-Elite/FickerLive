import Hls from "hls.js";
import flvjs from "flv.js";
import md5 from "crypto-js/md5";
import "./styles.css";

const sites = [
  { id: "douyu", name: "斗鱼直播", logo: "/assets/images/douyu.png" },
  { id: "bilibili", name: "哔哩哔哩直播", logo: "/assets/images/bilibili.png" }
];

const DANMAKU_DEFAULTS = {
  area: 0.8,
  opacity: 1,
  fontSize: 16,
  fontWeight: 4,
  duration: 10,
  strokeWidth: 2,
  topMargin: 0,
  bottomMargin: 0
};
const DANMAKU_FONT_WEIGHT_LABELS = ["极细", "很细", "细", "正常", "小粗", "偏粗", "粗", "很粗", "极粗"];

const state = {
  site: "douyu",
  page: 1,
  keyword: "",
  loading: false,
  selected: null,
  rooms: [],
  follows: readStore("simple_live_follows", []),
  danmakuEnabled: readStore("simple_live_danmaku_enabled", true),
  danmakuSettingsOpen: false,
  danmakuOptions: normalizeDanmakuOptions(readStore("simple_live_danmaku_options", DANMAKU_DEFAULTS)),
  danmakuStatus: ""
};

const app = document.querySelector("#app");
const danmakuRuntime = {
  socket: null,
  heartbeat: null,
  activeKey: "",
  counter: 0
};

function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function normalizeDanmakuOptions(options = {}) {
  const merged = { ...DANMAKU_DEFAULTS, ...options };
  if (Number(merged.fontWeight) > 9) merged.fontWeight = Math.round(Number(merged.fontWeight) / 100);
  return {
    area: clampNumber(merged.area, 0.1, 1),
    opacity: clampNumber(merged.opacity, 0.1, 1),
    fontSize: clampNumber(merged.fontSize, 8, 48),
    fontWeight: Math.round(clampNumber(merged.fontWeight, 1, 9)),
    duration: clampNumber(merged.duration, 4, 20),
    strokeWidth: clampNumber(merged.strokeWidth, 0, 10),
    topMargin: clampNumber(merged.topMargin, 0, 48),
    bottomMargin: clampNumber(merged.bottomMargin, 0, 48)
  };
}

function fmtOnline(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num < 0) return "";
  if (num >= 10000) return `${(num / 10000).toFixed(num >= 100000 ? 0 : 1)}万`;
  return `${num}`;
}

async function api(path, params = {}) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data;
}

async function loadRooms(reset = true) {
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    stopDanmaku();
    state.page = 1;
    state.rooms = [];
    state.selected = null;
  }
  render();
  try {
    const endpoint = state.keyword ? "/api/search" : "/api/recommend";
    const data = await api(endpoint, {
      site: state.site,
      page: state.page,
      keyword: state.keyword
    });
    state.rooms = reset ? data.items : [...state.rooms, ...data.items];
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function selectRoom(room) {
  state.selected = { ...room, loading: true };
  render();
  try {
    const detail = await api("/api/room", { site: room.site, roomId: room.roomId });
    let play = null;
    try {
      const playParams = { site: room.site, roomId: room.roomId };
      if (room.site === "douyu") playParams.sign = await getDouyuSign(room.roomId);
      play = await api("/api/play", playParams);
    } catch (error) {
      play = { urls: [], notice: error.message };
    }
    state.selected = {
      ...room,
      ...detail.detail,
      userName: detail.detail.userName || room.userName,
      avatar: detail.detail.avatar || room.avatar,
      cover: detail.detail.cover || room.cover,
      play
    };
  } catch (error) {
    state.selected = { ...room, error: error.message };
  }
  render();
  const firstPlayable = state.selected?.play?.urls?.find((item) => item.url.includes(".m3u8") || item.url.includes("/api/stream"));
  if (firstPlayable) {
    const video = document.querySelector("#player");
    if (video) {
      video.muted = false;
      playUrl(firstPlayable.url, { autoplay: false });
    }
  }
  startDanmaku(state.selected);
}

async function getDouyuSign(roomId) {
  const data = await api("/api/douyu-sign", { site: "douyu", roomId });
  const CryptoJS = { MD5: (value) => md5(value) };
  try {
    return Function(
      "CryptoJS",
      `${data.script}; return ub98484234("${escapeJs(data.roomId)}","${data.did}","${data.tt}");`
    )(CryptoJS);
  } catch (error) {
    throw new Error(`斗鱼签名执行失败：${error.message}`);
  }
}

function toggleFollow(room) {
  const key = `${room.site}:${room.roomId}`;
  const exists = state.follows.some((item) => item.key === key);
  state.follows = exists
    ? state.follows.filter((item) => item.key !== key)
    : [{ key, ...room }, ...state.follows].slice(0, 80);
  writeStore("simple_live_follows", state.follows);
  render();
}

function isFollowed(room) {
  return state.follows.some((item) => item.key === `${room.site}:${room.roomId}`);
}

function playUrl(url, options = {}) {
  const video = document.querySelector("#player");
  if (!video || !url) return;
  video.addEventListener("loadedmetadata", updateDanmakuLayout, { once: true });
  if (window.__hls) {
    window.__hls.destroy();
    window.__hls = null;
  }
  if (window.__flv) {
    window.__flv.destroy();
    window.__flv = null;
  }
  if (url.includes(".flv") || url.includes("format=flv")) {
    if (!flvjs.isSupported()) return;
    const player = flvjs.createPlayer(
      { type: "flv", isLive: true, url },
      {
        enableWorker: false,
        enableStashBuffer: false,
        stashInitialSize: 128,
        lazyLoad: false
      }
    );
    player.attachMediaElement(video);
    player.load();
    window.__flv = player;
    if (options.autoplay !== false) player.play().catch(() => {});
    return;
  }
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    if (options.autoplay !== false) video.play().catch(() => {});
    return;
  }
  if (Hls.isSupported() && url.includes(".m3u8")) {
    const hls = new Hls({ lowLatencyMode: true });
    hls.loadSource(url);
    hls.attachMedia(video);
    window.__hls = hls;
    if (options.autoplay !== false) video.play().catch(() => {});
    return;
  }
  video.src = url;
  if (options.autoplay !== false) video.play().catch(() => {});
}

async function startDanmaku(room) {
  stopDanmaku(false);
  if (!state.danmakuEnabled || !room?.site || !room?.roomId) return;
  const key = `${room.site}:${room.roomId}`;
  danmakuRuntime.activeKey = key;
  state.danmakuStatus = "弹幕连接中";
  updateDanmakuStatus();
  try {
    const data = await api("/api/danmaku", { site: room.site, roomId: room.roomId });
    if (danmakuRuntime.activeKey !== key || !state.danmakuEnabled) return;
    if (room.site === "douyu") connectDouyuDanmaku(data.danmaku.roomId);
    if (room.site === "bilibili") connectBilibiliDanmaku(data.danmaku);
  } catch (error) {
    state.danmakuStatus = `弹幕连接失败：${error.message}`;
    updateDanmakuStatus();
  }
}

function stopDanmaku(clearStatus = true) {
  if (danmakuRuntime.heartbeat) clearInterval(danmakuRuntime.heartbeat);
  danmakuRuntime.heartbeat = null;
  if (danmakuRuntime.socket) {
    danmakuRuntime.socket.onclose = null;
    danmakuRuntime.socket.close();
  }
  danmakuRuntime.socket = null;
  danmakuRuntime.activeKey = "";
  if (clearStatus) {
    state.danmakuStatus = "";
    updateDanmakuStatus();
  }
}

function connectDouyuDanmaku(roomId) {
  const socket = new WebSocket("wss://danmuproxy.douyu.com:8501");
  socket.binaryType = "arraybuffer";
  danmakuRuntime.socket = socket;
  socket.addEventListener("open", () => {
    state.danmakuStatus = "斗鱼弹幕已连接";
    updateDanmakuStatus();
    socket.send(serializeDouyu(`type@=loginreq/roomid@=${roomId}/`));
    socket.send(serializeDouyu(`type@=joingroup/rid@=${roomId}/gid@=-9999/`));
    danmakuRuntime.heartbeat = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(serializeDouyu("type@=mrkl/")), 45000);
  });
  socket.addEventListener("message", (event) => {
    const text = deserializeDouyu(event.data);
    if (!text) return;
    const messages = text.includes("//") ? text.split("//") : [text];
    for (const item of messages) {
      const data = parseDouyuStt(item);
      if (data?.type === "chatmsg" && data.txt && data.dms !== undefined) {
        addDanmaku(`${data.nn || ""}：${data.txt}`, douyuColor(data.col));
      }
    }
  });
  socket.addEventListener("close", () => {
    state.danmakuStatus = "斗鱼弹幕已断开";
    updateDanmakuStatus();
  });
}

function connectBilibiliDanmaku(args) {
  const socket = new WebSocket(`wss://${args.serverHost || "broadcastlv.chat.bilibili.com"}/sub`);
  socket.binaryType = "arraybuffer";
  danmakuRuntime.socket = socket;
  socket.addEventListener("open", () => {
    state.danmakuStatus = "B 站弹幕已连接";
    updateDanmakuStatus();
    const join = {
      uid: 0,
      roomid: Number(args.roomId || 0),
      protover: 2,
      buvid: args.buvid || "",
      platform: "web",
      type: 2,
      key: args.token || ""
    };
    socket.send(encodeBiliPacket(JSON.stringify(join), 7));
    danmakuRuntime.heartbeat = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(encodeBiliPacket("", 2)), 30000);
  });
  socket.addEventListener("message", (event) => handleBiliPacket(event.data));
  socket.addEventListener("close", () => {
    state.danmakuStatus = "B 站弹幕已断开";
    updateDanmakuStatus();
  });
}

function serializeDouyu(body) {
  const data = new TextEncoder().encode(body);
  const buffer = new ArrayBuffer(12 + data.length + 1);
  const view = new DataView(buffer);
  const length = data.length + 9;
  view.setUint32(0, length, true);
  view.setUint32(4, length, true);
  view.setUint16(8, 689, true);
  view.setUint8(10, 0);
  view.setUint8(11, 0);
  new Uint8Array(buffer, 12, data.length).set(data);
  return buffer;
}

function deserializeDouyu(payload) {
  const buffer = payload instanceof ArrayBuffer ? payload : payload.buffer;
  if (buffer.byteLength < 13) return "";
  const view = new DataView(buffer);
  const bodyLength = view.getUint32(0, true) - 9;
  return new TextDecoder().decode(new Uint8Array(buffer, 12, Math.max(0, bodyLength)));
}

function parseDouyuStt(text = "") {
  if (!text.includes("@=")) return null;
  const result = {};
  for (const field of text.split("/")) {
    if (!field) continue;
    const index = field.indexOf("@=");
    if (index < 0) continue;
    result[field.slice(0, index)] = unescapeDouyu(field.slice(index + 2));
  }
  return result;
}

function unescapeDouyu(value = "") {
  return value.replace(/@S/g, "/").replace(/@A/g, "@");
}

function douyuColor(value) {
  const colors = { 1: "#ff4d4f", 2: "#3aa0ff", 3: "#7bd94c", 4: "#ff9a3c", 5: "#b366ff", 6: "#ff79c6" };
  return colors[Number(value)] || "#ffffff";
}

function encodeBiliPacket(message, operation) {
  const body = new TextEncoder().encode(message);
  const buffer = new ArrayBuffer(16 + body.length);
  const view = new DataView(buffer);
  view.setUint32(0, buffer.byteLength);
  view.setUint16(4, 16);
  view.setUint16(6, 0);
  view.setUint32(8, operation);
  view.setUint32(12, 1);
  new Uint8Array(buffer, 16).set(body);
  return buffer;
}

async function handleBiliPacket(payload) {
  const buffer = payload instanceof ArrayBuffer ? payload : await payload.arrayBuffer();
  const view = new DataView(buffer);
  let offset = 0;
  while (offset + 16 <= buffer.byteLength) {
    const packetLength = view.getUint32(offset);
    const headerLength = view.getUint16(offset + 4);
    const version = view.getUint16(offset + 6);
    const operation = view.getUint32(offset + 8);
    const body = buffer.slice(offset + headerLength, offset + packetLength);
    if (operation === 5) {
      if (version === 0) parseBiliMessages(new TextDecoder().decode(body));
      if (version === 2) {
        try {
          const inflated = await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();
          parseBiliMessages(new TextDecoder().decode(inflated));
        } catch {
          // Ignore compressed packets if the browser cannot decompress them.
        }
      }
    }
    offset += packetLength || buffer.byteLength;
  }
}

function parseBiliMessages(text) {
  for (const part of text.split(/[\x00-\x1f]+/)) {
    if (!part.startsWith("{")) continue;
    try {
      const data = JSON.parse(part);
      if (String(data.cmd || "").includes("DANMU_MSG")) {
        addDanmaku(`${data.info?.[2]?.[1] || ""}：${data.info?.[1] || ""}`, biliColor(data.info?.[0]?.[3]));
      }
    } catch {
      // Ignore non-JSON fragments.
    }
  }
}

function biliColor(value) {
  const color = Number(value || 0);
  return color ? `#${color.toString(16).padStart(6, "0")}` : "#ffffff";
}

function addDanmaku(text, color = "#ffffff") {
  const layer = document.querySelector("#danmaku-layer");
  if (!layer || !state.danmakuEnabled || !text.trim()) return;
  updateDanmakuLayout();
  const options = state.danmakuOptions;
  const availableHeight = Math.max(40, layer.clientHeight - options.topMargin - options.bottomMargin);
  const trackCount = Math.max(1, Math.floor((options.area * availableHeight) / Math.max(20, options.fontSize * 1.35)));
  const track = danmakuRuntime.counter++ % trackCount;
  const item = document.createElement("span");
  item.className = "danmaku-item";
  item.textContent = text.slice(0, 80);
  item.style.color = color;
  item.style.top = `${options.topMargin + track * Math.max(20, options.fontSize * 1.35)}px`;
  item.style.animationDuration = `${Math.max(4, options.duration + Math.random() * 1.5)}s`;
  layer.appendChild(item);
  item.addEventListener("animationend", () => item.remove(), { once: true });
  while (layer.children.length > 80) layer.firstElementChild?.remove();
}

function updateDanmakuStatus() {
  const status = document.querySelector("#danmaku-status");
  if (status) status.textContent = state.danmakuEnabled ? state.danmakuStatus : "弹幕已关闭";
}

function updateDanmakuLayout() {
  const layer = document.querySelector("#danmaku-layer");
  if (!layer) return;
  const options = state.danmakuOptions;
  layer.style.setProperty("--danmaku-font-size", `${options.fontSize}px`);
  layer.style.setProperty("--danmaku-font-weight", `${danmakuCssFontWeight(options.fontWeight)}`);
  layer.style.setProperty("--danmaku-opacity", `${options.opacity}`);
  layer.style.setProperty("--danmaku-stroke-width", `${options.strokeWidth}px`);
  layer.style.setProperty("--danmaku-bottom-margin", `${options.bottomMargin}px`);
}

function updateDanmakuOption(key, value) {
  const numericKeys = ["area", "opacity", "fontSize", "fontWeight", "duration", "strokeWidth", "topMargin", "bottomMargin"];
  state.danmakuOptions = normalizeDanmakuOptions({
    ...state.danmakuOptions,
    [key]: numericKeys.includes(key) ? Number(value) : value
  });
  writeStore("simple_live_danmaku_options", state.danmakuOptions);
  updateDanmakuLayout();
  document.querySelectorAll(`[data-danmaku-value="${key}"]`).forEach((item) => {
    item.textContent = formatDanmakuOption(key, state.danmakuOptions[key]);
  });
}

function formatDanmakuOption(key, value) {
  if (key === "area" || key === "opacity") return `${Math.round(Number(value) * 100)}%`;
  if (key === "duration") return `${value}秒`;
  if (key === "fontWeight") return DANMAKU_FONT_WEIGHT_LABELS[Math.round(Number(value)) - 1] || "正常";
  return `${value}px`;
}

function danmakuCssFontWeight(value) {
  return Math.round(clampNumber(value, 1, 9)) * 100;
}

function togglePlayerFullscreen() {
  const playerBox = document.querySelector(".player-box");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else playerBox?.requestFullscreen?.().catch(() => {});
}

function normalizeFullscreenTarget() {
  const video = document.querySelector("#player");
  const playerBox = document.querySelector(".player-box");
  if (document.fullscreenElement === video && playerBox) {
    document.exitFullscreen()
      .then(() => playerBox.requestFullscreen?.())
      .catch(() => {});
  }
  syncPlayerControls();
}

function toggleDanmakuEnabled() {
  state.danmakuEnabled = !state.danmakuEnabled;
  writeStore("simple_live_danmaku_enabled", state.danmakuEnabled);
  if (state.danmakuEnabled) {
    startDanmaku(state.selected);
  } else {
    stopDanmaku();
    document.querySelector("#danmaku-layer")?.replaceChildren();
  }
  updateDanmakuStatus();
  syncPlayerControls();
}

function toggleDanmakuSettings() {
  state.danmakuSettingsOpen = !state.danmakuSettingsOpen;
  syncDanmakuSettingsPanels();
  syncPlayerControls();
}

function syncDanmakuSettingsPanels() {
  document.querySelectorAll(".detail-danmaku-settings, .player-danmaku-settings").forEach((item) => item.remove());
  if (!state.danmakuSettingsOpen) return;
  document.querySelector("#danmaku-status")?.insertAdjacentHTML("afterend", renderDanmakuSettings("detail"));
  document.querySelector(".player-box")?.insertAdjacentHTML("beforeend", renderDanmakuSettings("player"));
  bindDanmakuOptionEvents();
}

function syncPlayerControls() {
  document.querySelectorAll("[data-danmaku-toggle]").forEach((button) => {
    button.textContent = state.danmakuEnabled ? "关闭弹幕" : "开启弹幕";
  });
  document.querySelectorAll("[data-danmaku-settings-toggle]").forEach((button) => {
    button.textContent = state.danmakuSettingsOpen ? "收起设置" : "弹幕设置";
  });
  const fullscreenButton = document.querySelector("#player-fullscreen");
  if (fullscreenButton) fullscreenButton.textContent = document.fullscreenElement ? "退出全屏" : "全屏";
}

function render() {
  const currentSite = sites.find((site) => site.id === state.site);
  const totalOnline = state.rooms.reduce((sum, room) => sum + Number(room.online || 0), 0);
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <img src="/assets/images/douyu.png" alt="" />
            <div>
              <strong>Ficker Live</strong>
              <span>对齐斗鱼风格的直播聚合</span>
            </div>
          </div>
          <nav class="top-nav" aria-label="主导航">
            <span class="active">首页</span>
            <span>分类</span>
            <span>赛事</span>
            <span>娱乐</span>
            <span>关注</span>
          </nav>
          <form class="search" id="search-form">
            <input name="keyword" placeholder="搜索直播间、主播、分类" value="${escapeHtml(state.keyword)}" />
            <button class="primary-btn" type="submit" title="搜索">搜索</button>
            <button class="ghost-btn" type="button" id="clear-search" title="清空">清空</button>
          </form>
          <div class="top-actions">
            <button type="button">客户端</button>
            <button class="start-live" type="button">我要开播</button>
          </div>
        </div>
      </header>
      <aside class="sidebar">
        <div class="side-stats" aria-label="直播概览">
          <div>
            <strong>${state.rooms.length}</strong>
            <span>直播间</span>
          </div>
          <div>
            <strong>${fmtOnline(totalOnline)}</strong>
            <span>热度</span>
          </div>
        </div>
        <nav class="site-list">
          ${sites
            .map(
              (site) => `
                <button class="site-btn ${site.id === state.site ? "active" : ""}" data-site="${site.id}">
                  <img src="${site.logo}" alt="" />
                  <span>${site.name}</span>
                  <small>${site.id === state.site ? "当前" : "切换"}</small>
                </button>
              `
            )
            .join("")}
        </nav>
        <section class="follows">
          <div class="section-title">
            <h2>我的关注</h2>
            <span>${state.follows.length}</span>
          </div>
          <div class="follow-list">
            ${
              state.follows.length
                ? state.follows
                    .map(
                      (room) => `
                        <button class="follow-item" data-room='${escapeJson(room)}'>
                          <span>${room.userName || room.title}</span>
                          <small>${room.platformName}</small>
                        </button>
                      `
                    )
                    .join("")
                : `<p>暂无关注</p>`
            }
          </div>
        </section>
      </aside>

      <section class="content">
        <header class="toolbar">
          <div class="title-block">
            <span class="eyebrow">猜你喜欢</span>
            <h1>${state.keyword ? `搜索：${escapeHtml(state.keyword)}` : `${currentSite.name}热门直播`}</h1>
            <p>${state.rooms.length ? `当前展示 ${state.rooms.length} 个直播间，累计热度 ${fmtOnline(totalOnline)}` : "热门推荐 · 实时开播"}</p>
          </div>
          <div class="toolbar-actions">
            <span>全部直播</span>
            <span>人气排序</span>
          </div>
        </header>
        <div class="channel-strip" aria-label="频道状态">
          <span class="channel-chip active">热门</span>
          <span class="channel-chip">英雄联盟</span>
          <span class="channel-chip">王者荣耀</span>
          <span class="channel-chip">主机游戏</span>
          <span class="channel-chip">颜值</span>
          <span class="channel-chip">二次元</span>
          <span class="channel-chip">户外</span>
        </div>

        ${
          state.error
            ? `<div class="notice">${escapeHtml(state.error)}</div>`
            : ""
        }

        <div class="main-grid">
          <section class="room-grid">
            ${renderRooms()}
            ${
              state.rooms.length
                ? `<button class="load-more" id="load-more" ${state.loading ? "disabled" : ""}>${state.loading ? "加载中..." : "加载更多"}</button>`
                : ""
            }
          </section>
          <section class="detail-pane">
            ${renderDetail()}
          </section>
        </div>
      </section>
    </main>
  `;

  bindEvents();
}

function renderRooms() {
  if (state.loading && state.rooms.length === 0) return `<div class="empty">正在加载直播列表</div>`;
  if (!state.rooms.length) return `<div class="empty">没有可显示的直播间</div>`;
  return state.rooms
    .map(
      (room) => `
        <article class="room-card ${state.selected?.site === room.site && state.selected?.roomId === room.roomId ? "selected" : ""}" data-room='${escapeJson(room)}'>
          <div class="cover">
            <img src="${room.cover || "/assets/logo.png"}" alt="" loading="lazy" />
            <div class="cover-shade"></div>
            <span class="live-badge">LIVE</span>
            <span class="heat-badge">${fmtOnline(room.online)}热度</span>
          </div>
          <div class="room-info">
            <h3>${escapeHtml(room.title || "未命名直播间")}</h3>
            <div class="room-meta">
              <span class="anchor-name">${escapeHtml(room.userName || "")}</span>
              <span>${room.platformName}</span>
            </div>
          </div>
        </article>
      `
    )
    .join("");
}

function renderDetail() {
  const room = state.selected;
  if (!room) return `<div class="detail-empty">选择一个直播间查看详情</div>`;
  if (room.loading) return `<div class="detail-empty">正在获取直播间信息</div>`;
  if (room.error) return `<div class="detail-empty">${escapeHtml(room.error)}</div>`;
  const urls = room.play?.urls || [];
  const embedUrl = room.play?.embedUrl || "";
  return `
    <div class="player-box" style="${danmakuStyleVars()}">
      ${
        embedUrl
          ? `<iframe class="embed-player" src="${escapeHtml(embedUrl)}" allow="autoplay; fullscreen; picture-in-picture" referrerpolicy="no-referrer"></iframe>`
          : `<video id="player" controls controlslist="nofullscreen" playsinline poster="${room.cover || ""}"></video>`
      }
      <div class="danmaku-layer" id="danmaku-layer"></div>
      <div class="player-topbar">
        <span>${escapeHtml(room.platformName || "直播")}</span>
        <strong>${fmtOnline(room.online)}热度</strong>
      </div>
      <div class="player-overlay-actions">
        <button data-danmaku-toggle type="button">${state.danmakuEnabled ? "关闭弹幕" : "开启弹幕"}</button>
        <button data-danmaku-settings-toggle type="button">${state.danmakuSettingsOpen ? "收起设置" : "弹幕设置"}</button>
        <button class="player-fullscreen-btn" id="player-fullscreen" type="button">全屏</button>
      </div>
      ${state.danmakuSettingsOpen ? renderDanmakuSettings("player") : ""}
    </div>
    <div class="detail-head">
      <img src="${room.avatar || room.cover || "/assets/logo.png"}" alt="" />
      <div>
        <h2>${escapeHtml(room.title || "直播间")}</h2>
        <p>${escapeHtml(room.userName || "")} · ${escapeHtml(room.platformName || "")} · ${fmtOnline(room.online)}热度</p>
      </div>
    </div>
    <div class="actions">
      <button id="follow-toggle">${isFollowed(room) ? "取消关注" : "关注"}</button>
      <button data-danmaku-toggle>${state.danmakuEnabled ? "关闭弹幕" : "开启弹幕"}</button>
      <button data-danmaku-settings-toggle>${state.danmakuSettingsOpen ? "收起设置" : "弹幕设置"}</button>
      <button id="web-fullscreen">网页全屏</button>
      <a href="${room.url}" target="_blank" rel="noreferrer">打开原站</a>
    </div>
    <div class="danmaku-status" id="danmaku-status">${escapeHtml(state.danmakuEnabled ? state.danmakuStatus : "弹幕已关闭")}</div>
    ${
      state.danmakuSettingsOpen
        ? renderDanmakuSettings("detail")
        : ""
    }
    ${
      urls.length
        ? `<div class="quality-list">
            ${urls
              .map(
                (item, index) => `
                  <button class="play-url" data-url="${escapeHtml(item.url)}">
                    ${escapeHtml(item.quality || `线路 ${index + 1}`)}
                  </button>
                `
              )
              .join("")}
          </div>`
        : `<div class="notice">${escapeHtml(room.play?.notice || "当前平台暂未开放浏览器直播放址，建议打开原站观看。")}</div>`
    }
    <p class="intro">${escapeHtml(room.introduction || "")}</p>
  `;
}

function renderDanmakuSettings(placement = "detail") {
  const danmakuOptions = state.danmakuOptions;
  return `
    <div class="danmaku-settings ${placement === "player" ? "player-danmaku-settings" : "detail-danmaku-settings"}">
      ${renderDanmakuRange("area", "显示区域", danmakuOptions.area, 0.1, 1, 0.1)}
      ${renderDanmakuRange("opacity", "不透明度", danmakuOptions.opacity, 0.1, 1, 0.1)}
      ${renderDanmakuRange("fontSize", "字体大小", danmakuOptions.fontSize, 8, 48, 1)}
      ${renderDanmakuRange("fontWeight", "字体粗细", danmakuOptions.fontWeight, 1, 9, 1)}
      ${renderDanmakuRange("duration", "滚动速度", danmakuOptions.duration, 4, 20, 1)}
      ${renderDanmakuRange("strokeWidth", "字体描边", danmakuOptions.strokeWidth, 0, 10, 1)}
      ${renderDanmakuRange("topMargin", "顶部边距", danmakuOptions.topMargin, 0, 48, 4)}
      ${renderDanmakuRange("bottomMargin", "底部边距", danmakuOptions.bottomMargin, 0, 48, 4)}
    </div>
  `;
}

function renderDanmakuRange(key, label, value, min, max, step) {
  return `
    <label class="danmaku-control">
      <span>${label}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${escapeHtml(value)}" data-danmaku-option="${key}" />
      <strong data-danmaku-value="${key}">${formatDanmakuOption(key, value)}</strong>
    </label>
  `;
}

function danmakuStyleVars() {
  const options = state.danmakuOptions;
  return [
    `--danmaku-font-size:${options.fontSize}px`,
    `--danmaku-font-weight:${danmakuCssFontWeight(options.fontWeight)}`,
    `--danmaku-opacity:${options.opacity}`,
    `--danmaku-stroke-width:${options.strokeWidth}px`,
    `--danmaku-bottom-margin:${options.bottomMargin}px`
  ].join(";");
}

function bindEvents() {
  document.querySelectorAll(".site-btn").forEach((button) => {
    button.addEventListener("click", () => {
      state.site = button.dataset.site;
      state.keyword = "";
      state.error = "";
      loadRooms(true);
    });
  });
  document.querySelector("#search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.keyword = new FormData(event.currentTarget).get("keyword").trim();
    state.error = "";
    loadRooms(true);
  });
  document.querySelector("#clear-search")?.addEventListener("click", () => {
    state.keyword = "";
    state.error = "";
    loadRooms(true);
  });
  document.querySelectorAll(".room-card, .follow-item").forEach((card) => {
    card.addEventListener("click", () => selectRoom(JSON.parse(card.dataset.room)));
  });
  document.querySelector("#load-more")?.addEventListener("click", () => {
    state.page += 1;
    loadRooms(false);
  });
  document.querySelector("#follow-toggle")?.addEventListener("click", () => toggleFollow(state.selected));
  document.querySelectorAll("[data-danmaku-toggle]").forEach((button) => {
    button.addEventListener("click", toggleDanmakuEnabled);
  });
  document.querySelector("#web-fullscreen")?.addEventListener("click", () => {
    togglePlayerFullscreen();
  });
  document.querySelector("#player-fullscreen")?.addEventListener("click", togglePlayerFullscreen);
  document.querySelector("#player")?.addEventListener("dblclick", (event) => {
    event.preventDefault();
    togglePlayerFullscreen();
  });
  document.querySelectorAll("[data-danmaku-settings-toggle]").forEach((button) => {
    button.addEventListener("click", toggleDanmakuSettings);
  });
  bindDanmakuOptionEvents();
  document.querySelectorAll(".play-url").forEach((button) => {
    button.addEventListener("click", () => playUrl(button.dataset.url));
  });
  document.removeEventListener("fullscreenchange", normalizeFullscreenTarget);
  document.addEventListener("fullscreenchange", normalizeFullscreenTarget);
}

function bindDanmakuOptionEvents() {
  document.querySelectorAll("[data-danmaku-option]").forEach((input) => {
    if (input.dataset.bound === "true") return;
    input.dataset.bound = "true";
    input.addEventListener("input", () => updateDanmakuOption(input.dataset.danmakuOption, input.value));
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function escapeJson(value) {
  return escapeHtml(JSON.stringify(value));
}

function escapeJs(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

render();
loadRooms(true);
