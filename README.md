# Simple Live Cloudflare

这是基于 `xiaoyaocz/dart_simple_live` 思路重建的 Cloudflare Pages Web 版本。

## 本地运行

```bash
npm install
npm run dev
```

Pages Functions 需要用 Wrangler 预览：

```bash
npm run pages:dev
```

## 部署到 Cloudflare Pages

1. 将 `cloudflare_live` 目录推送到你自己的 GitHub 仓库。
2. Cloudflare Dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git。
3. Framework preset 选择 `Vite`。
4. Build command 填 `npm run build`。
5. Build output directory 填 `dist`。
6. 部署完成后，在 Pages 项目里绑定你的自定义域名。

## 当前能力

- 斗鱼：推荐列表、搜索、直播间信息、H5 签名、HTTP-FLV 同域代理播放。
- B 站：搜索、直播间信息、HLS 同域代理播放。

直播平台接口经常变动；当前正式可播放路径为斗鱼 HTTP-FLV 和 B 站 HLS。虎牙/抖音涉及更复杂的防盗链、TARS 或风控签名，未作为正式播放入口开放。

注意：视频流会经过 Cloudflare Pages Function 代理。个人低流量使用可以工作；如果开放给大量用户，需要关注 Cloudflare 对长连接、带宽和滥用流量的限制。
