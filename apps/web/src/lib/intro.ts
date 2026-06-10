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
  名表: (n) => `${n}：盘面灯下泛光，走时稳得让人安心，腕间一抬全是底气。0元起拍，捡漏窗口已开，懂表的别装睡。成色真伪以卖家声明为准，平台不作鉴定背书，理性竞拍。`,
  箱包: (n) => `${n}：五金锃亮、廓形挺括，通勤约会一包搞定，背出门就是态度。0元起拍，出到哪算哪，手慢真的无。成色细节以实物及卖家声明为准，平台不保真，理性出价。`,
  服饰: (n) => `${n}：版型立体、上身就有气场，细节做工经得起怼脸看，衣柜里就缺这一件。0元起拍，眼缘对了别犹豫。尺码成色以卖家描述为准，平台不保真，理性出价。`,
  鞋履: (n) => `${n}：鞋型正、上脚轻，闭眼搭都出片，鞋柜C位预定。0元起拍，码数合适就是缘分，价高者得。成色尺码以实物及卖家声明为准，平台不保真，理性竞拍。`,
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
  // estimateCNY 是给卖家配置参考的识图估价（#261-12b），绝不能出现在买家文案里
  // （价格随拍随变，写死会误导 — 与 sidecar intro 的禁价规则一致）。
  const good = (facts ?? []).filter(
    (f) => f?.value && !f.highRisk && f.field !== 'authenticity' && f.field !== 'estimateCNY' && String(f.value).trim().toLowerCase() !== 'unverified',
  );
  if (!good.length) return null;
  const parts = good.map((f) => `${FIELD_CN[f.field ?? ''] ?? f.field}：${f.value}`);
  return `${name}（AI 识图）${parts.join('，')}。${INTRO_TAIL}`;
}

// pickEstimate：从识图 facts 里取 AI 估价（estimateCNY，元）。返回 null 表示
// 模型没给/不可解析 — 调用方退回封顶价启发式（#261-12b 推荐加价幅度识图化）。
export function pickEstimate(resp?: { facts?: DraftFact[] }): number | null {
  const f = (resp?.facts ?? []).find((x) => x?.field === 'estimateCNY');
  if (!f?.value) return null;
  const n = parseInt(String(f.value).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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
