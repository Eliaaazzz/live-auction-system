import React from 'react';
import { useNavigate } from 'react-router-dom';
import { formatCentsCNY, StatusBadge } from './primitives.jsx';
import { api, ApiError } from '../lib/api.js';
import { ensureSession } from '../lib/auth.js';

// lumen-admin-extra.jsx
// Publish form · Cancel modal · Orders/Products

// ───────────────────────────────────────────────────────────────
// Admin · Publish form
// ───────────────────────────────────────────────────────────────
function AdminPublish() {
  const navigate = useNavigate();
  const [title, setTitle] = React.useState('百达翡丽 5711/1A · 蓝面');
  const [startCents, setStartCents] = React.useState('12000000');
  const [stepCents,  setStepCents]  = React.useState('500000');
  const [reserveCents, setReserveCents] = React.useState('10000000');
  const [capCents, setCapCents] = React.useState('30000000');
  const [duration, setDuration] = React.useState(30);
  const [maxExtends, setMaxExtends] = React.useState(5);
  const [antiSnipe, setAntiSnipe] = React.useState(true);
  const [auctionMode, setAuctionMode] = React.useState('ENGLISH');
  const [scheduleDate, setScheduleDate] = React.useState('2026-06-10');
  const [scheduleTime, setScheduleTime] = React.useState('21:00');
  // Real product media (item 4): an image URL the room renders + the VLM page
  // drafts facts from. Defaults to a sample so the demo has a real image;
  // sellers can paste their own. (No binary upload endpoint — a URL is the
  // spec-allowed input; the room degrades to a styled placeholder if it fails.)
  const [imageUrl, setImageUrl] = React.useState('https://images.unsplash.com/photo-1547996160-81dfa63595aa?w=900&q=80');
  const [description, setDescription] = React.useState('稀世腕表,蓝面,盘面完好,附原厂证书。');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  // #53-M4: cap must be reachable from start via integer steps. Without
  // this check the cap-hit path silently can't fire because no bid is
  // simultaneously >= cap AND in the (start + N*step) sequence. Auction
  // ends on duration timeout instead, which surprises the seller.
  // BigInt-safe modulo; only meaningful when step > 0 (separate guard).
  const stepBI = (() => { try { return BigInt(stepCents); } catch { return 0n; } })();
  const startBI = (() => { try { return BigInt(startCents); } catch { return 0n; } })();
  const capBI = (() => { try { return BigInt(capCents); } catch { return 0n; } })();
  const capReachable = stepBI > 0n && capBI > startBI && ((capBI - startBI) % stepBI) === 0n;

  const valid = title.length > 4
    && BigInt(startCents) > 0n
    && BigInt(reserveCents) <= BigInt(startCents)
    && BigInt(capCents) > BigInt(startCents)
    && capReachable;

  // Submit pipeline:
  //   1. ensureSession (seller role; backend's freeze handler runs ownsAuction)
  //   2. api.createProduct(...) → { productId }
  //   3. api.createDraft({ productId, rules{} }) → { auctionId }
  //   4. navigate to /admin/auctions/:id/vlm so seller can confirm VLM facts
  //
  // No api.schedule — backend doesn't ship a scheduled-start endpoint; seller
  // hits "Start" manually from the live console after VLM is confirmed +
  // freeze succeeds. scheduleDate/scheduleTime are stored as UI hint only.
  const handleSubmit = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await ensureSession('seller-demo');
      const { productId } = await api.createProduct({
        name: title,
        imageUrl,
        description,
      });
      // Backend contract is model.Rules (startPriceCents/incrementCents/
      // capPriceCents/durationSec/extendWindowSec/extendSec/maxExtensions) —
      // money as string. The old payload used different field names and 400'd.
      const { auctionId } = await api.createDraft({
        productId,
        rules: {
          mode:              auctionMode,
          startPriceCents: startCents,
          incrementCents:  stepCents,
          capPriceCents:   capCents,
          durationSec:     duration * 60,
          extendWindowSec: antiSnipe ? 10 : 0,
          extendSec:       antiSnipe ? 10 : 0,
          maxExtensions:   antiSnipe ? maxExtends : 0,
        },
      });
      navigate(`/admin/auctions/${auctionId}/vlm`);
    } catch (e) {
      const msg = e instanceof ApiError
        ? `${e.code || e.status} · ${e.message}`
        : (e?.message || String(e));
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      background: '#0e1018', color: 'var(--douyin-ink-text)', fontFamily: 'var(--font-sans)',
    }}>
      {/* breadcrumb */}
      <div style={{
        flexShrink: 0, padding: '14px 28px', display: 'flex', alignItems: 'center', gap: 14,
        borderBottom: '1px solid rgba(255,255,255,.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>拍品管理</span>
          <span style={{ color: 'var(--douyin-ink-dim)' }}>›</span>
          <span style={{ fontSize: 12, fontWeight: 600 }}>新建拍品 · DRAFT</span>
        </div>
        <div style={{ flex: 1 }}/>
        <button style={btnGhost2}>预览</button>
        <button style={btnGhost2}>保存草稿</button>
      </div>

      <div style={{
        flex: 1, display: 'grid', gridTemplateColumns: '1fr 340px', minHeight: 0,
      }}>
        {/* Form column */}
        <div style={{ padding: '24px 32px', overflow: 'auto', minHeight: 0 }} className="no-scrollbar">
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: '0 0 4px', letterSpacing: '-.015em' }}>
            新建拍品
          </h1>
          <p style={{ fontSize: 12, color: 'var(--douyin-ink-muted)', margin: '0 0 24px' }}>
            填写后将进入 VLM 事实核对 → SCHEDULED → LIVE。所有字段后续可在 DRAFT 状态下编辑。
          </p>

          {/* ─ Section: basics ─ */}
          <FormSection step="01" title="基本信息" desc="拍品标题、分类、LOT 编号">
            <FormRow label="拍品标题" required>
              <input value={title} onChange={e => setTitle(e.target.value)} style={inp}/>
              <Hint warn={title.length < 5}>建议 12–24 字，包含品牌 + 型号 + 关键参数</Hint>
            </FormRow>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <FormRow label="分类">
                <select style={inp} defaultValue="watch">
                  <option value="watch">腕表 / Watches</option>
                  <option>珠宝 / Jewelry</option>
                  <option>艺术品 / Art</option>
                  <option>收藏品 / Collectibles</option>
                </select>
              </FormRow>
              <FormRow label="LOT 编号" required>
                <input className="mono" defaultValue="2024-0142" style={{ ...inp, fontFamily: 'var(--font-mono)' }}/>
              </FormRow>
            </div>
          </FormSection>

          {/* ─ Section: media ─ (real image URL + 介绍; the room renders these
               and the VLM page drafts facts from the image) */}
          <FormSection step="02" title="商品图片 & 介绍" desc="图片 URL + 介绍 — 直播间渲染该图,VLM 据此抽取事实">
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{
                width: 96, height: 128, borderRadius: 8, flexShrink: 0, overflow: 'hidden',
                background: 'linear-gradient(160deg,#2a1f2e,#0a0e1a)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {imageUrl
                  ? <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                         onError={(e) => { e.currentTarget.style.display = 'none'; }}/>
                  : <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>无图</span>}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <FormRow label="图片 URL" required>
                  <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://…/item.jpg" style={inp}/>
                </FormRow>
                <FormRow label="商品介绍">
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                    rows={2} placeholder="成色 / 瑕疵 / 关键参数(VLM 会把它当作卖家声明,不作裁决)"
                    style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }}/>
                </FormRow>
              </div>
            </div>
          </FormSection>

          {/* ─ Section: pricing ─ */}
          <FormSection step="03" title="起拍设置" desc="货币以分(cents)为单位 · 字符串存储 · 永不浮点">
            <FormRow label="拍卖流程">
              <SegBar value={auctionMode} onChange={setAuctionMode}
                options={[
                  {v:'ENGLISH', l:'正式明拍'},
                  {v:'SEALED_FIRST', l:'提前暗拍'},
                ]}/>
              <Hint>
                {auctionMode === 'SEALED_FIRST'
                  ? '先收集隐藏出价，结束后按聚合结果推荐正式明拍 reserve'
                  : '直接进入公开竞价'}
              </Hint>
            </FormRow>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14 }}>
              <FormRow label="起拍价" required>
                <CurrencyInput cents={startCents} onChange={setStartCents}/>
              </FormRow>
              <FormRow label="加价阶梯" required>
                <CurrencyInput cents={stepCents} onChange={setStepCents}/>
                <Hint>每次出价最小增量</Hint>
              </FormRow>
              <FormRow label="保留价 (≤ 起拍价)" required>
                <CurrencyInput cents={reserveCents} onChange={setReserveCents}/>
                <Hint warn={BigInt(reserveCents) > BigInt(startCents)}>
                  {BigInt(reserveCents) > BigInt(startCents) ? '保留价不能高于起拍价' : '未达保留价 → NO_BID'}
                </Hint>
              </FormRow>
              <FormRow label="上限价 (cap)" required>
                <CurrencyInput cents={capCents} onChange={setCapCents}/>
                <Hint warn={BigInt(capCents) <= BigInt(startCents) || !capReachable}>
                  {BigInt(capCents) <= BigInt(startCents)
                    ? '上限价必须大于起拍价'
                    : !capReachable
                      ? '上限价不可达 · (cap - start) 必须是阶梯的整数倍'
                      : '触发即 AUCTION_SOLD'}
                </Hint>
              </FormRow>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginTop: 4 }}>
              <FormRow label="预计时长">
                <SegBar value={duration} onChange={setDuration}
                  options={[{v:15,l:'15min'},{v:30,l:'30min'},{v:60,l:'60min'}]}/>
              </FormRow>
              <FormRow label="反狙击 · Anti-Snipe">
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  borderRadius: 8, background: 'rgba(255,176,32,.08)', border: '1px solid rgba(255,176,32,.3)',
                }}>
                  <button onClick={() => setAntiSnipe(!antiSnipe)} style={{
                    width: 32, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer',
                    background: antiSnipe ? 'var(--state-extended)' : 'rgba(255,255,255,.1)',
                    position: 'relative', flexShrink: 0,
                  }}>
                    <span style={{
                      position: 'absolute', top: 2, left: antiSnipe ? 16 : 2,
                      width: 14, height: 14, borderRadius: 7, background: '#fff',
                      transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.3)',
                    }}/>
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--state-extended)', fontWeight: 600 }}>
                    末 10s 出价 → +30s
                  </span>
                </div>
              </FormRow>
              <FormRow label="最大延时次数">
                <SegBar value={maxExtends} onChange={setMaxExtends}
                  options={[{v:3,l:'×3'},{v:5,l:'×5'},{v:10,l:'×10'}]}/>
              </FormRow>
            </div>
          </FormSection>

          {/* ─ Section: schedule ─ */}
          <FormSection step="04" title="时间安排" desc="服务器时区 UTC+8 · 排期后无法直接 LIVE，需先 VLM 核对">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
              <FormRow label="开拍日期" required>
                <input type="date" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)} style={inp}/>
              </FormRow>
              <FormRow label="开拍时间" required>
                <input type="time" value={scheduleTime} onChange={e => setScheduleTime(e.target.value)} style={inp}/>
              </FormRow>
              <FormRow label="排期模式">
                <SegBar value="auto" onChange={()=>{}}
                  options={[{v:'auto',l:'到点自动 LIVE'},{v:'manual',l:'人工开拍'}]}/>
              </FormRow>
            </div>
          </FormSection>

          {/* ─ Section: policy ─ */}
          <FormSection step="05" title="政策与确认" desc="发布即代表你已阅读相关条款">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <CheckRow defaultChecked>已确认 LOT 真伪鉴定证书在档</CheckRow>
              <CheckRow defaultChecked>同意所有事件上链至 Evidence 哈希链，不可篡改</CheckRow>
              <CheckRow>同意 AI 拍卖师生成话术作为非权威辅助文本</CheckRow>
            </div>
          </FormSection>
        </div>

        {/* Sidebar — live preview + state */}
        <div style={{
          borderLeft: '1px solid rgba(255,255,255,.04)',
          padding: '24px 22px', display: 'flex', flexDirection: 'column', gap: 18,
          overflow: 'auto',
        }} className="no-scrollbar">
          <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', fontWeight: 600, letterSpacing: '.06em' }}>
            发布流程 · PIPELINE
          </div>
          <Pipeline current={0}/>

          <div style={{
            padding: '14px 16px', borderRadius: 10,
            background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
          }}>
            <div style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em', marginBottom: 6 }}>
              预览 · CARD
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, letterSpacing: '-.01em' }}>
              {title}
            </div>
            <table className="mono" style={{ fontSize: 11, color: 'var(--douyin-ink-text)' }}>
              <tbody>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12 }}>起拍</td>
                    <td>{formatCentsCNY(startCents)}</td></tr>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12 }}>+ 阶梯</td>
                    <td>{formatCentsCNY(stepCents)}</td></tr>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12 }}>保留</td>
                    <td>{formatCentsCNY(reserveCents)}</td></tr>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12 }}>上限</td>
                    <td style={{ color: 'var(--solemn-gold)' }}>{formatCentsCNY(capCents)}</td></tr>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12 }}>开拍</td>
                    <td>{scheduleDate} {scheduleTime}</td></tr>
                <tr><td style={{ color: 'var(--douyin-ink-muted)', paddingRight: 12 }}>反狙击</td>
                    <td style={{ color: antiSnipe ? 'var(--state-extended)' : 'var(--douyin-ink-muted)' }}>
                      {antiSnipe ? `末10s +30s · 最多 ×${maxExtends}` : '关闭'}
                    </td></tr>
              </tbody>
            </table>
          </div>

          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(37,244,238,.06)', border: '1px solid rgba(37,244,238,.22)',
            fontSize: 11, color: 'var(--douyin-ink-text)', lineHeight: 1.5,
          }}>
            <strong style={{ color: 'var(--douyin-cyan)' }}>下一步：</strong> 视频上传后 AI Sidecar 会自动运行 VLM，
            生成的 5 项事实需要在 <em>VLM 事实核对</em> 页人工确认，才能进入 SCHEDULED 状态。
          </div>
        </div>
      </div>

      {/* Bottom action bar */}
      <div style={{
        flexShrink: 0, padding: '14px 28px', borderTop: '1px solid rgba(255,255,255,.06)',
        background: 'rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{ fontSize: 11, color: error ? 'var(--state-rejected)' : 'var(--douyin-ink-muted)' }}>
          {error
            ? `创建失败 · ${error}`
            : valid ? '已就绪 · 进入下一步即开始 VLM 抽取' : '请补全必填项'}
        </div>
        <div style={{ flex: 1 }}/>
        <button onClick={() => navigate('/admin/auctions')} disabled={busy} style={btnGhost2}>取消</button>
        <button onClick={handleSubmit} disabled={!valid || busy} style={{
          ...btnPrimary2,
          background: (valid && !busy) ? 'linear-gradient(135deg, var(--douyin-red), var(--douyin-red-soft))' : 'rgba(107,114,128,.3)',
          color: (valid && !busy) ? '#fff' : 'var(--douyin-ink-muted)',
          cursor: (valid && !busy) ? 'pointer' : 'not-allowed',
        }}>
          {busy ? '正在创建 …' : '下一步 · VLM 核对 →'}
        </button>
      </div>
    </div>
  );
}

// helpers
const inp = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.12)',
  color: 'var(--douyin-ink-text)', fontSize: 13, fontFamily: 'var(--font-sans)',
  outline: 'none', boxSizing: 'border-box',
};
const btnPrimary2 = {
  padding: '10px 22px', borderRadius: 8, border: 'none',
  fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
  display: 'inline-flex', alignItems: 'center', gap: 8,
};
const btnGhost2 = {
  padding: '8px 16px', borderRadius: 8,
  background: 'transparent', border: '1px solid rgba(255,255,255,.14)',
  color: 'var(--douyin-ink-text)', fontSize: 12, cursor: 'pointer',
  fontFamily: 'inherit',
};
function chip(tone) {
  const c = tone === 'cyan' ? 'var(--douyin-cyan)' : tone === 'warn' ? 'var(--state-extended)' : '#fff';
  return {
    padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
    background: c + '26', color: c, fontFamily: 'var(--font-sans)',
  };
}
function FormSection({ step, title, desc, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
        <span className="mono" style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 4,
          background: 'rgba(254,44,85,.15)', color: 'var(--douyin-red)',
          fontWeight: 600, letterSpacing: '.04em',
        }}>STEP {step}</span>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>{desc}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </div>
  );
}
function FormRow({ label, required, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', fontWeight: 500 }}>
        {label} {required && <span style={{ color: 'var(--douyin-red)' }}>*</span>}
      </label>
      {children}
    </div>
  );
}
function Hint({ warn, children }) {
  return (
    <span style={{ fontSize: 10, color: warn ? 'var(--state-extended)' : 'var(--douyin-ink-dim)', fontFamily: 'var(--font-sans)' }}>
      {children}
    </span>
  );
}
function CurrencyInput({ cents, onChange }) {
  // Display as ¥X,XXX.YY but store as string cents (§4 P1).
  const toDraft = (v) => formatCentsCNY(v).slice(1).replace(/,/g, '');
  const [draft, setDraft] = React.useState(toDraft(cents));
  React.useEffect(() => setDraft(toDraft(cents)), [cents]);
  return (
    <div style={{ position: 'relative' }}>
      <span style={{
        position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
        color: 'var(--douyin-ink-muted)', fontSize: 13, pointerEvents: 'none',
      }}>¥</span>
      <input
        className="mono"
        value={draft}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d.]/g, '');
          const firstDot = raw.indexOf('.');
          const integerPart = (firstDot === -1 ? raw : raw.slice(0, firstDot)).replace(/\D/g, '') || '0';
          const fractionPart = (firstDot === -1 ? '' : raw.slice(firstDot + 1)).replace(/\D/g, '');
          const normalizedIntegerPart = integerPart.replace(/^0+(?=\d)/, '') || '0';
          const nextDraft = firstDot === -1 ? normalizedIntegerPart : `${normalizedIntegerPart}.${fractionPart.slice(0, 2)}`;
          setDraft(nextDraft);
          const centsStr = (normalizedIntegerPart + (fractionPart + '00').slice(0, 2)).replace(/^0+(?=\d)/, '') || '0';
          onChange(centsStr);
        }}
        style={{ ...inp, paddingLeft: 26, fontFamily: 'var(--font-mono)' }}
      />
    </div>
  );
}
function SegBar({ value, onChange, options }) {
  return (
    <div style={{
      display: 'inline-flex', padding: 3, borderRadius: 8,
      background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
    }}>
      {options.map(o => (
        <button key={o.v} onClick={() => onChange(o.v)} style={{
          padding: '5px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
          fontSize: 12, fontFamily: 'inherit',
          background: value === o.v ? 'var(--douyin-ink-card)' : 'transparent',
          color: value === o.v ? 'var(--douyin-ink-text)' : 'var(--douyin-ink-muted)',
          fontWeight: value === o.v ? 600 : 400,
        }}>{o.l}</button>
      ))}
    </div>
  );
}
function CheckRow({ defaultChecked, children }) {
  const [ck, setCk] = React.useState(defaultChecked);
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', borderRadius: 8,
      background: ck ? 'rgba(37,244,238,.05)' : 'rgba(255,255,255,.02)',
      border: '1px solid ' + (ck ? 'rgba(37,244,238,.2)' : 'rgba(255,255,255,.06)'),
      cursor: 'pointer', fontSize: 12,
    }}>
      <span onClick={() => setCk(!ck)} style={{
        width: 18, height: 18, borderRadius: 4, flexShrink: 0,
        background: ck ? 'var(--douyin-cyan)' : 'transparent',
        border: '1.5px solid ' + (ck ? 'var(--douyin-cyan)' : 'rgba(255,255,255,.25)'),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#0a0a14',
      }}>
        {ck && <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 5l2 2 4-5" strokeLinecap="round"/></svg>}
      </span>
      {children}
    </label>
  );
}
function Pipeline({ current }) {
  const steps = [
    { label: 'DRAFT',      desc: '填写表单' },
    { label: 'VLM 核对',   desc: '事实确认' },
    { label: 'SCHEDULED',  desc: '排期等待' },
    { label: 'LIVE',       desc: '直播竞拍' },
    { label: 'SOLD/...',   desc: '终态 + 上链' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '8px 0',
          }}>
            <div style={{
              flexShrink: 0, width: 22, height: 22, borderRadius: 11,
              background: active ? 'var(--douyin-red)' : done ? 'rgba(37,244,238,.2)' : 'rgba(255,255,255,.06)',
              color: active ? '#fff' : done ? 'var(--douyin-cyan)' : 'var(--douyin-ink-muted)',
              border: active ? '2px solid var(--douyin-red-soft)' : 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)',
            }}>
              {done ? '✓' : i + 1}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{
                fontSize: 12, fontWeight: active ? 600 : 500,
                color: active ? 'var(--douyin-ink-text)' : 'var(--douyin-ink-muted)',
                fontFamily: 'var(--font-mono)',
              }}>{s.label}</span>
              <span style={{ fontSize: 10, color: 'var(--douyin-ink-dim)' }}>{s.desc}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Admin · Cancel-with-confirmation modal (2-step)
// Rendered on top of the Live Console as the "danger zone confirm"
// ───────────────────────────────────────────────────────────────
function AdminCancelModal({
  currentCents = '0',
  onClose,
  onCancelAuction,
  busy = false,
  error = null,
  auctionId = '',
  eventsCount = 0,
  lastSeq = null,
}) {
  const requiredText = formatCentsCNY(currentCents).replace('¥', '').replace(/,/g, '');
  const [typed, setTyped] = React.useState('');
  const match = typed.replace(/[¥,\s]/g, '') === requiredText;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,.75)', backdropFilter: 'blur(10px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-sans)',
    }}>
      <div style={{
        width: 520, borderRadius: 14, overflow: 'hidden',
        background: '#15171f',
        boxShadow: '0 30px 80px rgba(0,0,0,.5), 0 0 0 1px rgba(254,44,85,.3)',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 22px',
          background: 'linear-gradient(180deg, rgba(254,44,85,.12), transparent)',
          borderBottom: '1px solid rgba(254,44,85,.2)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 18,
            background: 'rgba(254,44,85,.15)', border: '1.5px solid var(--state-rejected)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--state-rejected)', fontSize: 18, fontWeight: 700,
          }}>!</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>取消本场拍卖</div>
            <div style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', marginTop: 2 }}>
              此操作不可撤销 · 终态 CANCELLED · 上链记录
            </div>
          </div>
          <div style={{ flex: 1 }}/>
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: 14, border: 'none',
            background: 'transparent', color: 'var(--douyin-ink-muted)',
            cursor: 'pointer', fontSize: 18,
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{
            padding: '12px 14px', borderRadius: 8,
            background: 'rgba(255,176,32,.08)', border: '1px solid rgba(255,176,32,.3)',
            fontSize: 12, lineHeight: 1.55, color: 'var(--douyin-ink-text)',
          }}>
            <div style={{ fontWeight: 600, color: 'var(--state-extended)', marginBottom: 6 }}>
              将立即发生：
            </div>
            <ul style={{ margin: 0, padding: '0 0 0 18px', color: 'var(--douyin-ink-muted)' }}>
              <li>所有在线买家收到 <code className="mono" style={{ color: '#fff' }}>AUCTION_CANCELLED</code> 推送</li>
              <li>当前 <strong>{eventsCount}</strong> 条事件记录冻结，禁止后续 BID</li>
              <li>状态机迁移 <code className="mono" style={{ color: '#fff' }}>LIVE → CANCELLED</code>，不可恢复</li>
              <li>事件以 <code className="mono" style={{ color: 'var(--solemn-gold)' }}>seq #{lastSeq ?? '—'}</code> 写入证据哈希链</li>
            </ul>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', marginBottom: 6 }}>
              当前拍品 · {auctionId ? `AID ${auctionId.slice(0, 16)}` : '拍品信息待拉取'}
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', padding: '10px 12px',
              borderRadius: 8, background: 'rgba(255,255,255,.03)',
            }}>
              <div style={{ fontSize: 12, color: 'var(--douyin-ink-text)' }}>百达翡丽 5711/1A · 蓝面</div>
              <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--douyin-red)' }}>
                {formatCentsCNY(currentCents)}
              </div>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', fontWeight: 500 }}>
              请输入当前价以确认 (不含 ¥ 与 ,):
              <span className="mono" style={{ marginLeft: 8, color: 'var(--douyin-red)', fontWeight: 600 }}>
                {requiredText}
              </span>
            </label>
            <input
              className="mono"
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`例如 ${requiredText}`}
              style={{
                ...inp, marginTop: 6, fontFamily: 'var(--font-mono)',
                borderColor: match ? 'var(--douyin-cyan)' : typed ? 'var(--state-rejected)' : 'rgba(255,255,255,.12)',
              }}
            />
            <div style={{ fontSize: 10, color: 'var(--douyin-ink-dim)', marginTop: 4 }}>
              {match ? '✓ 已确认，可执行取消' : typed ? '× 金额不匹配' : '·'}
            </div>
          </div>
        </div>

        {/* Error surface — wire-time only (HTTP fail / ERR_ALREADY_TERMINAL / ERR_NOT_ALLOWED) */}
        {error && (
          <div style={{
            margin: '0 22px',
            padding: '8px 12px',
            background: 'rgba(254,44,85,.12)',
            border: '1px solid rgba(254,44,85,.4)',
            borderRadius: 6,
            fontSize: 11,
            color: 'var(--state-rejected)',
          }}>
            取消失败 · {error}
          </div>
        )}
        {/* Footer */}
        <div style={{
          padding: '14px 22px', borderTop: '1px solid rgba(255,255,255,.06)',
          display: 'flex', justifyContent: 'flex-end', gap: 10,
          background: 'rgba(0,0,0,.3)',
        }}>
          <button onClick={onClose} disabled={busy} style={btnGhost2}>暂不取消</button>
          <button disabled={!match || busy} onClick={onCancelAuction} style={{
            ...btnPrimary2, padding: '10px 18px',
            background: (match && !busy) ? 'var(--state-rejected)' : 'rgba(107,114,128,.3)',
            color: (match && !busy) ? '#fff' : 'var(--douyin-ink-muted)',
            cursor: (match && !busy) ? 'pointer' : 'not-allowed',
          }}>
            {busy ? '正在提交 …' : '确认取消 · CANCELLED'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Admin · Orders / Products — real data from GET /api/auctions
// ───────────────────────────────────────────────────────────────
function auctionToRow(a) {
  const sold = a.status === 'SOLD' || a.status === 'ORDER_CREATED';
  return {
    lot: a.auctionId,
    title: a.productName || a.auctionId,
    status: a.status,
    winner: a.winnerId || '—',
    hammer: sold ? (a.currentPriceCents || '0') : '0',
    settle: a.status === 'ORDER_CREATED' ? '已结算' : a.status === 'SOLD' ? '待结算' : '—',
    t: a.createdAtMs ? new Date(a.createdAtMs).toLocaleString('zh-CN', { hour12: false }) : '—',
    mode: a.mode || 'ENGLISH',
    parentAuctionId: a.parentAuctionId || '',
  };
}

const USE_MOCK_DATA = String(import.meta.env.VITE_USE_MOCK_DATA ?? 'false') === 'true';

const normalizeCents = (raw) => {
  const s = String(raw == null ? '0' : raw).trim();
  const sanitized = s.replace(/[^\d-]/g, '');
  if (!sanitized) return '0';
  try {
    return BigInt(sanitized).toString();
  } catch {
    return '0';
  }
};
const normalizeTimeText = (raw) => {
  if (!raw) return '—';
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw);
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return String(raw);
  }
};
const normalizeStatus = (raw) => {
  if (typeof raw !== 'string') return 'UNKNOWN';
  return raw.toUpperCase();
};
const normalizeSettlement = (status) => {
  if (status === 'ORDER_CREATED') return '已结算';
  if (status === 'SOLD') return '待结算';
  return '—';
};
const mapBackendRows = (rows = []) => rows.map((it, i) => {
  const status = normalizeStatus(it?.status);
  const lot = String(it?.lot ?? it?.auctionId ?? it?.id ?? `auc-${i + 1}`).trim() || `auc-${i + 1}`;
  return {
    lot,
    title: String(it?.title ?? it?.productName ?? it?.name ?? '—'),
    status,
    winner: String(it?.winner ?? it?.winnerId ?? it?.winnerName ?? '—'),
    hammer: normalizeCents(it?.hammer ?? it?.currentPriceCents ?? it?.currentPrice ?? '0'),
    settle: normalizeSettlement(status),
    t: normalizeTimeText(it?.t ?? it?.updatedAt ?? it?.createdAt),
    mode: String(it?.mode ?? 'ENGLISH'),
    parentAuctionId: String(it?.parentAuctionId ?? ''),
  };
});

function AdminOrders() {
  const navigate = useNavigate();
  const [filter, setFilter] = React.useState('ALL');
  const [copyHint, setCopyHint] = React.useState(null);
  const [rows, setRows] = React.useState(ORDER_ROWS);
  const [isDemoData, setIsDemoData] = React.useState(true);
  const [rowsError, setRowsError] = React.useState(null);
  const [loadingRows, setLoadingRows] = React.useState(false);
  const copyHintTimerRef = React.useRef(null);

  const clearCopyHintTimer = () => {
    if (copyHintTimerRef.current != null) {
      window.clearTimeout(copyHintTimerRef.current);
      copyHintTimerRef.current = null;
    }
  };

  React.useEffect(() => () => {
    clearCopyHintTimer();
  }, []);

  const setCopyHintWithAutoClear = (lot) => {
    clearCopyHintTimer();
    setCopyHint(lot);
    copyHintTimerRef.current = window.setTimeout(() => {
      setCopyHint((current) => (current === lot ? null : current));
      copyHintTimerRef.current = null;
    }, 900);
  };

  React.useEffect(() => {
    if (USE_MOCK_DATA) {
      setRows(ORDER_ROWS);
      setIsDemoData(true);
      setRowsError('环境变量 VITE_USE_MOCK_DATA=true，当前使用演示列表');
      return;
    }

    let alive = true;
    (async () => {
      try {
        setLoadingRows(true);
        setRowsError(null);
        await ensureSession('seller-demo');
        const data = await api.listAuctions();
        const rawRows = Array.isArray(data?.auctions)
          ? data.auctions
          : Array.isArray(data)
            ? data
            : [];
        if (!alive) return;

        if (!rawRows.length) {
          setRows(ORDER_ROWS);
          setIsDemoData(true);
          setRowsError('后端暂未返回拍场列表数据，回退演示数据');
          return;
        }

        const mapped = mapBackendRows(rawRows);
        setRows(mapped);
        setIsDemoData(false);
      } catch (e) {
        if (!alive) return;
        setRows(ORDER_ROWS);
        setIsDemoData(true);
        setRowsError(e instanceof ApiError
          ? `${e.status} ${e.code || e.message}`
          : (e?.message || String(e)));
      } finally {
        if (alive) setLoadingRows(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const counts = {
    ALL: rows.length,
    LIVE: rows.filter(r => r.status === 'LIVE').length,
    SCHEDULED: rows.filter(r => r.status === 'SCHEDULED').length,
    SOLD: rows.filter(r => r.status === 'SOLD' || r.status === 'ORDER_CREATED').length,
    NO_BID: rows.filter(r => r.status === 'NO_BID').length,
    CANCELLED: rows.filter(r => r.status === 'CANCELLED').length,
  };
  const filteredRows = filter === 'ALL'
    ? rows
    : filter === 'SOLD'
      ? rows.filter(r => r.status === 'SOLD' || r.status === 'ORDER_CREATED')
      : rows.filter(r => r.status === filter);

  const totalGmv = filteredRows.reduce((a, r) => a + BigInt(r.hammer || '0'), 0n).toString();
  const sales = filteredRows.filter(r => BigInt(r.hammer || '0') > 0n).length;

  const saveTextFile = (payload, filename) => {
    const blob = new Blob([payload], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const handleExportCsv = () => {
    const headers = ['LOT', 'Title', 'Status', 'Winner', 'HammerCents', 'Settle', 'Time'];
    const csvRow = (vals) => vals.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
    const lines = [
      headers.map((h) => `"${h}"`).join(','),
      ...filteredRows.map((r) => csvRow([
        r.lot,
        r.title,
        r.status,
        r.winner,
        r.hammer || '0',
        r.settle,
        r.t,
      ])),
    ].join('\n');
    const file = `auctions-${filter}-${new Date().toISOString().slice(0, 10)}.csv`;
    saveTextFile(lines, file);
  };
  const handleCopyRow = (r) => {
    const payload = `lot=${r.lot}\ntitle=${r.title}\nstatus=${r.status}\nwinner=${r.winner}\nhammer=${r.hammer || '0'}\nsettle=${r.settle}\nlast=${r.t}\n`;
    const done = () => {
      setCopyHintWithAutoClear(r.lot);
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(payload).then(done).catch(() => {});
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = payload;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      if (document.execCommand('copy')) done();
    } finally {
      document.body.removeChild(ta);
    }
  };
  const handleEditRules = async (aid) => {
    const sp = window.prompt('修改起拍价(分 cents) — 仅 DRAFT/SCHEDULED 可改:');
    if (sp == null || !sp.trim()) return;
    const inc = window.prompt('修改加价幅度(分 cents):');
    if (inc == null || !inc.trim()) return;
    try {
      await api.updateRules(aid, { startPriceCents: sp.trim(), incrementCents: inc.trim() });
      const data = await api.listAuctions();
      const rawRows = Array.isArray(data?.auctions)
        ? data.auctions
        : Array.isArray(data)
          ? data
          : [];
      setRows(rawRows.length ? mapBackendRows(rawRows) : ORDER_ROWS);
      setIsDemoData(!rawRows.length);
    } catch (e) {
      window.alert('更新失败: ' + (e?.message || e));
    }
  };
  const handleSpawnFormal = async (aid) => {
    try {
      await ensureSession('seller-demo');
      const rec = await api.prequalifyRecommendation(aid);
      const reserve = normalizeCents(rec?.recommendedReserveCents || rec?.recommendedStartPriceCents || '0');
      const count = rec?.sealedSummary?.count ?? 0;
      const ok = window.confirm(`暗拍 ${count} 人，推荐正式明拍 reserve ${formatCentsCNY(reserve)}。是否创建正式明拍？`);
      if (!ok) return;
      const spawned = await api.spawnFormal(aid, {
        rules: {
          mode: 'ENGLISH',
          startPriceCents: reserve,
          incrementCents: '1000',
          capPriceCents: '0',
          durationSec: 60,
          extendWindowSec: 10,
          extendSec: 10,
          maxExtensions: 2,
        },
      });
      if (spawned?.auctionId) {
        navigate(`/admin/auctions/${spawned.auctionId}/vlm`);
      }
    } catch (e) {
      window.alert('生成正式明拍失败: ' + (e?.message || e));
    }
  };

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      background: '#0e1018', color: 'var(--douyin-ink-text)', fontFamily: 'var(--font-sans)',
    }}>
      {/* breadcrumb */}
      <div style={{
        flexShrink: 0, padding: '14px 28px', display: 'flex', alignItems: 'center', gap: 14,
        borderBottom: '1px solid rgba(255,255,255,.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--douyin-ink-muted)' }}>拍品 & 订单</span>
        </div>
        <div style={{ flex: 1 }}/>
        <button onClick={handleExportCsv} style={btnGhost2}>导出 CSV</button>
        <button
          onClick={() => navigate('/admin/auctions/new')}
          style={{ ...btnPrimary2, background: 'var(--douyin-red)', color: '#fff', cursor: 'pointer' }}>
          + 新建拍品
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ flexShrink: 0, padding: '20px 28px 12px', display: 'flex', gap: 16 }}>
        <SumCard label="GMV (筛选范围)" value={
          <span className="mono" style={{ fontSize: 26, fontWeight: 700, color: 'var(--solemn-gold)' }}>
            {formatCentsCNY(totalGmv)}
          </span>}/>
        <SumCard label="成交场次" value={
          <span className="mono" style={{ fontSize: 26, fontWeight: 700 }}>
            {sales} <span style={{ fontSize: 13, color: 'var(--douyin-ink-muted)', fontWeight: 400 }}>/ {filteredRows.length}</span>
          </span>}/>
        <SumCard label="正在 LIVE" value={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusBadge status="LIVE" size="md"/>
            <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{counts.LIVE}</span>
          </div>}/>
        <SumCard label="排期中" value={
          <span className="mono" style={{ fontSize: 26, fontWeight: 700, color: 'var(--douyin-cyan)' }}>
            {counts.SCHEDULED}
          </span>}/>
      </div>

      {/* Filter chips */}
      <div style={{ flexShrink: 0, padding: '8px 28px 14px', display: 'flex', gap: 8 }}>
        {rowsError ? (
          <span style={{
            marginBottom: 6,
            fontSize: 11,
            color: isDemoData ? 'var(--state-extended)' : 'var(--douyin-cyan)',
            padding: '6px 10px',
            borderRadius: 6,
            background: isDemoData ? 'rgba(255,176,32,.08)' : 'rgba(37,244,238,.08)',
            border: `1px solid ${isDemoData ? 'rgba(255,176,32,.24)' : 'rgba(37,244,238,.22)'}`,
            alignSelf: 'center',
            whiteSpace: 'nowrap',
          }}>
            {loadingRows ? '拍场列表加载中…' : rowsError}
          </span>
        ) : loadingRows ? (
          <span style={{
            marginBottom: 6,
            fontSize: 11,
            color: 'var(--douyin-ink-muted)',
            padding: '6px 10px',
            borderRadius: 6,
            background: 'rgba(255,255,255,.03)',
            border: '1px solid rgba(255,255,255,.09)',
            alignSelf: 'center',
            whiteSpace: 'nowrap',
          }}>拍场列表加载中…</span>
        ) : null}
        {['ALL', 'LIVE', 'SCHEDULED', 'SOLD', 'NO_BID', 'CANCELLED'].map(s => (
          <button key={s} onClick={() => setFilter(s)} style={{
            padding: '6px 12px', borderRadius: 999,
            background: filter === s ? 'var(--douyin-ink-card)' : 'rgba(255,255,255,.02)',
            color: filter === s ? 'var(--douyin-ink-text)' : 'var(--douyin-ink-muted)',
            fontSize: 12, fontWeight: filter === s ? 600 : 500,
            border: '1px solid ' + (filter === s ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.06)'),
            cursor: 'pointer', fontFamily: 'inherit',
          }}>
            {s} <span className="mono" style={{ opacity: .6, marginLeft: 4 }}>{counts[s] ?? rows.filter(r => r.status === s).length}</span>
          </button>
        ))}
      </div>

      {copyHint && (
        <div style={{
          margin: '0 28px 12px', padding: '8px 10px', borderRadius: 6,
          fontSize: 11, color: 'var(--douyin-cyan)',
          background: 'rgba(37,244,238,.08)',
          border: '1px solid rgba(37,244,238,.26)',
          width: 'fit-content',
        }}>
          已复制 LOT {copyHint}
        </div>
      )}

      {/* Table */}
      <div style={{ flex: 1, padding: '0 28px 24px', overflow: 'auto', minHeight: 0 }} className="no-scrollbar">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{
              fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em',
              borderBottom: '1px solid rgba(255,255,255,.06)',
            }}>
              <Th>LOT</Th>
              <Th style={{ textAlign: 'left' }}>拍品</Th>
              <Th>状态</Th>
              <Th>中标人</Th>
              <Th style={{ textAlign: 'right' }}>落槌价</Th>
              <Th>结算</Th>
              <Th>时间</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(r => (
              <tr key={r.lot} style={{
                fontSize: 12, borderBottom: '1px solid rgba(255,255,255,.04)',
                transition: 'background .15s',
              }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,.02)'}
                 onMouseLeave={e => e.currentTarget.style.background = ''}>
                <Td><span className="mono" style={{ color: 'var(--douyin-ink-muted)' }}>{r.lot}</span></Td>
                <Td style={{ textAlign: 'left' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: 4,
                      background: 'linear-gradient(135deg,#2a1f2e,#0a0e1a)',
                      flexShrink: 0,
                    }}/>
                    <span>{r.title}</span>
                  </div>
                </Td>
                <Td><StatusBadge status={r.status} size="sm"/></Td>
                <Td style={{ color: r.winner === '—' ? 'var(--douyin-ink-dim)' : 'var(--douyin-ink-text)' }}>
                  {r.winner}
                </Td>
                <Td style={{ textAlign: 'right' }}>
                  {BigInt(r.hammer || '0') > 0n ?
                    <span className="mono" style={{ fontWeight: 600, color: 'var(--solemn-gold)' }}>
                      {formatCentsCNY(r.hammer)}
                    </span>
                    : <span style={{ color: 'var(--douyin-ink-dim)' }}>—</span>}
                </Td>
                <Td>
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 4,
                    background: r.settle === '已结算' ? 'rgba(37,244,238,.15)'
                              : r.settle === '待结算' ? 'rgba(255,176,32,.15)'
                              : 'transparent',
                    color: r.settle === '已结算' ? 'var(--douyin-cyan)'
                         : r.settle === '待结算' ? 'var(--state-extended)'
                         : 'var(--douyin-ink-dim)',
                    fontWeight: 600,
                  }}>{r.settle}</span>
                </Td>
                <Td><span className="mono" style={{ color: 'var(--douyin-ink-muted)', fontSize: 11 }}>{r.t}</span></Td>
                <Td>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                    {(r.status === 'DRAFT' || r.status === 'SCHEDULED') ? (
                      <button onClick={() => handleEditRules(r.lot)} style={{
                        border: '1px solid rgba(255,255,255,.14)', background: 'transparent',
                        color: 'var(--douyin-ink-text)', cursor: 'pointer', fontSize: 11,
                        padding: '3px 10px', borderRadius: 6,
                      }}>编辑规则</button>
                    ) : ((r.status === 'SOLD' || r.status === 'ORDER_CREATED') && ['SEALED_FIRST', 'VICKREY'].includes(r.mode)) ? (
                      <button onClick={() => handleSpawnFormal(r.lot)} style={{
                        border: '1px solid rgba(37,244,238,.32)', background: 'rgba(37,244,238,.08)',
                        color: 'var(--douyin-cyan)', cursor: 'pointer', fontSize: 11,
                        padding: '3px 10px', borderRadius: 6,
                      }}>生成正式明拍</button>
                    ) : (
                      <button onClick={() => navigate(
                        (r.status === 'LIVE') ? `/room/${r.lot}` : `/evidence/${r.lot}`)} style={{
                        border: 'none', background: 'transparent', color: 'var(--douyin-ink-muted)',
                        cursor: 'pointer', fontSize: 14, padding: '4px 8px',
                      }}>›</button>
                    )}
                    <button onClick={() => handleCopyRow(r)} aria-label={`复制 LOT ${r.lot} 明细`} style={{
                      border: 'none', background: 'transparent', color: 'var(--douyin-ink-muted)',
                      cursor: 'pointer', fontSize: 14, padding: '4px 8px',
                    }} title="复制该行明细">⋯</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SumCard({ label, value }) {
  return (
    <div style={{
      flex: 1, padding: '14px 16px', borderRadius: 10,
      background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <span style={{ fontSize: 10, color: 'var(--douyin-ink-muted)', letterSpacing: '.06em' }}>
        {label}
      </span>
      <div>{value}</div>
    </div>
  );
}
function Th({ children, style }) {
  return <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 500, ...style }}>{children}</th>;
}
function Td({ children, style }) {
  return <td style={{ padding: '12px 12px', textAlign: 'center', ...style }}>{children}</td>;
}

export {
  AdminPublish,
  AdminCancelModal,
  AdminOrders,
};
