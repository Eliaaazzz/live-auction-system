import { useCallback, useEffect, useState } from 'react';
import { Table, Tag, Button, Input, Space, Tabs, Dropdown, Checkbox, Tooltip, Popconfirm, Modal, Typography, Upload, App as AntdApp } from 'antd';
import { ReloadOutlined, SearchOutlined, FilterOutlined, PlusOutlined, SoundOutlined, EllipsisOutlined, AppstoreOutlined, AppstoreAddOutlined, LinkOutlined, VideoCameraOutlined, UploadOutlined, CheckCircleFilled } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';
import EmptyLive from '../EmptyLive';

interface Prod { key: string; name: string; id: string; image: string; tags: string[]; start: number; step: number; cap: number; current: number; bids: number; status: 'live' | 'done' | 'waiting'; endTs?: number; }

const yuan = (c?: string | number | null): number => {
  if (c == null || c === '') return 0;
  try { return Math.round(Number(BigInt(String(c))) / 100); } catch { return Math.round(Number(c) / 100) || 0; }
};
// Drop load-test / placeholder lots so the live-products list shows only real lots.
function isJunk(name?: string): boolean {
  const n = (name || '').trim();
  if (n === '') return true;
  const lower = n.toLowerCase();
  if (/load\s*test/.test(lower)) return true;
  if (lower.startsWith('final') && lower.endsWith('lot')) return true;
  return false;
}
function mapStatus(s?: string): Prod['status'] {
  if (s === 'LIVE') return 'live';
  if (s === 'SOLD' || s === 'NO_BID' || s === 'CANCELLED' || s === 'ORDER_CREATED') return 'done';
  return 'waiting';
}
function toProd(a: any): Prod {
  return {
    key: a.auctionId,
    name: a.productName || 'Live lot',
    id: a.auctionId,
    image: a.imageUrl || PROD.watch,
    tags: a.mode && a.mode !== 'ENGLISH' ? [a.mode] : [],
    start: yuan(a.startPriceCents),
    step: yuan(a.incrementCents),
    cap: yuan(a.capPriceCents),
    current: yuan(a.currentPriceCents),
    bids: Number(a.bidCount) || 0,
    status: mapStatus(a.status),
    endTs: a.endAtMs || undefined,
  };
}

function LiveCountdown({ endTs }: { endTs: number }) {
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const ms = Math.max(0, endTs - Date.now());
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const ending = ms < 60_000;
  return <span style={{ color: ending ? '#fe2c55' : '#fa8c16', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{hh}:{mm}:{ss}</span>;
}

export default function ProductManage({ onGo }: { onGo?: (p: string) => void } = {}) {
  const { message } = AntdApp.useApp();
  const [tab, setTab] = useState('live');
  const [explaining, setExplaining] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Prod[]>([]);
  const [loading, setLoading] = useState(true);
  const [streamInfo, setStreamInfo] = useState<{ id: string; name: string; push: string; play: string; videoUrl?: string } | null>(null);
  const [liveStarted, setLiveStarted] = useState<Set<string>>(new Set());
  const [uploadingVideo, setUploadingVideo] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // limit 500 matches the dashboard and live monitor, so all three views see the same list (#261-4b one-to-one).
      const { auctions = [] } = await api.listAuctions({ limit: 500 } as any);
      setProducts(auctions.filter((a: any) => !isJunk(a.productName)).map(toProd));
    } catch {
      // An empty/failed list is NOT an error toast — just leave the friendly empty state.
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);
  useEffect(() => { load(); const t = setInterval(() => load(true), 10_000); return () => clearInterval(t); }, [load]);

  const cancelAuction = async (id: string, name: string) => {
    try {
      await ensureSession('seller-demo');
      await api.cancel(id, {});
      message.warning(`Cancelled "${name.slice(0, 6)}..." - deposits released immediately`);
      load();
    } catch (e: any) {
      message.error('Cancel failed: ' + (e?.message || e));
    }
  };

  // Start streaming: fetch this lot's stream key and show the push/play URLs (the host goes live by pushing from OBS or Douyin Live Companion).
  const startLive = async (r: Prod) => {
    try {
      await ensureSession('seller-demo');
      const s: any = await api.getStream(r.id);
      const key = s?.streamKey || '';
      // Prefer the backend-issued push/play URLs (authoritative — built from the
      // configured LivePushURLBase); only fall back to a local guess if absent.
      const push = s?.pushUrl || `rtmp://${location.hostname}:1935/live/${key}`;
      const play = s?.livePlayUrl || `${location.origin}/live/${key}.m3u8`;
      // A previously-uploaded clip lives on as the auction's livePlayUrl (an
      // /uploads/… path, not the .m3u8 push stream) — reflect it so re-opening
      // Start streaming shows "live video is set" instead of a blank upload prompt.
      const videoUrl = typeof s?.livePlayUrl === 'string' && s.livePlayUrl.includes('/uploads/') ? s.livePlayUrl : undefined;
      setStreamInfo({ id: r.id, name: r.name, push, play, videoUrl });
      setLiveStarted((prev) => new Set(prev).add(r.id));
    } catch (e: any) {
      message.error('Failed to start streaming: ' + (e?.message || e));
    }
  };

  // Auto-stream from a prepared video: point this session's livePlayUrl at the uploaded mp4/webm and the
  // viewer's room loops it automatically (no OBS push needed). Returning false blocks antd's default upload.
  const onPickVideo = (file: File): boolean => {
    const info = streamInfo;
    if (!info) return false;
    if (!/^video\/(mp4|webm)$/.test(file.type)) { message.error('Only mp4 / webm are supported'); return false; }
    if (file.size > 64 * 1024 * 1024) { message.error('The video must be 64MB or smaller - please compress it first'); return false; }
    setUploadingVideo(true);
    (async () => {
      try {
        await ensureSession('seller-demo');
        const res: any = await api.uploadStreamVideo(info.id, file);
        const url = res?.livePlayUrl || '';
        setStreamInfo((cur) => (cur && cur.id === info.id ? { ...cur, videoUrl: url } : cur));
        message.success('Live video set - it loops automatically when viewers enter the room');
      } catch (e: any) {
        message.error('Upload failed: ' + (e?.message || e));
      } finally {
        setUploadingVideo(false);
      }
    })();
    return false;
  };

  // The admin "live products" list only shows what is actually LIVE, so finished and cancelled items no longer pile up.
  const rows = products
    .filter((p) => (tab === 'live' ? p.status === 'live' : p.status === 'waiting'))
    .filter((p) => (search ? p.name.includes(search) || p.id.includes(search) : true));

  const columns: ColumnsType<Prod> = [
    {
      title: 'Product', dataIndex: 'name', width: 360,
      render: (_, r) => (
        <div className="prod-cell">
          <img className="prod-thumb" src={r.image} alt="" loading="lazy" />
          <div className="prod-meta">
            <Tooltip title={r.name}><div className="name">{r.name}</div></Tooltip>
            <div className="id">ID: {r.id}</div>
            <Space size={4} wrap>
              {r.status === 'live' && <Tag color="red">Bidding</Tag>}
              {r.status === 'done' && <Tag color="default">Ended</Tag>}
              {r.status === 'waiting' && <Tag color="gold">Upcoming</Tag>}
              {r.tags.map((t) => (<Tag key={t} bordered={false} style={{ background: '#f5f5f5', color: '#666' }}>{t}</Tag>))}
            </Space>
          </div>
        </div>
      ),
    },
    { title: 'Start price', dataIndex: 'start', align: 'right', width: 110, render: (v: number) => <span className="num-strong">{v === 0 ? 'From zero' : '¥' + fmtMoney(v)}</span> },
    { title: 'Increment', dataIndex: 'step', align: 'right', width: 96, render: (v: number) => <span className="num-strong">¥{fmtMoney(v)}</span> },
    { title: 'Cap price', dataIndex: 'cap', align: 'right', width: 110, render: (v: number) => <span className="num-strong">{v === 0 ? 'No cap' : '¥' + fmtMoney(v)}</span> },
    { title: 'Current bid', dataIndex: 'current', align: 'right', width: 120, render: (v: number, r) => (r.status === 'waiting' ? <span style={{ color: '#bbb' }}>—</span> : <span className="num-red">¥{fmtMoney(v)}</span>) },
    { title: 'Bids', dataIndex: 'bids', align: 'right', width: 96, render: (v: number) => (<a className="count-bar">{v} <LinkOutlined style={{ fontSize: 11 }} /></a>) },
    {
      title: 'Status', key: 'status', width: 160,
      render: (_, r) => {
        if (r.status === 'live') return (
          <Space direction="vertical" size={2}>
            <Tag color="red" style={{ marginInlineEnd: 0, fontWeight: 700 }}>Bidding</Tag>
            {r.endTs && (
              <span style={{ fontSize: 15, fontWeight: 700, color: '#fe2c55', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Bidding <LiveCountdown endTs={r.endTs} />
              </span>
            )}
          </Space>
        );
        if (r.status === 'done') return <Tag color="green">Ended</Tag>;
        return <Tag color="gold">Upcoming</Tag>;
      },
    },
    {
      title: 'Actions', key: 'op', fixed: 'right', width: 460,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.status === 'live' && (
            <Button size="small" type="primary" icon={<VideoCameraOutlined />} onClick={() => startLive(r)}
              style={liveStarted.has(r.id) ? { background: '#52c41a', borderColor: '#52c41a' } : undefined}>
              {liveStarted.has(r.id) ? 'Stream settings' : 'Start streaming'}
            </Button>
          )}
          <Button size="small" type={explaining === r.key ? 'primary' : 'default'} icon={<SoundOutlined />} onClick={() => { setExplaining(explaining === r.key ? null : r.key); message.info(explaining === r.key ? 'Commentary stopped' : 'Commentary started'); }}>{explaining === r.key ? 'Stop commentary' : 'Commentary'}</Button>
          <Button size="small" onClick={() => message.info('Teleprompter opened (demo)')}>Teleprompter</Button>
          <Button size="small" onClick={() => message.info('Selling-point editor (demo)')}>Selling points</Button>
          <Popconfirm title="Withdraw this lot?" okText="Withdraw" cancelText="Cancel" okButtonProps={{ danger: true }} onConfirm={() => cancelAuction(r.id, r.name)}>
            <Button size="small" danger>Withdraw</Button>
          </Popconfirm>
          <Dropdown menu={{ items: [{ key: 'cancel', label: <span style={{ color: '#fe2c55' }}>Cancel a faulty auction</span>, danger: true }], onClick: ({ key }) => { if (key === 'cancel') cancelAuction(r.id, r.name); } }}>
            <Button size="small" icon={<EllipsisOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <div className="admin-content">
      <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'live', label: `Live products (${products.filter((p) => p.status === 'live').length})` }, { key: 'waiting', label: `Upcoming products (${products.filter((p) => p.status === 'waiting').length})` }]} />
      <div className="admin-toolbar">
        <Checkbox>Select all</Checkbox>
        <Input allowClear prefix={<SearchOutlined style={{ color: '#bbb' }} />} placeholder="Search by product name or ID" style={{ width: 240 }} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button icon={<FilterOutlined />}>Filter</Button>
        <span style={{ marginLeft: 8, color: '#fe2c55', fontWeight: 600, fontSize: 13 }}>● Live</span>
        <div className="spacer" />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load()}>Refresh</Button>
        <Button icon={<AppstoreOutlined />}>View groups</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => (onGo ? onGo('publish') : message.info('Go to Publish auction to add a product'))}>Add product</Button>
      </div>
      <Table<Prod> columns={columns} dataSource={rows} loading={loading} rowKey="key" rowSelection={{ type: 'checkbox' }} locale={{ emptyText: <EmptyLive onGo={() => onGo?.('publish')} icon={<AppstoreAddOutlined />} title="List your first product" hint="Publish the first lot and the room goes live immediately" cta="Go to Publish auction" /> }} pagination={{ pageSize: 6, showTotal: (t) => `${t} lot(s) in total` }} scroll={{ x: 1480 }} size="middle" />

      <Modal
        open={!!streamInfo}
        title={<span><VideoCameraOutlined style={{ color: '#fe2c55' }} /> Start streaming - {streamInfo?.name}</span>}
        onCancel={() => setStreamInfo(null)}
        footer={[<Button key="ok" type="primary" onClick={() => setStreamInfo(null)}>Got it</Button>]}
        width={620}
      >
        <p style={{ color: '#52c41a', fontWeight: 600, marginTop: 0 }}>● The stream channel is ready - upload a video or push from OBS and viewers can watch live on mobile</p>

        {/* Recommended path: upload a prepared video and it loops automatically for viewers, no OBS needed. */}
        <div style={{ marginBottom: 18, padding: '14px 16px', background: '#fff7f8', border: '1px solid #ffd6dd', borderRadius: 10 }}>
          <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <VideoCameraOutlined style={{ color: '#fe2c55' }} /> Stream a prepared video <Tag color="red" bordered={false} style={{ marginInlineStart: 2 }}>Recommended - no OBS</Tag>
          </div>
          {streamInfo?.videoUrl ? (
            <>
              <div style={{ color: '#52c41a', fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircleFilled /> Live video is set - it loops automatically when viewers enter the room
              </div>
              <Upload accept="video/mp4,video/webm" showUploadList={false} beforeUpload={onPickVideo} disabled={uploadingVideo}>
                <Button size="small" icon={<UploadOutlined />} loading={uploadingVideo}>Replace video</Button>
              </Upload>
            </>
          ) : (
            <>
              <div style={{ color: '#666', fontSize: 13, marginBottom: 10 }}>Upload an mp4 / webm (64MB max) and the viewer's room loops it automatically - no need to open OBS.</div>
              <Upload accept="video/mp4,video/webm" showUploadList={false} beforeUpload={onPickVideo} disabled={uploadingVideo}>
                <Button type="primary" icon={<UploadOutlined />} loading={uploadingVideo}>Choose a video to upload</Button>
              </Upload>
            </>
          )}
        </div>

        {/* Alternative path: push a real camera with OBS or Live Companion (the original capability is kept). */}
        <details>
          <summary style={{ cursor: 'pointer', color: '#666', fontWeight: 600, marginBottom: 10 }}>Or: push a real camera with OBS / Douyin Live Companion</summary>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Push URL (OBS / Douyin Live Companion)</div>
            <Typography.Paragraph copyable={{ text: streamInfo?.push }} style={{ background: '#f6f6f6', padding: '8px 10px', borderRadius: 6, marginBottom: 0, wordBreak: 'break-all' }}>{streamInfo?.push}</Typography.Paragraph>
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Play URL (viewer-side HLS)</div>
            <Typography.Paragraph copyable={{ text: streamInfo?.play }} style={{ background: '#f6f6f6', padding: '8px 10px', borderRadius: 6, marginBottom: 0, wordBreak: 'break-all' }}>{streamInfo?.play}</Typography.Paragraph>
          </div>
          <ol style={{ color: '#666', fontSize: 13, paddingLeft: 18, marginBottom: 0 }}>
            <li>Open OBS / Douyin Live Companion, go to Settings, Stream, and paste the push URL above into Server;</li>
            <li>Click Start Streaming to send your real camera feed (the product from every angle) to the room;</li>
            <li>Viewers watch the live pull stream on mobile while bidding runs in parallel.</li>
          </ol>
        </details>
      </Modal>
    </div>
  );
}
