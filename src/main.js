import Hls from "hls.js";
import flvjs from "flv.js";
import md5 from "crypto-js/md5";
import "./styles.css";

const sites = [
  { id: "douyu", name: "斗鱼直播", logo: "/assets/images/douyu.png" },
  { id: "bilibili", name: "哔哩哔哩直播", logo: "/assets/images/bilibili.png" }
];

const state = {
  site: "douyu",
  page: 1,
  keyword: "",
  loading: false,
  selected: null,
  rooms: [],
  follows: readStore("simple_live_follows", [])
};

const app = document.querySelector("#app");

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
        enableWorker: true,
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

function render() {
  const currentSite = sites.find((site) => site.id === state.site);
  app.innerHTML = `
    <main class="shell">
      <aside class="sidebar">
        <div class="brand">
          <img src="/assets/logo.png" alt="" />
          <div>
            <strong>Simple Live</strong>
            <span>Cloudflare Web</span>
          </div>
        </div>
        <nav class="site-list">
          ${sites
            .map(
              (site) => `
                <button class="site-btn ${site.id === state.site ? "active" : ""}" data-site="${site.id}">
                  <img src="${site.logo}" alt="" />
                  <span>${site.name}</span>
                </button>
              `
            )
            .join("")}
        </nav>
        <section class="follows">
          <h2>关注</h2>
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
          <div>
            <h1>${currentSite.name}</h1>
            <p>${state.keyword ? `搜索：${escapeHtml(state.keyword)}` : "热门直播"}</p>
          </div>
          <form class="search" id="search-form">
            <input name="keyword" placeholder="搜索直播间或主播" value="${escapeHtml(state.keyword)}" />
            <button type="submit" title="搜索">搜索</button>
            <button type="button" id="clear-search" title="清空">清空</button>
          </form>
        </header>

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
        <article class="room-card" data-room='${escapeJson(room)}'>
          <div class="cover"><img src="${room.cover || "/assets/logo.png"}" alt="" loading="lazy" /></div>
          <div class="room-info">
            <h3>${escapeHtml(room.title || "未命名直播间")}</h3>
            <p>${escapeHtml(room.userName || "")}</p>
            <div>
              <span>${room.platformName}</span>
              <span>${fmtOnline(room.online)}</span>
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
  return `
    <div class="player-box">
      <video id="player" controls playsinline poster="${room.cover || ""}"></video>
    </div>
    <div class="detail-head">
      <img src="${room.avatar || room.cover || "/assets/logo.png"}" alt="" />
      <div>
        <h2>${escapeHtml(room.title || "直播间")}</h2>
        <p>${escapeHtml(room.userName || "")} · ${escapeHtml(room.platformName || "")} · ${fmtOnline(room.online)}</p>
      </div>
    </div>
    <div class="actions">
      <button id="follow-toggle">${isFollowed(room) ? "取消关注" : "关注"}</button>
      <a href="${room.url}" target="_blank" rel="noreferrer">打开原站</a>
    </div>
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
  document.querySelectorAll(".play-url").forEach((button) => {
    button.addEventListener("click", () => playUrl(button.dataset.url));
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
