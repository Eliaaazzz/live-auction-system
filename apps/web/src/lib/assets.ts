// Real, hot-linkable image assets — no AI placeholders.
//   · Product photos: Unsplash CDN (permanent, free license, hot-link friendly)
//   · Faces / avatars: pravatar.cc (real photo faces)
// All load directly in the browser at runtime; swap freely for your own CDN.

const U = (id: string, w = 600): string => `https://images.unsplash.com/${id}?w=${w}&q=72&auto=format&fit=crop`;

/** 拍品主图（按品类） */
export const PROD = {
  jadePendant: U('photo-1676329945867-01c9975aa9d1'), // 玉/翡翠 绿珠项链
  jadeBangle: U('photo-1767040276964-d2a39a86b1d4'), // 翡翠玉珠
  watch: U('photo-1702865053958-71ec751c4118'), // 二手奢侈品腕表
  teapot: U('photo-1532136868905-8094ef8ef5f2'), // 紫砂壶
  diamond: U('photo-1721103418939-5112f0ccfac8'), // 钻石首饰
  goldNecklace: U('photo-1664178266066-e37e0d25e6a1'), // 金饰
  chocolate: U('photo-1511381939415-e44015466834'), // 食品
  artOil: U('photo-1578321272176-b7bbc0679853'), // 艺术品 · 古典油画
  artLandscape: U('photo-1577720580479-7d839d829c73'), // 艺术品 · 风景油画
  goldBars: U('photo-1610375461246-83df859d849d'), // 贵金属 · 投资金条
  luxuryBag: U('photo-1584917865442-de89df76afd3'), // 二手奢侈品 · 名牌手提包
};

/** 真实人脸头像 */
export const avatar = (n: number, size = 96): string => `https://i.pravatar.cc/${size}?img=${((Math.abs(n) - 1) % 70) + 1}`;

/** 直播间动态背景（拍品图的高斯模糊版，由 CSS filter 处理） */
export const roomBg = (img: string): string => img.replace(/w=\d+/, 'w=900');
