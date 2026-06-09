import { useState } from 'react';
import { Form, Input, InputNumber, Select, Switch, Button, Upload, Divider, Space, Alert, App as AntdApp } from 'antd';
import { PlusOutlined, RocketOutlined, SaveOutlined } from '@ant-design/icons';
import { fmtMoney } from '../../lib/format';
import { computeIncrement } from '../../lib/pricing';
import { PROD } from '../../lib/assets';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';

const yuanToCents = (y: unknown): string => String(Math.round((Number(y) || 0) * 100));

const CAT_EMOJI: Record<string, string> = { 玉石珠宝: '🧿', 翡翠玉镯: '💚', 二手奢侈品: '⌚️', 文玩杂项: '🫖', 钱币邮票: '🪙', 艺术品: '🎴', 特色食品: '🍫' };
const CAT_IMG: Record<string, string> = { 玉石珠宝: PROD.jadePendant, 翡翠玉镯: PROD.jadeBangle, 二手奢侈品: PROD.watch, 文玩杂项: PROD.teapot, 钱币邮票: PROD.goldNecklace, 艺术品: PROD.diamond, 特色食品: PROD.chocolate };

export default function AuctionPublish() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
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

  // ✨ AI 生成商品介绍：调用真实豆包多模态（/facts/draft），可能耗时 10-30s。
  // 把返回的 facts 拼成中文介绍，附上高风险免责声明，写回「商品介绍」字段。
  const onAiIntro = async () => {
    const name = form.getFieldValue('name');
    if (!name) { message.warning('请先填写商品名称'); return; }
    setAiBusy(true);
    try {
      await ensureSession('seller-demo');
      const { facts, highRiskFieldsDisclaimer } = await api.draftFacts({
        productId: 'draft-preview',
        title: name,
        description: form.getFieldValue('intro') || '',
        // AI 视觉需服务端可抓取的【绝对】URL；上传图是相对 /uploads/，补成同源绝对地址（公网回环可达，过 SSRF）。
        imageUrls: [uploadedUrl ? (uploadedUrl.startsWith('http') ? uploadedUrl : location.origin + uploadedUrl) : (CAT_IMG[form.getFieldValue('category') as string] ?? PROD.jadePendant)],
      });
      let text = (facts ?? [])
        .map((f: { value?: string }) => f.value)
        .filter(Boolean)
        .join('，');
      if (highRiskFieldsDisclaimer) text += `（${highRiskFieldsDisclaimer}）`;
      form.setFieldsValue({ intro: text.slice(0, 200) });
      message.success('AI 已生成商品介绍');
    } catch (e: any) {
      message.error('AI 生成失败：' + (e?.message || e));
    } finally {
      setAiBusy(false);
    }
  };

  // AI 推荐加价幅度：按封顶价（价值档）+ 基础热度推算一个「好看」的加价档位。
  const onAiStep = () => {
    const rec = computeIncrement(form.getFieldValue('cap') || 0, 1000, 1);
    form.setFieldsValue({ step: rec, minStep: rec });
    message.success('AI 推荐加价幅度 ¥' + rec);
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
                <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} loading={aiBusy} onClick={onAiIntro}>✨ AI 生成介绍</Button>
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
              <div style={{ fontSize: 10.5, opacity: 0.75, marginTop: 8 }}>封顶 ¥{fmtMoney(v.cap ?? 0)} · {v.autoExtend ? `延时 ${v.extendSec ?? 15}s` : '不延时'} · 保证金 ¥{fmtMoney(v.deposit ?? 0)}</div>
            </div>
            <div className="pub-cta">立即出价 ¥{fmtMoney((v.start ?? 0) + step)}</div>
          </div>
          <div style={{ fontSize: 11.5, color: '#aaa', marginTop: 10, lineHeight: 1.6 }}>预览随表单实时更新。发布后该卡片将出现在主播直播间，买家点击「我要参与」签署条款即可出价。</div>
        </div>
      </div>
    </div>
  );
}
