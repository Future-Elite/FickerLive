# Ficker Live

个人部署的斗鱼直播 Web 体验，使用 Ficker Live 品牌与斗鱼式信息架构。项目仅接入斗鱼公开直播数据，不是斗鱼官方产品。

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

- 首页推荐、搜索、动态主视觉和本地关注。
- 独立直播间：斗鱼 H5 签名、HTTP-FLV 同域代理播放、清晰度切换、全屏和可配置屏幕弹幕。
- 斗鱼弹幕 WebSocket 的只读实时互动栏；消息不会回传到斗鱼。

直播平台接口经常变动，当前播放路径为斗鱼 HTTP-FLV。所有视频流经 Cloudflare Pages Function 代理。

注意：视频流会经过 Cloudflare Pages Function 代理。个人低流量使用可以工作；如果开放给大量用户，需要关注 Cloudflare 对长连接、带宽和滥用流量的限制。
