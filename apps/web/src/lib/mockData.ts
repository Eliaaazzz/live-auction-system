import type { Room, User } from './types';
import { avatar, PROD } from './assets';

export const BOT_USERS: User[] = [
  { id: 'u1', name: '张**', avatar: avatar(13), color: '#f2748b' },
  { id: 'u2', name: '李**', avatar: avatar(45), color: '#7b9cf2' },
  { id: 'u3', name: '王**', avatar: avatar(33), color: '#59c0a8' },
  { id: 'u4', name: '黄**', avatar: avatar(12), color: '#f2b04e' },
  { id: 'u5', name: '陈**', avatar: avatar(26), color: '#b98cf2' },
  { id: 'u6', name: '刘**', avatar: avatar(51), color: '#4ea7f2' },
  { id: 'u7', name: '赵**', avatar: avatar(40), color: '#f28f6b' },
  { id: 'u8', name: '周**', avatar: avatar(8), color: '#6bd1f2' },
  { id: 'u9', name: '吴**', avatar: avatar(60), color: '#9bd24e' },
  { id: 'u10', name: '郑**', avatar: avatar(31), color: '#f26b9b' },
];

export const ME: User = { id: 'me', name: '我', avatar: avatar(15), color: '#fe2c55' };

export const COMMENT_POOL: string[] = ['这件成色绝了','主播再上手看看','别跟我抢','快点下一件','这个我势在必得','料子很细腻啊','冲冲冲！','保真吗主播','价格还能接受','蹲一个捡漏','已经心动了','加价幅度有点快','求个链接','上手实物更好看','稳住别上头','这波必拿下','镜头给近一点','关注了主播','在线等开拍','人也太多了吧'];

export const ENTER_POOL: string[] = ['北京的 马大瓜 来了','上海的 设计狮 来了','广州的 阿强 来了','杭州的 小鹿 来了','深圳的 老王 来了'];

export const ROOMS: Room[] = [
  {
    id: 'room-1', anchorName: '腕表猎人 Leo', anchorAvatar: avatar(52), fans: '23.4万', viewers: 6620, tagline: '名表榜第 1 名',
    lot: { id: 'lot-1', index: 1, title: '百达翡丽年历计时腕表 · 玫瑰金蓝盘', subtitle: '95新 · 原盒原证 · 已质检', image: PROD.watch, tone: '#16294a', tone2: '#c9925e', startPrice: 0, increment: 2000, minIncrement: 2000, capPrice: 680000, deposit: 20000, durationSec: 90, extendSec: 30, category: '名表', estimate: '市场参考价 ¥58万 – ¥66万' },
  },
  {
    id: 'room-2', anchorName: '大牌包包·Mia', anchorAvatar: avatar(20), fans: '12.1万', viewers: 4180, tagline: '箱包榜第 3 名',
    lot: { id: 'lot-2', index: 1, title: '范思哲 La Medusa 印花帆布托特包', subtitle: '美杜莎装饰 · 小号 · 全新带卡', image: PROD.bag, tone: '#1c1c20', tone2: '#d4af5f', startPrice: 0, increment: 100, minIncrement: 100, capPrice: 12000, deposit: 500, durationSec: 70, extendSec: 20, category: '箱包', estimate: '市场参考价 ¥8,500 – ¥11,000' },
  },
  {
    id: 'room-3', anchorName: '高定衣橱·Coco', anchorAvatar: avatar(5), fans: '6.8万', viewers: 2333, tagline: '服饰榜第 8 名',
    lot: { id: 'lot-3', index: 1, title: '香奈儿经典粗花呢套装', subtitle: '米金色 · 珍珠链饰 · 专柜电子卡', image: PROD.apparel, tone: '#8a7656', tone2: '#e6d6ae', startPrice: 0, increment: 500, minIncrement: 500, capPrice: 48000, deposit: 1000, durationSec: 80, extendSec: 15, category: '服饰', estimate: '市场参考价 ¥3.2万 – ¥4.5万' },
  },
  {
    id: 'room-4', anchorName: '潮鞋研究所·Kiko', anchorAvatar: avatar(33), fans: '9.6万', viewers: 3512, tagline: '鞋履榜第 5 名',
    lot: { id: 'lot-4', index: 1, title: "迪奥 Walk'n'Dior 老花厚底帆布鞋", subtitle: 'Oblique 提花 · 38码 · 9成新', image: PROD.shoes, tone: '#2b3046', tone2: '#cfc3a8', startPrice: 0, increment: 100, minIncrement: 100, capPrice: 8000, deposit: 300, durationSec: 60, extendSec: 15, category: '鞋履', estimate: '市场参考价 ¥5,800 – ¥7,200' },
  },
];

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
