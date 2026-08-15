# Skittles’s Blog

基于 Astro 7 构建的个人静态博客，包含 Markdown/MDX 文章、RSS、站点地图、Waline 评论、响应式玻璃拟态界面与本地文章搜索。

## 本地开发

需要 Node.js 22.12 或更高版本。

```bash
npm install
npm run dev
```

项目约定使用 Astro 后台开发服务：

```bash
astro dev --background
astro dev status
astro dev logs
astro dev stop
```

## 构建

```bash
npm run build
npm run preview
```

## 站点地址

部署时通过 `SITE_URL` 环境变量设置正式域名，用于生成 canonical、RSS 和 sitemap：

```bash
SITE_URL=https://your-domain.example npm run build
```

## 内容

文章位于 `src/content/blog/`，支持 Markdown 和 MDX。文章 frontmatter 字段定义在 `src/content.config.ts`。
