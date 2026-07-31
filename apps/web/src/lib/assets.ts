// Real image assets — no AI placeholders.
//   · Product photos: local files under public/products/ (deployed with dist; relative paths always resolve
//     to the site root under hash routing, so we no longer hotlink an external CDN)
//   · Faces / avatars: pravatar.cc (real photo faces)

/** Placeholder cover images for lots (one per category, all different) */
export const PROD = {
  watch: 'products/patek-philippe-watch.jpg', // Watches - Patek Philippe Annual Calendar Chronograph, rose gold blue dial
  bag: 'products/versace-la-medusa-tote.avif', // Bags - Versace La Medusa printed tote
  apparel: 'products/chanel-tweed-suit.jpg', // Apparel - Chanel classic tweed suit
  shoes: 'products/dior-oblique-sneaker.webp', // Shoes - Dior Walk'n'Dior Oblique platform sneaker
};

/** Real-face avatars */
export const avatar = (n: number, size = 96): string => `https://i.pravatar.cc/${size}?img=${((Math.abs(n) - 1) % 70) + 1}`;

/** The room's dynamic background (a gaussian-blurred version of the lot photo, done with a CSS filter) */
export const roomBg = (img: string): string => img.replace(/w=\d+/, 'w=900');
