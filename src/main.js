import flvjs from "flv.js";
import md5 from "crypto-js/md5";
import { createIcons, icons } from "lucide";
import "./styles.css";

const CATEGORY_NAMES = ["热门", "英雄联盟", "王者荣耀", "射击游戏", "主机游戏", "户外", "二次元", "娱乐天地"];
const DANMAKU_DEFAULTS = { area: 0.8, opacity: 1, fontSize: 18, duration: 10, strokeWidth: 2 };
const STORE_KEYS = {
  follows: "ficker_live_follows",
  danmakuEnabled: "ficker_live_danmaku_enabled",
  danmakuOptions: "ficker_live_danmaku_options"
};

const state = {
  view: "home",
  page: 1,
  keyword: "",
  loading: false,
  error: "",
  rooms: [],
  hasMore: true,
  selected: null,
  follows: readStore(STORE_KEYS.follows, []),
  danmakuEnabled: readStore(STORE_KEYS.danmakuEnabled, true),
  danmakuOptions: normalizeDanmakuOptions(readStore(STORE_KEYS.danmakuOptions, DANMAKU_DEFAULTS)),
  danmakuSettingsOpen: false,
  danmakuStatus: "",
  chatMessages: []
};

const app = document.querySelector("#app");
const danmakuRuntime = { socket: null, heartbeat: null, activeRoomId: "", counter: 0 };

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

function normalizeDanmakuOptions(options = {}) {
  const merged = { ...DANMAKU_DEFAULTS, ...options };
  return {
    area: clamp(merged.area, 0.1, 1),
    opacity: clamp(merged.opacity, 0.1, 1),
    fontSize: clamp(merged.fontSize, 12, 32),
    duration: clamp(merged.duration, 4, 20),
    strokeWidth: clamp(merged.strokeWidth, 0, 6)
  };
}

function clamp(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function fmtOnline(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "热度未知";
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
  return String(number);
}

function api(path, params = {}) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  return fetch(url)
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `请求失败：${response.status}`);
      return data;
    });
}

function currentRoute() {
  const hash = window.location.hash.replace(/^#/, "");
  const roomMatch = hash.match(/^room\/([^/?]+)/);
  const params = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "");
  return { roomId: roomMatch ? decodeURIComponent(roomMatch[1]) : "", keyword: params.get("q") || "" };
}

function navigateHome(keyword = state.keyword) {
  const suffix = keyword ? `?q=${encodeURIComponent(keyword)}` : "";
  window.location.hash = `home${suffix}`;
}

function navigateRoom(room) {
  state.selected = { ...room, loading: true };
  window.location.hash = `room/${encodeURIComponent(room.roomId)}`;
}

async function handleRoute() {
  const route = currentRoute();
  if (route.roomId) {
    state.view = "room";
    await openRoom(route.roomId);
    return;
  }
  stopDanmaku();
  destroyPlayer();
  state.view = "home";
  const keywordChanged = state.keyword !== route.keyword;
  state.keyword = route.keyword;
  render();
  if (!state.rooms.length || keywordChanged) await loadRooms(true);
}

async function loadRooms(reset = true) {
  if (state.loading) return;
  state.loading = true;
  state.error = "";
  if (reset) {
    state.page = 1;
    state.rooms = [];
    state.hasMore = true;
  }
  render();
  try {
    const data = await api(state.keyword ? "/api/search" : "/api/recommend", {
      page: state.page,
      keyword: state.keyword
    });
    state.rooms = reset ? data.items : [...state.rooms, ...data.items];
    state.hasMore = Boolean(data.hasMore);
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function openRoom(roomId) {
  const known = state.rooms.find((room) => room.roomId === roomId) || state.follows.find((room) => room.roomId === roomId);
  if (!state.selected || state.selected.roomId !== roomId || !state.selected.loading) {
    state.selected = { ...(known || { roomId, title: "直播间" }), loading: true };
  }
  state.chatMessages = [];
  state.danmakuStatus = "";
  render();
  try {
    const detail = await api("/api/room", { roomId });
    let play;
    try {
      const sign = await getDouyuSign(roomId);
      play = await api("/api/play", { roomId, sign });
    } catch (error) {
      play = { urls: [], notice: error.message };
    }
    if (currentRoute().roomId !== roomId) return;
    state.selected = { ...state.selected, ...detail.detail, loading: false, play };
    render();
    const playable = play.urls?.find((item) => item.url.includes("/api/stream"));
    if (playable) playUrl(playable.url, { autoplay: false });
    startDanmaku(state.selected);
  } catch (error) {
    if (currentRoute().roomId === roomId) {
      state.selected = { ...state.selected, loading: false, error: error.message };
      render();
    }
  }
}

async function getDouyuSign(roomId) {
  const data = await api("/api/douyu-sign", { roomId });
  const CryptoJS = { MD5: (value) => md5(value) };
  try {
    return Function("CryptoJS", `${data.script}; return ub98484234("${escapeJs(data.roomId)}","${data.did}","${data.tt}");`)(CryptoJS);
  } catch (error) {
    throw new Error(`播放签名生成失败：${error.message}`);
  }
}

function playUrl(url, options = {}) {
  const video = document.querySelector("#player");
  if (!video || !url || !flvjs.isSupported()) return;
  destroyPlayer();
  const player = flvjs.createPlayer(
    { type: "flv", isLive: true, url },
    { enableWorker: false, enableStashBuffer: false, stashInitialSize: 128, lazyLoad: false }
  );
  player.attachMediaElement(video);
  player.load();
  window.__flv = player;
  if (options.autoplay !== false) player.play().catch(() => {});
}

function destroyPlayer() {
  if (window.__flv) {
    window.__flv.destroy();
    window.__flv = null;
  }
}

function toggleFollow(room = state.selected) {
  if (!room?.roomId) return;
  const index = state.follows.findIndex((item) => item.roomId === room.roomId);
  if (index >= 0) state.follows.splice(index, 1);
  else state.follows.unshift({ ...room, loading: false, play: undefined });
  state.follows = state.follows.slice(0, 80);
  writeStore(STORE_KEYS.follows, state.follows);
  render();
}

function isFollowed(room) {
  return Boolean(room?.roomId && state.follows.some((item) => item.roomId === room.roomId));
}

function stopDanmaku() {
  if (danmakuRuntime.heartbeat) clearInterval(danmakuRuntime.heartbeat);
  danmakuRuntime.heartbeat = null;
  if (danmakuRuntime.socket) {
    danmakuRuntime.socket.onclose = null;
    danmakuRuntime.socket.close();
  }
  danmakuRuntime.socket = null;
  danmakuRuntime.activeRoomId = "";
  state.danmakuStatus = "";
}

async function startDanmaku(room) {
  stopDanmaku();
  if (!state.danmakuEnabled || !room?.roomId || currentRoute().roomId !== room.roomId) return;
  const roomId = String(room.roomId);
  danmakuRuntime.activeRoomId = roomId;
  state.danmakuStatus = "互动连接中";
  renderChatStatus();
  try {
    const data = await api("/api/danmaku", { roomId });
    if (danmakuRuntime.activeRoomId === roomId) connectDouyuDanmaku(data.danmaku.roomId);
  } catch (error) {
    state.danmakuStatus = `互动连接失败：${error.message}`;
    renderChatStatus();
  }
}

function connectDouyuDanmaku(roomId) {
  const socket = new WebSocket("wss://danmuproxy.douyu.com:8501");
  socket.binaryType = "arraybuffer";
  danmakuRuntime.socket = socket;
  socket.addEventListener("open", () => {
    state.danmakuStatus = "实时互动已连接";
    renderChatStatus();
    socket.send(serializeDouyu(`type@=loginreq/roomid@=${roomId}/`));
    socket.send(serializeDouyu(`type@=joingroup/rid@=${roomId}/gid@=-9999/`));
    danmakuRuntime.heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(serializeDouyu("type@=mrkl/"));
    }, 45000);
  });
  socket.addEventListener("message", (event) => {
    for (const part of deserializeDouyu(event.data).split("//")) {
      const data = parseDouyuStt(part);
      if (data?.type === "chatmsg" && data.txt) addLiveMessage(data.nn || "匿名用户", data.txt, douyuColor(data.col));
    }
  });
  socket.addEventListener("close", () => {
    if (danmakuRuntime.activeRoomId) {
      state.danmakuStatus = "实时互动已断开";
      renderChatStatus();
    }
  });
}

function addLiveMessage(name, text, color) {
  state.chatMessages = [...state.chatMessages, { name, text, color, id: `${Date.now()}-${Math.random()}` }].slice(-100);
  addDanmaku(`${name}：${text}`, color);
  const list = document.querySelector("#chat-list");
  if (!list) return;
  list.querySelector(".chat-empty")?.remove();
  list.insertAdjacentHTML("beforeend", renderChatMessage(state.chatMessages.at(-1)));
  while (list.children.length > 100) list.firstElementChild?.remove();
  list.scrollTop = list.scrollHeight;
}

function addDanmaku(text, color) {
  const layer = document.querySelector("#danmaku-layer");
  if (!layer || !state.danmakuEnabled) return;
  const options = state.danmakuOptions;
  const visibleHeight = Math.max(50, layer.clientHeight * options.area);
  const tracks = Math.max(1, Math.floor(visibleHeight / Math.max(26, options.fontSize * 1.5)));
  const item = document.createElement("span");
  item.className = "danmaku-item";
  item.textContent = text.slice(0, 80);
  item.style.color = color;
  item.style.top = `${(danmakuRuntime.counter++ % tracks) * Math.max(26, options.fontSize * 1.5)}px`;
  item.style.animationDuration = `${options.duration + Math.random() * 1.2}s`;
  layer.appendChild(item);
  item.addEventListener("animationend", () => item.remove(), { once: true });
}

function serializeDouyu(body) {
  const data = new TextEncoder().encode(body);
  const buffer = new ArrayBuffer(12 + data.length + 1);
  const view = new DataView(buffer);
  const length = data.length + 9;
  view.setUint32(0, length, true);
  view.setUint32(4, length, true);
  view.setUint16(8, 689, true);
  new Uint8Array(buffer, 12, data.length).set(data);
  return buffer;
}

function deserializeDouyu(payload) {
  const buffer = payload instanceof ArrayBuffer ? payload : payload.buffer;
  if (!buffer || buffer.byteLength < 13) return "";
  const size = Math.max(0, new DataView(buffer).getUint32(0, true) - 9);
  return new TextDecoder().decode(new Uint8Array(buffer, 12, size));
}

function parseDouyuStt(text) {
  if (!text.includes("@=")) return null;
  return text.split("/").reduce((result, item) => {
    const index = item.indexOf("@=");
    if (index > 0) result[item.slice(0, index)] = item.slice(index + 2).replace(/@S/g, "/").replace(/@A/g, "@");
    return result;
  }, {});
}

function douyuColor(value) {
  return ({ 1: "#ff7043", 2: "#4c9aff", 3: "#67c23a", 4: "#ff9f43", 5: "#9b6cff", 6: "#f065c7" })[Number(value)] || "#f5f7fa";
}

function toggleDanmaku() {
  state.danmakuEnabled = !state.danmakuEnabled;
  writeStore(STORE_KEYS.danmakuEnabled, state.danmakuEnabled);
  if (state.danmakuEnabled) startDanmaku(state.selected);
  else {
    stopDanmaku();
    document.querySelector("#danmaku-layer")?.replaceChildren();
  }
  render();
}

function updateDanmakuOption(key, value) {
  state.danmakuOptions = normalizeDanmakuOptions({ ...state.danmakuOptions, [key]: Number(value) });
  writeStore(STORE_KEYS.danmakuOptions, state.danmakuOptions);
  document.querySelector(".player-stage")?.style.setProperty(`--danmaku-${key}`, String(state.danmakuOptions[key]));
  document.querySelector(`[data-value="${key}"]`).textContent = formatDanmakuOption(key, state.danmakuOptions[key]);
}

function formatDanmakuOption(key, value) {
  if (key === "area" || key === "opacity") return `${Math.round(value * 100)}%`;
  if (key === "duration") return `${value} 秒`;
  return `${value}px`;
}

function toggleFullscreen() {
  const stage = document.querySelector(".player-stage");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else stage?.requestFullscreen?.().catch(() => {});
}

function render() {
  app.innerHTML = `
    <div class="app-shell">
      ${renderHeader()}
      ${state.view === "room" ? renderRoom() : renderHome()}
      <div class="toast" id="toast" hidden></div>
    </div>
  `;
  bindEvents();
  createIcons({ icons, attrs: { "aria-hidden": "true", width: 18, height: 18, "stroke-width": 1.8 } });
}

function renderHeader() {
  return `
    <header class="site-header">
      <div class="header-inner">
        <button class="menu-icon icon-button" type="button" title="菜单" aria-label="菜单" data-unavailable><i data-lucide="menu"></i></button>
        <button class="brand" type="button" data-home aria-label="Ficker Live 首页">
          <img src="/assets/logo.png" alt="" />
          <strong>Ficker Live</strong>
        </button>
        <nav class="main-nav" aria-label="主导航">
          <button class="${state.view === "home" ? "active" : ""}" type="button" data-home>首页</button>
          <button class="${state.view === "room" ? "active" : ""}" type="button" data-unavailable>直播</button>
          <button type="button" data-unavailable>分类</button>
          <button type="button" data-unavailable>赛事</button>
          <button type="button" data-unavailable>游戏</button>
        </nav>
        <form class="header-search" id="search-form">
          <input name="keyword" value="${escapeHtml(state.keyword)}" placeholder="搜索直播间、主播" aria-label="搜索直播间、主播" />
          <button class="icon-button" type="submit" title="搜索" aria-label="搜索"><i data-lucide="search"></i></button>
        </form>
        <div class="header-actions">
          <button class="icon-button" type="button" title="观看历史" aria-label="观看历史" data-unavailable><i data-lucide="history"></i></button>
          <button class="icon-button" type="button" title="我的关注" aria-label="我的关注" data-follow-scroll><i data-lucide="heart"></i></button>
          <button class="icon-button" type="button" title="下载客户端" aria-label="下载客户端" data-unavailable><i data-lucide="download"></i></button>
          <button class="start-live" type="button" data-unavailable><i data-lucide="radio"></i><span>开播</span></button>
        </div>
      </div>
    </header>
  `;
}

function renderHome() {
  const featured = state.rooms[0];
  const sideRooms = state.rooms.slice(1, 5);
  return `
    <main class="home-page">
      <aside class="home-rail" aria-label="个人功能">
        <button type="button" data-follow-scroll><i data-lucide="heart"></i><span>我的关注</span></button>
        <button type="button" data-unavailable><i data-lucide="trophy"></i><span>排行榜</span></button>
        <button type="button" data-unavailable><i data-lucide="gamepad-2"></i><span>游戏中心</span></button>
        <button type="button" data-unavailable><i data-lucide="video"></i><span>精彩视频</span></button>
      </aside>
      <div class="home-content">
        <section class="hero-section" aria-label="推荐直播">
          ${featured ? renderHero(featured, sideRooms) : renderHeroLoading()}
        </section>
        <section class="category-bar" aria-label="推荐分类">
          <div class="section-heading"><div><span>探索直播</span><h1>为你推荐</h1></div><button class="text-button" type="button" data-refresh><i data-lucide="refresh-cw"></i>换一换</button></div>
          <div class="category-list">${CATEGORY_NAMES.map((name, index) => `<button class="category-chip ${index === 0 ? "active" : ""}" type="button" data-unavailable>${name}</button>`).join("")}</div>
        </section>
        ${state.error ? `<div class="notice error-notice">${escapeHtml(state.error)}</div>` : ""}
        <div class="home-columns">
          <section class="recommendation-section">
            <div class="section-heading compact"><h2>${state.keyword ? `“${escapeHtml(state.keyword)}” 的搜索结果` : "热门直播"}</h2><span>${state.rooms.length} 个直播间</span></div>
            <div class="room-grid">${renderRooms()}</div>
            ${state.rooms.length && state.hasMore ? `<button class="load-more" id="load-more" type="button" ${state.loading ? "disabled" : ""}>${state.loading ? "正在加载" : "加载更多"}<i data-lucide="chevron-down"></i></button>` : ""}
          </section>
          ${renderFollowPanel()}
        </div>
      </div>
    </main>
  `;
}

function renderHero(room, sideRooms) {
  return `
    <article class="hero-main" data-room='${escapeJson(room)}'>
      <img src="${escapeHtml(room.cover || "/assets/logo.png")}" alt="" />
      <div class="hero-shade"></div>
      <div class="hero-copy"><span class="live-label"><i data-lucide="radio"></i>正在直播</span><h2>${escapeHtml(room.title || "推荐直播间")}</h2><p>${escapeHtml(room.userName || "主播")} · ${fmtOnline(room.online)} 热度</p></div>
      <button class="hero-play" type="button" title="进入直播间" aria-label="进入直播间"><i data-lucide="play"></i></button>
    </article>
    <div class="hero-side">${sideRooms.map((item) => `<button class="hero-side-card" type="button" data-room='${escapeJson(item)}'><img src="${escapeHtml(item.cover || "/assets/logo.png")}" alt="" /><span>${escapeHtml(item.title || "直播间")}</span><small>${fmtOnline(item.online)}</small></button>`).join("")}</div>
  `;
}

function renderHeroLoading() {
  return `<div class="hero-main hero-placeholder"><div><i data-lucide="radio"></i><strong>正在准备推荐内容</strong></div></div><div class="hero-side skeleton-side"></div>`;
}

function renderRooms() {
  if (state.loading && !state.rooms.length) return `<div class="empty-state"><i data-lucide="loader-circle"></i>正在加载直播列表</div>`;
  if (!state.rooms.length) return `<div class="empty-state"><i data-lucide="search-x"></i>没有找到可展示的直播间</div>`;
  return state.rooms.map((room) => `
    <article class="room-card" tabindex="0" data-room='${escapeJson(room)}'>
      <div class="room-cover"><img src="${escapeHtml(room.cover || "/assets/logo.png")}" alt="" loading="lazy" /><span class="room-live">直播中</span><span class="room-heat"><i data-lucide="flame"></i>${fmtOnline(room.online)}</span></div>
      <div class="room-card-info"><h3>${escapeHtml(room.title || "未命名直播间")}</h3><div><span>${escapeHtml(room.userName || "主播")}</span><span>斗鱼直播</span></div></div>
    </article>
  `).join("");
}

function renderFollowPanel() {
  return `
    <aside class="follow-panel" id="follow-panel">
      <div class="section-heading compact"><h2>我的关注</h2><span>${state.follows.length}</span></div>
      <div class="follow-list">
        ${state.follows.length ? state.follows.slice(0, 8).map((room) => `<button type="button" class="follow-item" data-room='${escapeJson(room)}'><img src="${escapeHtml(room.avatar || room.cover || "/assets/logo.png")}" alt="" /><span><strong>${escapeHtml(room.userName || room.title || "主播")}</strong><small>${escapeHtml(room.title || "正在直播")}</small></span><i data-lucide="chevron-right"></i></button>`).join("") : `<div class="follow-empty"><i data-lucide="heart"></i><p>还没有关注的主播</p></div>`}
      </div>
    </aside>
  `;
}

function renderRoom() {
  const room = state.selected;
  if (!room || room.loading) return `<main class="room-page loading-page"><div class="loading-card"><i data-lucide="loader-circle"></i><p>正在打开直播间</p></div></main>`;
  if (room.error) return `<main class="room-page loading-page"><div class="loading-card"><i data-lucide="circle-alert"></i><p>${escapeHtml(room.error)}</p><button class="secondary-button" type="button" data-home>返回首页</button></div></main>`;
  const firstUrl = room.play?.urls?.[0]?.url || "";
  return `
    <main class="room-page">
      <div class="room-layout">
        <section class="watch-column">
          <div class="player-stage" style="--danmaku-fontSize:${state.danmakuOptions.fontSize}px;--danmaku-opacity:${state.danmakuOptions.opacity};--danmaku-duration:${state.danmakuOptions.duration}s;--danmaku-strokeWidth:${state.danmakuOptions.strokeWidth}px">
            <video id="player" controls controlslist="nofullscreen" playsinline poster="${escapeHtml(room.cover || "")}"></video>
            <div class="danmaku-layer" id="danmaku-layer"></div>
            <div class="player-topline"><span><i data-lucide="radio"></i>直播中</span><span>${fmtOnline(room.online)} 热度</span></div>
            <div class="player-tools"><button class="icon-button dark" type="button" title="${state.danmakuEnabled ? "关闭弹幕" : "开启弹幕"}" aria-label="弹幕" data-danmaku-toggle><i data-lucide="message-circle"></i></button><button class="icon-button dark" type="button" title="弹幕设置" aria-label="弹幕设置" data-danmaku-settings><i data-lucide="sliders-horizontal"></i></button><button class="icon-button dark" type="button" title="网页全屏" aria-label="网页全屏" data-fullscreen><i data-lucide="maximize"></i></button></div>
          </div>
          ${state.danmakuSettingsOpen ? renderDanmakuSettings() : ""}
          <section class="room-meta-card">
            <div class="room-profile"><img src="${escapeHtml(room.avatar || room.cover || "/assets/logo.png")}" alt="" /><div><span>Ficker Live · 直播</span><h1>${escapeHtml(room.title || "直播间")}</h1><p>${escapeHtml(room.userName || "主播")} · ${fmtOnline(room.online)} 热度</p></div></div>
            <div class="room-actions"><button class="follow-button ${isFollowed(room) ? "following" : ""}" type="button" data-follow>${isFollowed(room) ? "已关注" : "关注"}</button><button class="icon-button bordered" title="分享直播间" aria-label="分享直播间" type="button" data-unavailable><i data-lucide="share-2"></i></button></div>
          </section>
          <section class="stream-details"><div class="quality-row"><strong>清晰度</strong>${room.play?.urls?.length ? room.play.urls.map((item, index) => `<button class="quality-button ${item.url === firstUrl ? "active" : ""}" type="button" data-play-url="${escapeHtml(item.url)}">${escapeHtml(item.quality || `线路 ${index + 1}`)}</button>`).join("") : `<span class="stream-notice">${escapeHtml(room.play?.notice || "暂无可播放线路")}</span>`}</div><p>${escapeHtml(room.introduction || "暂无直播间介绍")}</p></section>
        </section>
        <aside class="chat-panel"><div class="chat-head"><div><strong>实时互动</strong><small id="chat-status">${escapeHtml(state.danmakuEnabled ? state.danmakuStatus || "等待连接" : "弹幕已关闭")}</small></div><button class="icon-button bordered" type="button" title="弹幕设置" aria-label="弹幕设置" data-danmaku-settings><i data-lucide="settings-2"></i></button></div><div class="chat-list" id="chat-list">${state.chatMessages.length ? state.chatMessages.map(renderChatMessage).join("") : `<div class="chat-empty"><i data-lucide="messages-square"></i><p>消息会显示在这里</p></div>`}</div><div class="chat-readonly"><i data-lucide="lock-keyhole"></i>个人部署为只读互动，不发送外部消息</div></aside>
      </div>
    </main>
  `;
}

function renderChatMessage(message) {
  return `<article class="chat-message" data-chat-id="${message.id}"><strong style="color:${escapeHtml(message.color)}">${escapeHtml(message.name)}</strong><span>${escapeHtml(message.text)}</span></article>`;
}

function renderDanmakuSettings() {
  const controls = [["area", "显示区域", 0.1, 1, 0.1], ["opacity", "不透明度", 0.1, 1, 0.1], ["fontSize", "字体大小", 12, 32, 1], ["duration", "滚动速度", 4, 20, 1], ["strokeWidth", "文字描边", 0, 6, 1]];
  return `<section class="danmaku-settings"><div class="settings-title"><strong>弹幕设置</strong><button class="icon-button bordered" type="button" title="关闭设置" aria-label="关闭设置" data-danmaku-settings><i data-lucide="x"></i></button></div><div class="setting-grid">${controls.map(([key, label, min, max, step]) => `<label><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${state.danmakuOptions[key]}" data-danmaku-option="${key}" /><strong data-value="${key}">${formatDanmakuOption(key, state.danmakuOptions[key])}</strong></label>`).join("")}</div></section>`;
}

function bindEvents() {
  document.querySelectorAll("[data-home]").forEach((button) => button.addEventListener("click", () => navigateHome()));
  document.querySelector("#search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    navigateHome(new FormData(event.currentTarget).get("keyword").trim());
  });
  document.querySelectorAll("[data-room]").forEach((element) => {
    const open = () => navigateRoom(JSON.parse(element.dataset.room));
    element.addEventListener("click", open);
    element.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") open(); });
  });
  document.querySelector("#load-more")?.addEventListener("click", () => { state.page += 1; loadRooms(false); });
  document.querySelector("[data-refresh]")?.addEventListener("click", () => loadRooms(true));
  document.querySelector("[data-follow]")?.addEventListener("click", () => toggleFollow());
  document.querySelectorAll("[data-follow-scroll]").forEach((button) => button.addEventListener("click", () => {
    if (state.view !== "home") navigateHome();
    setTimeout(() => document.querySelector("#follow-panel")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }));
  document.querySelectorAll("[data-play-url]").forEach((button) => button.addEventListener("click", () => playUrl(button.dataset.playUrl)));
  document.querySelectorAll("[data-danmaku-toggle]").forEach((button) => button.addEventListener("click", toggleDanmaku));
  document.querySelectorAll("[data-danmaku-settings]").forEach((button) => button.addEventListener("click", () => { state.danmakuSettingsOpen = !state.danmakuSettingsOpen; render(); }));
  document.querySelector("[data-fullscreen]")?.addEventListener("click", toggleFullscreen);
  document.querySelectorAll("[data-danmaku-option]").forEach((input) => input.addEventListener("input", () => updateDanmakuOption(input.dataset.danmakuOption, input.value)));
  document.querySelectorAll("[data-unavailable]").forEach((button) => button.addEventListener("click", () => showToast("该导航将在后续版本开放")));
}

function renderChatStatus() {
  const status = document.querySelector("#chat-status");
  if (status) status.textContent = state.danmakuEnabled ? state.danmakuStatus || "等待连接" : "弹幕已关闭";
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { toast.hidden = true; }, 1800);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function escapeJson(value) {
  return escapeHtml(JSON.stringify(value));
}

function escapeJs(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

window.addEventListener("hashchange", handleRoute);
window.addEventListener("beforeunload", () => { stopDanmaku(); destroyPlayer(); });
if (!window.location.hash) navigateHome();
else handleRoute();
