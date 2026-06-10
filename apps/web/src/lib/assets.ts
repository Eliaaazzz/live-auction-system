// Real image assets — no AI placeholders.
//   · Product photos: local files under public/products/（随 dist 一起部署，
//     相对路径在 hash 路由下始终解析到站点根，不再热链外站 CDN）
//   · Faces / avatars: pravatar.cc (real photo faces)

/** 拍品占位主图（按品类，四张图各不相同） */
export const PROD = {
  watch: 'products/patek-philippe-watch.jpg', // 名表 · 百达翡丽年历计时 玫瑰金蓝盘
  bag: 'products/versace-la-medusa-tote.avif', // 箱包 · 范思哲 La Medusa 印花托特
  apparel: 'products/chanel-tweed-suit.jpg', // 服饰 · 香奈儿经典粗花呢套装
  shoes: 'products/dior-oblique-sneaker.webp', // 鞋履 · 迪奥 Walk'n'Dior 老花厚底
};

/** 真实人脸头像 */
export const avatar = (n: number, size = 96): string => `https://i.pravatar.cc/${size}?img=${((Math.abs(n) - 1) % 70) + 1}`;

/** 直播间动态背景（拍品图的高斯模糊版，由 CSS filter 处理） */
export const roomBg = (img: string): string => img.replace(/w=\d+/, 'w=900');
