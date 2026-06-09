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
    id: 'room-1', anchorName: '马大瓜珠宝', anchorAvatar: avatar(5), fans: '6.8万', viewers: 2333, tagline: '古玩榜第 8 名',
    lot: { id: 'lot-1', index: 1, title: '金镶玉平安扣·和田玉吊坠项链首饰', subtitle: '和田玉 · 925银镶嵌 · 附证书', image: PROD.jadePendant, tone: '#2f6b5a', tone2: '#d9b45a', startPrice: 0, increment: 50, minIncrement: 50, capPrice: 12000, deposit: 200, durationSec: 80, extendSec: 15, category: '玉石珠宝', estimate: '市场参考价 ¥6,800 – ¥9,200' },
  },
  {
    id: 'room-2', anchorName: '翠玉阁·阿琳', anchorAvatar: avatar(20), fans: '12.1万', viewers: 4180, tagline: '珠宝榜第 3 名',
    lot: { id: 'lot-2', index: 1, title: '天然冰糯种翡翠手镯 · 内径 56mm', subtitle: 'A货翡翠 · 起光起胶 · 复检证书', image: PROD.jadeBangle, tone: '#0f7a5a', tone2: '#27d39b', startPrice: 1000, increment: 100, minIncrement: 100, capPrice: 30000, deposit: 500, durationSec: 70, extendSec: 20, category: '翡翠玉镯', estimate: '市场参考价 ¥1.8万 – ¥2.6万' },
  },
  {
    id: 'room-3', anchorName: '腕表猎人 Leo', anchorAvatar: avatar(52), fans: '23.4万', viewers: 6620, tagline: '二奢榜第 1 名',
    lot: { id: 'lot-3', index: 1, title: '二手奢侈品腕表 · 钢款自动机械', subtitle: '95新 · 原盒原证 · 已质检', image: PROD.watch, tone: '#1b2a4a', tone2: '#aab3c7', startPrice: 5000, increment: 500, minIncrement: 500, capPrice: 88000, deposit: 2000, durationSec: 90, extendSec: 30, category: '二手奢侈品', estimate: '市场参考价 ¥6.8万 – ¥7.6万' },
  },
];

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
