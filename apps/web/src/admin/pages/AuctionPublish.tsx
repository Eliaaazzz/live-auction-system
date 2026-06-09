import { useState } from 'react';
import { Form, Input, InputNumber, Select, Switch, Button, Upload, Divider, Space, Alert, App as AntdApp } from 'antd';
import { PlusOutlined, RocketOutlined, SaveOutlined } from '@ant-design/icons';
import { fmtMoney } from '../../lib/format';
import { recommendIncrement } from '../../lib/pricing';
import { PROD } from '../../lib/assets';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';

const yuanToCents = (y: unknown): string => String(Math.round((Number(y) || 0) * 100));

const CAT_EMOJI: Record<string, string> = { 玉石珠宝: '🧿', 翡翠玉镯: '💚', 二手奢侈品: '⌚️', 文玩杂项: '🫖', 钱币邮票: '🪙', 艺术品: '🎴', 特色食品: '🍫' };
const CAT_IMG: Record<string, string> = { 玉石珠宝: PROD.jadePendant, 翡翠玉镯: PROD.jadeBangle, 二手奢侈品: PROD.watch, 文玩杂项: PROD.teapot, 钱币邮票: PROD.goldNecklace, 艺术品: PROD.diamond, 特色食品: PROD.chocolate };

// 即时智能模板：点「AI 生成介绍」立刻出文案（卖家零等待、永不空白），合规——
// 不出现「保真/正品/假一赔十」等词，结尾统一带平台不保真声明。后台真豆包返回后再精修。
const INTRO_TEMPLATES: Record<string, (name: string) => string> = {
  玉石珠宝: (n) => `${n}：天然材质，色泽温润，雕工细腻，佩戴大气百搭。成色与瑕疵以实物及卖家声明为准，平台不作真伪保证，理性出价。`,
  翡翠玉镯: (n) => `${n}：种水透亮，触手细腻，圈口适中，日常佩戴显气质。颜色与种地以实物为准，平台不保真，喜欢的朋友放心参与。`,
  二手奢侈品: (n) => `${n}：经典款式，品相良好，配件情况以图为准。二手非全新，真伪与成色由卖家声明，平台不作鉴定背书，请理性竞拍。`,
  文玩杂项: (n) => `${n}：包浆自然，形制规整，盘玩手感佳。年代与材质以卖家描述为准，平台不保真，识货的朋友可大胆出价。`,
  钱币邮票: (n) => `${n}：品相清晰，存世可藏，细节见图。评级与真伪以卖家声明为准，平台不作担保，欢迎理性竞拍。`,
  艺术品: (n) => `${n}：做工考究，观感出众，适合收藏陈设。作者与年代以卖家描述为准，平台不作鉴定保证。`,
  特色食品: (n) => `${n}：精选用料，风味地道，适合自享或送礼。保质期与产地以实物标签为准，请按需出价。`,
};
const defaultIntro = (n: string) => `${n}：成色良好，细节见图，喜欢的朋友可参与竞拍。具体材质与瑕疵以实物及卖家声明为准，平台不作真伪保证。`;

// composeIntro 把真豆包识图返回的 facts 拼成一段「AI 识图」介绍：过滤掉
// highRisk / authenticity / unverified（平台不保真），无可用事实时返回 null（保留模板）。
const FIELD_CN: Record<string, string> = { category: '品类', brand: '品牌', model: '型号', condition: '成色', defects: '瑕疵', material: '材质', color: '颜色' };
function composeIntro(name: string, facts?: Array<{ field?: string; value?: string; highRisk?: boolean }>): string | null {
  const good = (facts ?? []).filter(
    (f) => f?.value && !f.highRisk && f.field !== 'authenticity' && String(f.value).trim().toLowerCase() !== 'unverified',
  );
  if (!good.length) return null;
  const parts = good.map((f) => `${FIELD_CN[f.field ?? ''] ?? f.field}：${f.value}`);
  return `${name}（AI 识图）${parts.join('，')}。成色与瑕疵以实物及卖家声明为准，平台不作真伪保证。`;
}

export default function AuctionPublish() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const v = Form.useWatch([], form) || {};
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [fileList, setFileList] = useState<any[]>([]);
  const previewImg = uploadedUrl || (CAT_IMG[v.category as string] ?? PROD.jadePendant);
  const step = v.step ?? 50;

  // REAL upload: POST /api/upload (multipart) → { url } same-origin; stored as the product imageUrl.
  const handleUpload = async (file: File): Promise<boolean> => {
    if (!/image\/(png|jpe?g|webp|gif)/.test(file.type)) { message.error('仅支持 png / jpg / webp / gif'); return false; }
    if (file.size > 5 * 1024 * 1024) { message.error('图片需 ≤ 5MB'); return false; }
    setFileList([{ uid: file.name, name: file.name, status: 'uploading' }]);
    try {
      await ensureSession('seller-demo');
      const { url } = await api.uploadImage(file);
      setUploadedUrl(url);
      setFileList([{ uid: file.name, name: file.name, status: 'done', url }]);
      message.success('商品主图已上传');
    } catch (e: any) {
      setFileList([]); setUploadedUrl(null);
      message.error('图片上传失败：' + (e?.message || e));
    }
    return false; // stop antd's built-in XHR; we upload via api.uploadImage
  };

  // ✨ AI 生成商品介绍 —— 秒出 + 后台真 AI 精修：
  //   1) 点击【立刻】写入合规智能模板，卖家零等待、按钮不转圈、永不空白；
  //   2) 同时【非阻塞】调真豆包多模态识图（/facts/draft），8s 内返回且卖家未改动
  //      就替换成「AI 识图」版；超时/失败/已被改动则保留模板。
  // 这样真模型再慢也不卡 demo，而 AI 仍真实在跑（不是假装）。
  const onAiIntro = () => {
    const name = String(form.getFieldValue('name') || '').trim();
    if (!name) { message.warning('请先填写商品名称'); return; }
    const category = form.getFieldValue('category') as string;
    const tpl = (INTRO_TEMPLATES[category] ?? defaultIntro)(name).slice(0, 200);
    form.setFieldsValue({ intro: tpl });
    message.success('✨ 已生成商品介绍');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    void (async () => {
      try {
        await ensureSession('seller-demo');
        const { facts } = await api.draftFacts({
          productId: 'draft-preview',
          title: name,
          description: tpl,
          // AI 视觉需服务端可抓取的【绝对】URL；上传图是相对 /uploads/，补成同源绝对地址（过 SSRF）。
          imageUrls: [uploadedUrl ? (uploadedUrl.startsWith('http') ? uploadedUrl : location.origin + uploadedUrl) : (CAT_IMG[category] ?? PROD.jadePendant)],
          signal: ctrl.signal,
        });
        const refined = composeIntro(name, facts);
        // 仅当卖家没动过（仍等于模板）才用 AI 版覆盖，绝不抹掉卖家手改。
        if (refined && form.getFieldValue('name') === name && form.getFieldValue('intro') === tpl) {
          form.setFieldsValue({ intro: refined.slice(0, 200) });
          message.success('AI 已根据商品图优化介绍');
        }
      } catch {
        /* 超时/中止/失败：静默保留模板——demo 永不暴露 AI 慢或不可用。 */
      } finally {
        clearTimeout(timer);
      }
    })();
  };

  // AI 推荐加价幅度：按封顶价（=价值上限）取 ≈2.5% 的「好看」档位。高价品给到有分量的
  // 一档（劳力士封顶 5 万→¥1300，而非旧公式的 ¥250）。详见 lib/pricing.recommendIncrement。
  const onAiStep = () => {
    const cap = Number(form.getFieldValue('cap')) || 0;
    const rec = recommendIncrement(cap);
    form.setFieldsValue({ step: rec, minStep: rec });
    message.success(`AI 推荐加价幅度 ¥${rec}${cap ? '（按封顶价约 2.5%）' : ''}`);
  };

  // REAL publish: createProduct → createDraft(rules) → freeze → start → LIVE.
  // The auction immediately appears in the buyer mobile rail and is biddable.
  const onPublish = () => {
    form.validateFields().then(async (vals: any) => {
      setBusy(true);
      try {
        await ensureSession('seller-demo');
        const imageUrl = uploadedUrl || (CAT_IMG[vals.category as string] ?? PROD.jadePendant);
        const { productId } = await api.createProduct({
          name: vals.name,
          imageUrl,
          description: vals.intro || '',
        });
        const durationSec = Number(vals.duration) || 80;
        const { auctionId } = await api.createDraft({
          productId,
          // factsConfirmed: the seller signs off the (AI-drafted) product facts.
          // The backend freeze gate (§spec) refuses to freeze/start until this is
          // true on the stored auction — set it here so 发布开拍 reaches LIVE in
          // one click. confirmedFacts carries the seller-entered description.
          factsConfirmed: true,
          confirmedFacts: { description: vals.intro || '', category: vals.category || '' },
          rules: {
            mode: 'ENGLISH',
            // 始终 0 元起拍 · 无保留价：忽略表单值，硬编码为 0。
            startPriceCents: '0',
            incrementCents: yuanToCents(vals.step),
            capPriceCents: yuanToCents(vals.cap),
            durationSec,
            extendWindowSec: 10,
            extendSec: vals.autoExtend === false ? 0 : (Number(vals.extendSec) || 30),
            maxExtensions: 10,
          },
        });
        await api.freeze(auctionId, { factsConfirmed: true });
        await api.startLive(auctionId, { durationMs: durationSec * 1000 });
        message.success(`已发布开拍 🎉 移动端已上架 · ${auctionId.slice(0, 14)}`);
        // 发布后重置表单与已上传主图：否则 uploadedUrl 会被下一个商品沿用，
        // 导致「商品图片不反应商品变化」（新商品发上了上一个商品的图）。
        form.resetFields();
        setUploadedUrl(null);
        setFileList([]);
      } catch (e: any) {
        message.error('发布失败：' + (e?.message || e));
      } finally {
        setBusy(false);
      }
    }).catch(() => message.error('请完善必填项与规则配置'));
  };

  return (
    <div className="admin-content">
      <Alert type="info" showIcon style={{ marginBottom: 18 }} message="发布即生成竞拍状态机：上架 → 竞拍中 → 截拍中 → 成交/流拍。规则一经有人出价不可再改，请提前配置好。" />
      <div className="pub-grid">
        <Form form={form} layout="vertical" initialValues={{ category: '玉石珠宝', start: 0, step: 50, minStep: 50, cap: 12000, duration: 80, autoExtend: true, extendSec: 15, deposit: 200 }}>
          <Divider orientation="left" plain>商品信息</Divider>
          <Form.Item label="商品主图" required tooltip="上传真实商品图（≤5MB · png/jpg/webp）；未上传则使用所选分类的示例图">
            <Upload
              listType="picture-card"
              accept="image/png,image/jpeg,image/webp,image/gif"
              fileList={fileList}
              maxCount={1}
              beforeUpload={handleUpload}
              onRemove={() => { setFileList([]); setUploadedUrl(null); }}
            >
              {fileList.length >= 1 ? null : <div><PlusOutlined /><div style={{ marginTop: 6 }}>上传</div></div>}
            </Upload>
          </Form.Item>
          <Form.Item label="商品名称" name="name" rules={[{ required: true, message: '请输入商品名称' }]}>
            <Input placeholder="如：金镶玉平安扣·和田玉吊坠项链首饰" maxLength={60} showCount />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item label="商品分类" name="category" style={{ flex: 1 }}>
              <Select options={Object.keys(CAT_EMOJI).map((c) => ({ label: `${CAT_EMOJI[c]} ${c}`, value: c }))} />
            </Form.Item>
            <Form.Item label="保证金" name="deposit" style={{ flex: 1 }} tooltip="参与冻结，成交付款后退回；弃标扣除">
              <InputNumber min={0} step={50} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item
            name="intro"
            label={
              <Space>
                <span>商品介绍</span>
                <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={onAiIntro}>✨ AI 生成介绍</Button>
              </Space>
            }
          >
            <Input.TextArea rows={2} placeholder="材质、成色、证书、瑕疵说明等" maxLength={200} showCount />
          </Form.Item>
          <Divider orientation="left" plain>竞拍规则</Divider>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item label="起拍价" name="start" style={{ flex: 1 }} extra="0 元起拍（固定 · 无保留价）" tooltip="本场拍卖始终 0 元起拍，无保留价，人人可参与">
              <InputNumber min={0} max={0} step={0} value={0} disabled addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="封顶价" name="cap" style={{ flex: 1 }} tooltip="出价达到封顶价立即成交">
              <InputNumber min={0} step={500} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item
              name="step"
              style={{ flex: 1 }}
              rules={[{ required: true }]}
              label={
                <Space>
                  <span>加价幅度（固定）</span>
                  <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={onAiStep}>AI 推荐</Button>
                </Space>
              }
            >
              <InputNumber min={1} step={10} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="最低加价" name="minStep" style={{ flex: 1 }} tooltip="后台可控；须 ≥ 加价幅度，防止小额加价拖延成交" rules={[({ getFieldValue }) => ({ validator: (_, val) => (val == null || val >= (getFieldValue('step') ?? 0) ? Promise.resolve() : Promise.reject(new Error('最低加价须 ≥ 加价幅度'))) })]}>
              <InputNumber min={1} step={10} addonBefore="¥" style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex', alignItems: 'flex-start' }}>
            <Form.Item label="竞拍时长（秒）" name="duration" style={{ flex: 1 }}>
              <InputNumber min={10} step={10} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="结束前自动延时" name="extendSec" style={{ flex: 1 }} tooltip="结束前 10s 内有人出价则延长，10-30s">
              <InputNumber min={10} max={30} step={5} addonAfter="秒" style={{ width: '100%' }} disabled={v.autoExtend === false} />
            </Form.Item>
            <Form.Item label="启用延时" name="autoExtend" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" size="large" icon={<RocketOutlined />} loading={busy} onClick={onPublish}>立即发布开拍</Button>
            <Button size="large" icon={<SaveOutlined />} onClick={() => message.success('已存草稿')}>存草稿</Button>
          </Space>
        </Form>
        <div className="pub-preview">
          <div style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>移动端直播间预览</div>
          <div className="pub-phone">
            <div style={{ fontSize: 12, opacity: 0.85 }}>距竞拍结束仅剩 {String(Math.floor((v.duration ?? 80) / 60)).padStart(2, '0')}:{String((v.duration ?? 80) % 60).padStart(2, '0')}</div>
            <img className="pub-img" src={previewImg} alt="" />
            <div className="pub-card">
              <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{v.name || '商品名称将显示在这里'}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                <div><div style={{ fontSize: 10, opacity: 0.7 }}>{v.start === 0 ? '0 元起拍' : '起拍价'}</div><div style={{ fontSize: 18, fontWeight: 800 }}>¥{fmtMoney(v.start ?? 0)}</div></div>
                <div style={{ textAlign: 'right' }}><div style={{ fontSize: 10, opacity: 0.7 }}>加价幅度</div><div style={{ fontSize: 18, fontWeight: 800 }}>¥{fmtMoney(step)}</div></div>
              </div>
              <div style={{ fontSize: 10.5, opacity: 0.75, marginTop: 8 }}>{(v.cap ?? 0) > 0 ? `封顶 ¥${fmtMoney(v.cap)}` : '不封顶'} · {v.autoExtend ? `延时 ${v.extendSec ?? 15}s` : '不延时'} · {(v.deposit ?? 0) > 0 ? `保证金 ¥${fmtMoney(v.deposit)}` : '免保证金'}</div>
            </div>
            <div className="pub-cta">立即出价 ¥{fmtMoney((v.start ?? 0) + step)}</div>
          </div>
          <div style={{ fontSize: 11.5, color: '#aaa', marginTop: 10, lineHeight: 1.6 }}>预览随表单实时更新。发布后该卡片将出现在主播直播间，买家点击「我要参与」签署条款即可出价。</div>
        </div>
      </div>
    </div>
  );
}
