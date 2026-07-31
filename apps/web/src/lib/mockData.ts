import type { Room, User } from './types';
import { avatar, PROD } from './assets';

export const BOT_USERS: User[] = [
  { id: 'u1', name: 'A***', avatar: avatar(13), color: '#f2748b' },
  { id: 'u2', name: 'B***', avatar: avatar(45), color: '#7b9cf2' },
  { id: 'u3', name: 'C***', avatar: avatar(33), color: '#59c0a8' },
  { id: 'u4', name: 'D***', avatar: avatar(12), color: '#f2b04e' },
  { id: 'u5', name: 'E***', avatar: avatar(26), color: '#b98cf2' },
  { id: 'u6', name: 'F***', avatar: avatar(51), color: '#4ea7f2' },
  { id: 'u7', name: 'G***', avatar: avatar(40), color: '#f28f6b' },
  { id: 'u8', name: 'H***', avatar: avatar(8), color: '#6bd1f2' },
  { id: 'u9', name: 'I***', avatar: avatar(60), color: '#9bd24e' },
  { id: 'u10', name: 'J***', avatar: avatar(31), color: '#f26b9b' },
];

export const ME: User = { id: 'me', name: 'Me', avatar: avatar(15), color: '#fe2c55' };

export const COMMENT_POOL: string[] = ['The condition on this is unreal','Host, put it on your wrist again','Do not fight me for this one','Next lot, quick','This one is mine','The material looks so fine','Go go go!','Host, is it authentic?','The price is still fair','Waiting for a bargain','Already sold on it','The increments are climbing fast','Can I get a link?','Looks even better in hand','Stay calm, do not overbid','Taking this one home','Bring the camera closer','Followed the host','Waiting online for the start','So many people here'];

export const ENTER_POOL: string[] = ['Marcus from Beijing joined','Dana the designer from Shanghai joined','Alex from Guangzhou joined','Luna from Hangzhou joined','Wayne from Shenzhen joined'];

export const ROOMS: Room[] = [
  {
    id: 'room-1', anchorName: 'Leo the Watch Hunter', anchorAvatar: avatar(52), fans: '234K', viewers: 6620, tagline: '#1 on the watch chart',
    lot: { id: 'lot-1', index: 1, title: 'Patek Philippe Annual Calendar Chronograph - rose gold, blue dial', subtitle: 'Near mint - box and papers - inspected', image: PROD.watch, tone: '#16294a', tone2: '#c9925e', startPrice: 0, increment: 2000, minIncrement: 2000, capPrice: 680000, deposit: 20000, durationSec: 90, extendSec: 30, category: 'Watches', estimate: 'Market reference ¥580,000 - ¥660,000' },
  },
  {
    id: 'room-2', anchorName: 'Mia - Designer Bags', anchorAvatar: avatar(20), fans: '121K', viewers: 4180, tagline: '#3 on the bag chart',
    lot: { id: 'lot-2', index: 1, title: 'Versace La Medusa printed canvas tote', subtitle: 'Medusa hardware - small - new with card', image: PROD.bag, tone: '#1c1c20', tone2: '#d4af5f', startPrice: 0, increment: 100, minIncrement: 100, capPrice: 12000, deposit: 500, durationSec: 70, extendSec: 20, category: 'Bags', estimate: 'Market reference ¥8,500 - ¥11,000' },
  },
  {
    id: 'room-3', anchorName: 'Coco - Couture Wardrobe', anchorAvatar: avatar(5), fans: '68K', viewers: 2333, tagline: '#8 on the apparel chart',
    lot: { id: 'lot-3', index: 1, title: 'Chanel classic tweed suit', subtitle: 'Cream and gold - pearl chain trim - boutique e-card', image: PROD.apparel, tone: '#8a7656', tone2: '#e6d6ae', startPrice: 0, increment: 500, minIncrement: 500, capPrice: 48000, deposit: 1000, durationSec: 80, extendSec: 15, category: 'Apparel', estimate: 'Market reference ¥32,000 - ¥45,000' },
  },
  {
    id: 'room-4', anchorName: 'Kiko - Sneaker Lab', anchorAvatar: avatar(33), fans: '96K', viewers: 3512, tagline: '#5 on the shoe chart',
    lot: { id: 'lot-4', index: 1, title: "Dior Walk'n'Dior Oblique platform canvas sneaker", subtitle: 'Oblique jacquard - EU 38 - excellent condition', image: PROD.shoes, tone: '#2b3046', tone2: '#cfc3a8', startPrice: 0, increment: 100, minIncrement: 100, capPrice: 8000, deposit: 300, durationSec: 60, extendSec: 15, category: 'Shoes', estimate: 'Market reference ¥5,800 - ¥7,200' },
  },
];

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
