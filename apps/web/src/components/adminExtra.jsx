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
  const [scheduleDate, setScheduleDate] = React.useState('2026-06-10');
  const [scheduleTime, setScheduleTime] = React.useState('21:00');
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
        imageUrl: '',                 // demo: no upload (T7 wires real VLM input)
        description: '',
      });
      const { auctionId } = await api.createDraft({
        productId,
        rules: {
          startCents,
          stepCents,
          reserveCents,
          capCents,
          durationMs: duration * 60 * 1000,
          maxExtensions: antiSnipe ? maxExtends : 0,
          antiSnipeWindowMs: antiSnipe ? 10_000 : 0,
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

          {/* ─ Section: media ─ */}
          <FormSection step="02" title="拍品视频" desc="上传后 AI Sidecar 将自动运行 VLM 抽取关键事实">
            <div style={{
              border: '1.5px dashed rgba(255,255,255,.18)', borderRadius: 12, padding: '20px 22px',
              display: 'flex', alignItems: 'center', gap: 14,
            }}>
              <div style={{
                width: 72, height: 96, borderRadius: 8,
                background: 'linear-gradient(160deg,#2a1f2e,#0a0e1a)',
                position: 'relative', flexShrink: 0,
              }}>
                <svg viewBox="0 0 100 100" style={{ position: 'absolute', inset: '15%' }}>
                  <circle cx="50" cy="50" r="30" fill="none" stroke="#C9A961" strokeWidth="2"/>
                  <circle cx="50" cy="50" r="24" fill="#0d0d14"/>
                </svg>
                <div style={{
                  position: 'absolute', top: 6, right: 6,
                  width: 18, height: 18, borderRadius: 9, background: 'var(--douyin-cyan)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, color: '#0a0a14',
                }}>✓</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>watch-5711a-walkthrough.mp4</div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--douyin-ink-muted)', marginTop: 2 }}>
                  05:18 · 1080p · 42.8 MB · 已上传
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <span style={chip('cyan')}>VLM 已采样 28 帧</span>
                  <span style={chip('warn')}>等待事实核对 · 0/5</span>
                </div>
              </div>
              <button style={btnGhost2}>替换</button>
            </div>
          </FormSection>

          {/* ─ Section: pricing ─ */}
          <FormSection step="03" title="起拍设置" desc="货币以分(cents)为单位 · 字符串存储 · 永不浮点">
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
  const [draft, setDraft] = React.useState(formatCentsCNY(cents).slice(1));
  React.useEffect(() => setDraft(formatCentsCNY(cents).slice(1)), [cents]);
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
          setDraft(e.target.value);
          if (!raw) return;
          const [y, f = '00'] = raw.split('.');
          const cents = (y.replace(/\D/g,'') + (f + '00').slice(0,2));
          onChange(cents.replace(/^0+(?=\d)/, ''));
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
function AdminCancelModal({ currentCents = '12880000', onClose, onCancelAuction, busy = false, error = null }) {
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
              <li>当前 126 条出价记录冻结，禁止后续 BID</li>
              <li>状态机迁移 <code className="mono" style={{ color: '#fff' }}>LIVE → CANCELLED</code>，不可恢复</li>
              <li>事件以 <code className="mono" style={{ color: 'var(--solemn-gold)' }}>seq #14999</code> 写入证据哈希链</li>
            </ul>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', marginBottom: 6 }}>
              当前拍品 · LOT 2024-0142
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
              placeholder="例如 12880000"
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
// Admin · Orders / Products
// ───────────────────────────────────────────────────────────────
const ORDER_ROWS = [
  { lot: '2024-0142', title: '百达翡丽 5711/1A · 蓝面',         status: 'ORDER_CREATED', winner: '海风_2024',   hammer: '12880000', settle: '已结算',   t: '2026-05-25 21:48' },
  { lot: '2024-0141', title: '劳力士 GMT-Master II 116710',     status: 'SOLD',           winner: '陆_LU',       hammer: '6850000',  settle: '待结算',   t: '2026-05-25 20:14' },
  { lot: '2024-0140', title: '清代翡翠手镯 · A货',                status: 'NO_BID',         winner: '—',           hammer: '0',        settle: '—',        t: '2026-05-24 22:30' },
  { lot: '2024-0139', title: '宋瓷青瓷莲花碗',                    status: 'CANCELLED',      winner: '—',           hammer: '0',        settle: '—',        t: '2026-05-24 21:02' },
  { lot: '2024-0138', title: 'Louis Vuitton Limited Edition 手袋', status: 'ORDER_CREATED',  winner: '盐渍生活',   hammer: '1850000',  settle: '已结算',   t: '2026-05-23 19:48' },
  { lot: '2024-0137', title: '萧勤 抽象画作 1988',                status: 'SOLD',           winner: '听雨人',      hammer: '4200000',  settle: '待结算',   t: '2026-05-22 21:12' },
  { lot: '2024-0136', title: '欧米茄 Speedmaster Moonwatch',     status: 'SCHEDULED',      winner: '—',           hammer: '0',        settle: '—',        t: '2026-05-26 21:00' },
  { lot: '2024-0135', title: '田黄石印章 · 清乾隆',                status: 'LIVE',           winner: '—',           hammer: '0',        settle: '—',        t: '直播中' },
  { lot: '2024-0134', title: '陶器 · 战国 灰陶罐',                 status: 'DRAFT',          winner: '—',           hammer: '0',        settle: '—',        t: '草稿' },
];

function AdminOrders() {
  const [filter, setFilter] = React.useState('ALL');
  const counts = {
    ALL: ORDER_ROWS.length,
    LIVE: ORDER_ROWS.filter(r => r.status === 'LIVE').length,
    SCHEDULED: ORDER_ROWS.filter(r => r.status === 'SCHEDULED').length,
    SOLD: ORDER_ROWS.filter(r => r.status === 'SOLD' || r.status === 'ORDER_CREATED').length,
    NO_BID: ORDER_ROWS.filter(r => r.status === 'NO_BID').length,
    CANCELLED: ORDER_ROWS.filter(r => r.status === 'CANCELLED').length,
  };
  const rows = filter === 'ALL' ? ORDER_ROWS
            : filter === 'SOLD'  ? ORDER_ROWS.filter(r => r.status === 'SOLD' || r.status === 'ORDER_CREATED')
            : ORDER_ROWS.filter(r => r.status === filter);

  const totalGmv = rows.reduce((a, r) => a + BigInt(r.hammer || '0'), 0n).toString();
  const sales = rows.filter(r => BigInt(r.hammer || '0') > 0n).length;

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
        <button style={btnGhost2}>导出 CSV</button>
        <button style={{ ...btnPrimary2, background: 'var(--douyin-red)', color: '#fff', cursor: 'pointer' }}>
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
            {sales} <span style={{ fontSize: 13, color: 'var(--douyin-ink-muted)', fontWeight: 400 }}>/ {rows.length}</span>
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
        {['ALL', 'LIVE', 'SCHEDULED', 'SOLD', 'NO_BID', 'CANCELLED'].map(s => (
          <button key={s} onClick={() => setFilter(s)} style={{
            padding: '6px 12px', borderRadius: 999,
            background: filter === s ? 'var(--douyin-ink-card)' : 'rgba(255,255,255,.02)',
            color: filter === s ? 'var(--douyin-ink-text)' : 'var(--douyin-ink-muted)',
            fontSize: 12, fontWeight: filter === s ? 600 : 500,
            border: '1px solid ' + (filter === s ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.06)'),
            cursor: 'pointer', fontFamily: 'inherit',
          }}>
            {s} <span className="mono" style={{ opacity: .6, marginLeft: 4 }}>{counts[s] ?? ORDER_ROWS.filter(r=>r.status===s).length}</span>
          </button>
        ))}
      </div>

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
            {rows.map(r => (
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
                <Td><button style={{
                  border: 'none', background: 'transparent', color: 'var(--douyin-ink-muted)',
                  cursor: 'pointer', fontSize: 14, padding: '4px 8px',
                }}>›</button></Td>
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
  ORDER_ROWS
};
