// lib/intro — 商品介绍文案的全部纯逻辑（秒出模板 + AI 识图精修的取舍）。
//
// 两段式契约（与 AuctionPublish「✨ AI 生成介绍」配合）：
//   1) 点击瞬间写入分类模板 —— 卖家零等待、永不空白。模板按"金牌主播口播"
//      标准写：有人味、有画面感、带点俏皮，落点是让人想出价；合规上一律
//      不承诺真伪（平台不保真）、不暗示升值，结尾带免责。
//   2) 后台真豆包多模态识图（/facts/draft）返回后，pickIntro 决定精修文案：
//      优先用模型一次调用直出的 intro（sidecar 已做违禁词/链接/电话/价格
//      清洗，违规即整段丢弃），缺失时退回 facts 结构化拼接，两者都没有
//      则返回 null —— 保留模板。
//
// 0 元起拍是真实硬编码规则（AuctionPublish 始终 startPriceCents=0），写进
// 文案不是营销话术。
export type DraftFact = { field?: string; value?: string; highRisk?: boolean };

export const INTRO_TEMPLATES: Record<string, (name: string) => string> = {
  玉石珠宝: (n) => `${n}：灯下一汪润光，上手温凉贴肤，往领口一挂气质就稳了。0元起拍无套路，眼缘这东西，慢一步就是别人的了。成色瑕疵以实物及卖家声明为准，平台不保真，理性出价。`,
  翡翠玉镯: (n) => `${n}：种水透亮像盛了一汪春水，圈口上手不卡腕，抬手全是温柔。0元起拍，出到哪算哪——镯子认主人，手气也认。颜色种地以实物为准，平台不保真，理性出价。`,
  二手奢侈品: (n) => `${n}：经典款不挑年份，品相细节都摆在图里，二手价上老钱质感。0元起拍，捡漏窗口已开，懂行的别装睡。真伪成色由卖家声明，平台不作鉴定背书，理性竞拍。`,
  文玩杂项: (n) => `${n}：包浆是时间一把一把盘出来的，上手压手、越盘越亮，案头一放全是故事。0元起拍，识货的先上车。年代材质以卖家描述为准，平台不保真，理性出价。`,
  钱币邮票: (n) => `${n}：方寸之间全是年代感，品相细节高清见图，藏册里就缺这一席。0元起拍，错过再等一轮行情。评级真伪以卖家声明为准，平台不作担保，理性竞拍。`,
  艺术品: (n) => `${n}：挂上墙自带气场，细节越看越有味道，客厅书房都压得住。0元起拍，把心动带回家。作者年代以卖家描述为准，平台不作鉴定保证，理性出价。`,
  特色食品: (n) => `${n}：开袋香气先到，一口下去懂的都懂，自享送礼两相宜。0元起拍，拼手速也拼缘分。保质期产地以实物标签为准，按需理性出价。`,
};

export const defaultIntro = (n: string) =>
  `${n}：细节都在图里，成色在线，眼缘对了就是你的。0元起拍，价高者得，犹豫就会败北。材质瑕疵以实物及卖家声明为准，平台不保真，理性出价。`;

// AI intro 不写免责（sidecar prompt 明确禁止）——免责尾巴由这里确定性追加，
// 合规不依赖模型自觉。
export const INTRO_TAIL = '成色与瑕疵以实物及卖家声明为准，平台不保真，理性出价。';

// composeIntro 把真豆包识图返回的 facts 拼成一段「AI 识图」介绍：过滤掉
// highRisk / authenticity / unverified（平台不保真），无可用事实时返回 null。
// 现在仅作为 intro 缺失/被清洗掉时的结构化兜底。
const FIELD_CN: Record<string, string> = { category: '品类', brand: '品牌', model: '型号', condition: '成色', defects: '瑕疵', material: '材质', color: '颜色' };
export function composeIntro(name: string, facts?: DraftFact[]): string | null {
  const good = (facts ?? []).filter(
    (f) => f?.value && !f.highRisk && f.field !== 'authenticity' && String(f.value).trim().toLowerCase() !== 'unverified',
  );
  if (!good.length) return null;
  const parts = good.map((f) => `${FIELD_CN[f.field ?? ''] ?? f.field}：${f.value}`);
  return `${name}（AI 识图）${parts.join('，')}。${INTRO_TAIL}`;
}

// pickIntro：AI 识图响应 → 精修文案。模型直出的 intro（已过 sidecar 合规
// 清洗）优先；它本身不含免责则追加 INTRO_TAIL；intro 为空（mock / 清洗
// 丢弃 / 旧版 sidecar）退回 composeIntro；最后裁到表单 200 字上限。
export function pickIntro(name: string, resp?: { intro?: string; facts?: DraftFact[] }): string | null {
  const ai = String(resp?.intro ?? '').trim();
  if (ai) {
    const text = ai.includes('不保真') ? ai : ai + INTRO_TAIL;
    return text.slice(0, 200);
  }
  const fallback = composeIntro(name, resp?.facts);
  return fallback ? fallback.slice(0, 200) : null;
}
