import { useCallback, useEffect, useState } from 'react';
import { Form, Input, InputNumber, Select, Switch, Button, Upload, Divider, Space, Alert, Popconfirm, Tag, App as AntdApp } from 'antd';
import { PlusOutlined, RocketOutlined, SaveOutlined, ThunderboltOutlined, FolderOpenOutlined, DeleteOutlined, HistoryOutlined, VideoCameraAddOutlined, CheckCircleFilled } from '@ant-design/icons';
import { fmtMoney } from '../../lib/format';
import { recommendIncrement } from '../../lib/pricing';
import { PROD } from '../../lib/assets';
import { INTRO_TEMPLATES, defaultIntro, pickIntro, pickEstimate } from '../../lib/intro';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';
import { isJunk } from '../../lib/mapBackend';
import { listDrafts, upsertDraft, removeDraft, newDraftId, fmtSavedAt, type AuctionDraft } from '../drafts';

const yuanToCents = (y: unknown): string => String(Math.round((Number(y) || 0) * 100));

// 本地占位图（products/…）和上传图（/uploads/…）都是相对路径；发给 AI 识图、
// 存进后端的 imageUrl 统一补成同源绝对地址（过 SSRF、跨端可取）。
const toAbsUrl = (u: string): string => (u.startsWith('http') ? u : new URL(u, location.href).toString());

const CAT_EMOJI: Record<string, string> = { 名表: '⌚️', 箱包: '👜', 服饰: '👗', 鞋履: '👟' };
const CAT_IMG: Record<string, string> = { 名表: PROD.watch, 箱包: PROD.bag, 服饰: PROD.apparel, 鞋履: PROD.shoes };

export default function AuctionPublish() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [sellingPoints, setSellingPoints] = useState<string[]>([]);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const v = Form.useWatch([], form) || {};
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [fileList, setFileList] = useState<any[]>([]);
  const [drafts, setDrafts] = useState<AuctionDraft[]>(() => listDrafts());
  const [draftId, setDraftId] = useState<string | null>(null); // 表单当前载入的草稿；发布成功即消耗
  const [aiBusy, setAiBusy] = useState(false); // #261-12b AI 识图生成中
  const [aiEstimate, setAiEstimate] = useState<number | null>(null); // #261-12b 识图估价（元）→ 推荐加价幅度
  const [videoFile, setVideoFile] = useState<File | null>(null); // #261-12b 直播视频（发布后推流）
  const [history, setHistory] = useState<any[]>([]); // #261-13 发布历史
  const previewImg = uploadedUrl || (CAT_IMG[v.category as string] ?? PROD.watch);
  const step = v.step ?? 50;

  // #261-13: 发布历史 — 主播看得到这场直播发过什么（10s 轮询，与商品管理同源）。
  const loadHistory = useCallback(async () => {
    try {
      const { auctions = [] } = await api.listAuctions({ limit: 500 } as any);
      setHistory((auctions as any[]).filter((a) => a.auctionId && !isJunk(a.productName)).slice(0, 10));
    } catch { /* keep last good */ }
  }, []);
  useEffect(() => {
    loadHistory();
    const t = setInterval(loadHistory, 10_000);
    return () => clearInterval(t);
  }, [loadHistory]);

  // #256: AI 拍卖文案（标题/卖点/开场话术，LLM 起草）— 与 #261 的识图介绍并存：
  // 识图按钮管「商品介绍」（看图写），这个按钮管标题+卖点+话术（读表单文字）。
  const onGenerateCopy = async () => {
    if (copyBusy) return;
    const vals = form.getFieldsValue();
    setCopyBusy(true);
    setCopyNote(null);
    try {
      await ensureSession('seller-demo');
      const draft = await api.draftListing({
        title: vals.name || '',
        description: vals.intro || '',
        category: vals.category || '',
      });
      const next: Record<string, string> = {};
      if (draft?.title) next.name = draft.title;
      if (draft?.script) next.intro = draft.script;
      if (Object.keys(next).length > 0) form.setFieldsValue(next);
      setSellingPoints(Array.isArray(draft?.sellingPoints) ? draft.sellingPoints : []);
      const note = draft?.fallback
        ? 'AI 暂不可用 · 已填入兜底文案，可继续编辑'
        : 'AI 已生成 · 请核对后再发布';
      setCopyNote(note);
      message.success(note);
    } catch (e: any) {
      const msg = '生成失败：' + (e?.message || e);
      setCopyNote(msg);
      message.warning(msg);
    } finally {
      setCopyBusy(false);
    }
  };

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

  // ✨ AI 生成商品介绍 (#261-12b) —— 真图识别优先，不再模板先行：
  //   点击后调真豆包多模态识图（/facts/draft），用上传的商品主图直出全中文、
  //   有人味的介绍（sidecar 已做合规清洗 + 免责尾巴）。按钮转圈最多 15s；
  //   仅当识图失败/超时才退回分类模板兜底（demo 不能空白），并明确提示。
  const onAiIntro = () => {
    const name = String(form.getFieldValue('name') || '').trim();
    if (!name) { message.warning('请先填写商品名称'); return; }
    if (!uploadedUrl) { message.warning('请先上传商品主图 — AI 要看着真图写介绍'); return; }
    const category = form.getFieldValue('category') as string;
    setAiBusy(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    void (async () => {
      try {
        await ensureSession('seller-demo');
        const resp = await api.draftFacts({
          productId: 'draft-preview',
          title: name,
          description: String(form.getFieldValue('intro') || ''),
          // AI 视觉需服务端可抓取的【绝对】URL。
          imageUrls: [toAbsUrl(uploadedUrl)],
          signal: ctrl.signal,
        });
        const refined = pickIntro(name, resp);
        // 识图估价随手带回（给「AI 推荐」加价幅度用 — #261-12b 推荐识图化）。
        const est = pickEstimate(resp);
        if (est) setAiEstimate(est);
        if (refined) {
          form.setFieldsValue({ intro: refined });
          message.success(est ? `✨ AI 已看图写好介绍 · 识图估价约 ¥${fmtMoney(est)}` : '✨ AI 已看图写好介绍');
          return;
        }
        throw new Error('empty intro');
      } catch {
        // 识图失败/超时 → 模板兜底（明确告知，不冒充 AI）。
        const tpl = (INTRO_TEMPLATES[category] ?? defaultIntro)(name).slice(0, 200);
        form.setFieldsValue({ intro: tpl });
        message.warning('AI 识图暂不可用，已先用通用文案 — 可点击重试');
      } finally {
        clearTimeout(timer);
        setAiBusy(false);
      }
    })();
  };

  // AI 推荐加价幅度（#261-12b 识图化）：优先用「AI 识图估价」（estimateCNY，
  // 点过 AI 识图生成介绍后自动带回）取 ≈2.5% 的「好看」档位；没估价时退回
  // 封顶价启发式。详见 lib/pricing.recommendIncrement。
  const onAiStep = () => {
    const cap = Number(form.getFieldValue('cap')) || 0;
    const basis = aiEstimate ?? cap;
    if (!basis) { message.warning('先点「AI 识图生成介绍」拿到估价，或填写封顶价'); return; }
    const rec = recommendIncrement(basis);
    form.setFieldsValue({ step: rec }); // minStep 字段已按 #255 移除（与后端 model.Rules 对齐）
    message.success(aiEstimate
      ? `AI 按图估价 ¥${fmtMoney(aiEstimate)} → 推荐加价幅度 ¥${rec}`
      : `AI 推荐加价幅度 ¥${rec}（按封顶价约 2.5%）`);
  };

  // ---- 草稿箱：localStorage 持久化（demo 单卖家本机即可）。存/载/删，发布成功即消耗。 ----
  const onSaveDraft = () => {
    const vals = form.getFieldsValue();
    const name = String(vals.name || '').trim();
    if (!name) { message.warning('先填写商品名称，才能存草稿'); return; }
    const id = draftId ?? newDraftId();
    setDrafts(upsertDraft({
      id, savedAt: Date.now(), name,
      category: vals.category, intro: vals.intro,
      cap: vals.cap, step: vals.step,
      duration: vals.duration, autoExtend: vals.autoExtend, extendSec: vals.extendSec,
      imageUrl: uploadedUrl,
    }));
    setDraftId(id);
    message.success(draftId ? '草稿已更新 · 见下方草稿箱' : '已存入下方草稿箱 📦');
  };

  const onLoadDraft = (d: AuctionDraft) => {
    form.setFieldsValue({
      name: d.name, category: d.category, intro: d.intro,
      cap: d.cap, step: d.step,
      duration: d.duration, autoExtend: d.autoExtend, extendSec: d.extendSec,
    });
    if (d.imageUrl) {
      setUploadedUrl(d.imageUrl);
      setFileList([{ uid: d.id, name: '草稿主图', status: 'done', url: d.imageUrl }]);
    } else {
      setUploadedUrl(null);
      setFileList([]);
    }
    setDraftId(d.id);
    message.success(`已载入草稿「${d.name}」，可继续编辑发布`);
  };

  const onDeleteDraft = (id: string) => {
    setDrafts(removeDraft(id));
    if (draftId === id) setDraftId(null);
    message.success('草稿已删除');
  };

  // #261-12b: 拖拽选直播视频（mp4/webm ≤64MB），发布后自动推到直播间循环播放。
  const onPickVideo = (file: File): boolean => {
    if (!/^video\/(mp4|webm)$/.test(file.type)) { message.error('仅支持 mp4 / webm 格式'); return false; }
    if (file.size > 64 * 1024 * 1024) { message.error('视频不能超过 64MB，请压缩后再上传'); return false; }
    setVideoFile(file);
    message.success(`已选择直播视频「${file.name}」，发布时先上传、开拍即自动播放`);
    return false; // 不走 antd 内建上传；发布拿到 auctionId 后再传
  };

  // REAL publish: createProduct → createDraft(rules) → freeze → start → LIVE.
  // The auction immediately appears in the buyer mobile rail and is biddable.
  const onPublish = () => {
    form.validateFields().then(async (vals: any) => {
      // #261-11: 开拍由「我自己上传的」图片/视频驱动 — 不再静默用预置示例图。
      if (!uploadedUrl) { message.warning('请先上传商品主图（AI 介绍与买家端都用它）'); return; }
      setBusy(true);
      try {
        await ensureSession('seller-demo');
        const imageUrl = toAbsUrl(uploadedUrl);
        const { productId } = await api.createProduct({
          name: vals.name,
          imageUrl,
          description: vals.intro || '',
        });
        const durationSec = Number(vals.duration) || 80;
        const { auctionId } = await api.createDraft({
          productId,
          // factsConfirmed: the seller signs off the product facts entered here.
          // The backend freeze gate refuses to start until facts are confirmed.
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
        // #261-12b: 直播视频必须在开拍【前】上传 — 之前放在 startLive 之后，
        // 上传期间倒计时已经在烧（80s 的场子传完视频只剩十几秒），而且先进房
        // 的买家拿不到 livePlayUrl（引擎只在进房时读一次快照）→「传了视频但
        // 移动端不播」。挪到 freeze/start 之前：开拍第 0 秒视频就位，所有人
        // 进房即播；上传失败不阻断发布，可去直播商品页重传。
        if (videoFile) {
          const mb = Math.round((videoFile.size / 1024 / 1024) * 10) / 10;
          const hideUp = message.loading(`直播视频上传中（${mb}MB）— 传完即开拍…`, 0);
          try {
            await api.uploadStreamVideo(auctionId, videoFile);
            hideUp();
            message.success('🎬 直播视频已就位，开拍即自动播放');
          } catch (ve: any) {
            hideUp();
            message.warning('视频上传失败（可去「直播商品 · 开始直播」重传）：' + (ve?.message || String(ve ?? '未知错误')));
          }
        }
        await api.freeze(auctionId, { factsConfirmed: true });
        // #261-12a: demoCrowd 开关随发布下发 — 服务端内置人气脚本（~9997 观众 +
        // 按规则随机模拟出价）随开拍自动注入。
        await api.startLive(auctionId, { durationMs: durationSec * 1000, demoCrowd: vals.demoCrowd !== false });
        message.success(`已发布开拍 🎉 移动端已上架 · ${auctionId.slice(0, 14)}`);
        // 发布后重置表单与已上传主图：否则 uploadedUrl 会被下一个商品沿用，
        // 导致「商品图片不反应商品变化」（新商品发上了上一个商品的图）。
        form.resetFields();
        setUploadedUrl(null);
        setFileList([]);
        setVideoFile(null);
        setAiEstimate(null);
        loadHistory(); // 发布历史立即出现这一单（#261-13）
        // 从草稿载入的商品发布成功即消耗草稿：避免已上架的商品还躺在草稿箱里被重复发布。
        if (draftId) { setDrafts(removeDraft(draftId)); setDraftId(null); }
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
        {/* #261-13: 发布历史 — 这场直播发过什么，一眼可见。 */}
        <div className="pub-history">
          <div className="pub-history-head">
            <HistoryOutlined /> 发布历史
            <span className="pub-history-count">{history.length}</span>
          </div>
          {history.length === 0 && <div className="pub-history-empty">还没有发布记录。<br />右侧填好商品，一键发布开拍。</div>}
          {history.map((a) => {
            const live = a.status === 'LIVE';
            const sub = a.status === 'LIVE' ? `竞拍中 · 当前 ¥${fmtMoney(Math.round(Number(a.currentPriceCents || 0) / 100))}`
              : a.status === 'SOLD' || a.status === 'ORDER_CREATED' ? `已成交 ¥${fmtMoney(Math.round(Number(a.currentPriceCents || 0) / 100))}`
              : a.status === 'CANCELLED' ? '已下架' : a.status === 'NO_BID' ? '流拍' : '待开拍';
            return (
              <div key={a.auctionId} className={'pub-hist-item' + (live ? ' live' : '')}>
                <img className="pub-hist-thumb" src={a.imageUrl || PROD.watch} alt="" loading="lazy" />
                <div className="pub-hist-meta">
                  <div className="pub-hist-name">{a.productName || '直播拍品'}</div>
                  <div className="pub-hist-sub">{sub}{a.createdAtMs ? ` · ${new Date(a.createdAtMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
                </div>
                {live && <Tag color="#fe2c55" style={{ marginInlineEnd: 0 }}>LIVE</Tag>}
              </div>
            );
          })}
        </div>
        <Form form={form} layout="vertical" initialValues={{ category: '名表', start: 0, step: 50, cap: 12000, duration: 80, autoExtend: true, extendSec: 15, demoCrowd: true }}>
          <Divider orientation="left" plain>商品信息</Divider>
          <Form.Item label="商品主图" required tooltip="上传真实商品图（≤5MB · png/jpg/webp）— AI 介绍按这张图识别生成，买家端也展示它">
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
          {/* #261-12b: 拖拽视频 → 发布后直接推流到直播间（买家端自动循环播放，无需 OBS）。 */}
          <Form.Item label="直播视频（选填）" tooltip="拖入 mp4/webm（≤64MB）。发布开拍后自动作为本场直播画面推流，买家进直播间即自动播放">
            <div className="pub-video-dragger">
              <Upload.Dragger accept="video/mp4,video/webm" showUploadList={false} beforeUpload={onPickVideo} maxCount={1}>
                <p style={{ margin: '6px 0 2px' }}><VideoCameraAddOutlined style={{ fontSize: 26, color: '#fe2c55' }} /></p>
                <p style={{ fontWeight: 600, margin: 0 }}>拖拽视频到这里，开拍即作为直播画面自动播放</p>
                <p style={{ color: '#999', fontSize: 12, margin: '4px 0 6px' }}>建议 H.264 编码 mp4 · ≤64MB（webm 在 iPhone 无法播放；也可发布后用 OBS 推真镜头）</p>
              </Upload.Dragger>
            </div>
            {videoFile && (
              <div className="pub-video-meta">
                <CheckCircleFilled /> 已就绪：{videoFile.name}（{Math.round(videoFile.size / 1024 / 1024 * 10) / 10}MB）
                <Button size="small" type="text" danger onClick={() => setVideoFile(null)}>移除</Button>
              </div>
            )}
          </Form.Item>
          <Form.Item label="商品名称" name="name" rules={[{ required: true, message: '请输入商品名称' }]}>
            <Input placeholder="如：百达翡丽年历计时腕表 玫瑰金蓝盘" maxLength={60} showCount />
          </Form.Item>
          <Form.Item label="商品分类" name="category">
            <Select options={Object.keys(CAT_EMOJI).map((c) => ({ label: `${CAT_EMOJI[c]} ${c}`, value: c }))} />
          </Form.Item>
          <Form.Item
            name="intro"
            label={
              <Space>
                <span>商品介绍</span>
                <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} loading={aiBusy} onClick={onAiIntro}>{aiBusy ? 'AI 识图中…' : '✨ AI 识图生成介绍'}</Button>
                <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} icon={<ThunderboltOutlined />} loading={copyBusy} onClick={onGenerateCopy}>AI 拍卖文案</Button>
              </Space>
            }
          >
            <Input.TextArea rows={2} placeholder="材质、成色、证书、瑕疵说明等" maxLength={200} showCount />
          </Form.Item>
          {copyNote && (
            <div style={{ marginTop: -8, marginBottom: 10, fontSize: 12, color: '#8c8c8c' }}>{copyNote}</div>
          )}
          {sellingPoints.length > 0 && (
            <div style={{ marginTop: -2, marginBottom: 10 }}>
              <Space size={[6, 6]} wrap>
                {sellingPoints.map((p, i) => <Tag color="gold" key={`${p}-${i}`}>{p}</Tag>)}
              </Space>
            </div>
          )}
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="AI 文案仅供起草"
            description="标题、卖点和开场话术不会自动发布为权威事实；卖家需核对后再点击发布。"
          />
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
            <Form.Item label="竞拍时长（秒）" name="duration" style={{ flex: 1 }}>
              <InputNumber min={10} step={10} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={16} style={{ display: 'flex', alignItems: 'flex-start' }}>
            <Form.Item label="结束前自动延时" name="extendSec" style={{ flex: 1 }} tooltip="结束前 10s 内有人出价则延长，10-30s">
              <InputNumber min={10} max={30} step={5} addonAfter="秒" style={{ width: '100%' }} disabled={v.autoExtend === false} />
            </Form.Item>
            <Form.Item label="启用延时" name="autoExtend" valuePropName="checked">
              <Switch />
            </Form.Item>
            {/* #261-12a: 发布即人气 — 服务端自动注入 ~9997 观众 + 按规则随机模拟出价 */}
            <Form.Item label="演示人气" name="demoCrowd" valuePropName="checked" tooltip="开拍后系统自动注入约 9997 名观众与按规则随机出价（封顶前自动停手，落锤留给真人）">
              <Switch checkedChildren="自动" unCheckedChildren="关" />
            </Form.Item>
          </Space>
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" size="large" icon={<RocketOutlined />} loading={busy} onClick={onPublish}>立即发布开拍</Button>
            <Button size="large" icon={<SaveOutlined />} onClick={onSaveDraft}>存草稿{drafts.length > 0 ? ` (${drafts.length})` : ''}</Button>
          </Space>

          {/* 草稿箱：有草稿才出现，正好长在「存草稿」按钮下方——存完立刻看得见。 */}
          {drafts.length > 0 && (
            <div className="draft-box">
              <div className="draft-box-head">
                <span className="draft-box-title"><FolderOpenOutlined /> 草稿箱</span>
                <span className="draft-box-count">{drafts.length}</span>
                <span className="draft-box-hint">存在本机浏览器 · 载入即可继续编辑</span>
              </div>
              {drafts.map((d) => (
                <div key={d.id} className={'draft-item' + (d.id === draftId ? ' editing' : '')}>
                  <img
                    className="draft-thumb"
                    src={d.imageUrl || CAT_IMG[d.category ?? ''] || PROD.watch}
                    alt=""
                    onError={(e) => { e.currentTarget.src = CAT_IMG[d.category ?? ''] ?? PROD.watch; }}
                  />
                  <div className="draft-meta">
                    <div className="draft-name">{d.name}</div>
                    <div className="draft-sub">
                      {CAT_EMOJI[d.category ?? ''] ? `${CAT_EMOJI[d.category ?? '']} ` : ''}{d.category || '未分类'} · 封顶 ¥{fmtMoney(d.cap ?? 0)} · 加价 ¥{fmtMoney(d.step ?? 0)} · {d.duration ?? 80}s
                    </div>
                  </div>
                  <span className="draft-time">{fmtSavedAt(d.savedAt)}</span>
                  {d.id === draftId ? (
                    <Tag color="#fe2c55" style={{ marginInlineEnd: 0 }}>编辑中</Tag>
                  ) : (
                    <Button size="small" type="primary" ghost onClick={() => onLoadDraft(d)}>载入</Button>
                  )}
                  <Popconfirm title="删除这条草稿？" okText="删除" cancelText="留着" okButtonProps={{ danger: true }} onConfirm={() => onDeleteDraft(d.id)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除草稿" />
                  </Popconfirm>
                </div>
              ))}
            </div>
          )}
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
              <div style={{ fontSize: 10.5, opacity: 0.75, marginTop: 8 }}>{(v.cap ?? 0) > 0 ? `封顶 ¥${fmtMoney(v.cap)}` : '不封顶'} · {v.autoExtend ? `延时 ${v.extendSec ?? 15}s` : '不延时'}</div>
            </div>
            <div className="pub-cta">立即出价 ¥{fmtMoney((v.start ?? 0) + step)}</div>
          </div>
          <div style={{ fontSize: 11.5, color: '#aaa', marginTop: 10, lineHeight: 1.6 }}>预览随表单实时更新。发布后该卡片将出现在主播直播间，买家点击「我要参与」签署条款即可出价。</div>
        </div>
      </div>
    </div>
  );
}
