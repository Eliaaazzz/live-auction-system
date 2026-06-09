import { useCallback, useEffect, useState } from 'react';
import { Table, Tag, Button, Input, Space, Tabs, Dropdown, Checkbox, Tooltip, Popconfirm, Modal, Typography, Upload, App as AntdApp } from 'antd';
import { ReloadOutlined, SearchOutlined, FilterOutlined, PlusOutlined, SoundOutlined, EllipsisOutlined, AppstoreOutlined, LinkOutlined, VideoCameraOutlined, UploadOutlined, CheckCircleFilled } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { fmtMoney } from '../../lib/format';
import { PROD } from '../../lib/assets';
import { api } from '../../backend/lib/api.js';
import { ensureSession } from '../../backend/lib/auth.js';

interface Prod { key: string; name: string; id: string; image: string; tags: string[]; start: number; step: number; cap: number; current: number; bids: number; status: 'live' | 'done' | 'waiting'; endTs?: number; }

const yuan = (c?: string | number | null): number => {
  if (c == null || c === '') return 0;
  try { return Math.round(Number(BigInt(String(c))) / 100); } catch { return Math.round(Number(c) / 100) || 0; }
};
// Drop load-test / placeholder lots so the 直播商品 list shows only real lots.
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
    name: a.productName || '直播拍品',
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

export default function ProductManage() {
  const { message } = AntdApp.useApp();
  const [tab, setTab] = useState('live');
  const [explaining, setExplaining] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Prod[]>([]);
  const [loading, setLoading] = useState(true);
  const [streamInfo, setStreamInfo] = useState<{ id: string; name: string; push: string; play: string; videoUrl?: string } | null>(null);
  const [liveStarted, setLiveStarted] = useState<Set<string>>(new Set());
  const [uploadingVideo, setUploadingVideo] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { auctions = [] } = await api.listAuctions();
      setProducts(auctions.filter((a: any) => !isJunk(a.productName)).map(toProd));
    } catch (e: any) {
      message.error('加载商品失败：' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load]);

  const cancelAuction = async (id: string, name: string) => {
    try {
      await ensureSession('seller-demo');
      await api.cancel(id, {});
      message.warning(`已取消「${name.slice(0, 6)}…」，保证金即时解冻`);
      load();
    } catch (e: any) {
      message.error('取消失败：' + (e?.message || e));
    }
  };

  // 开始直播：取该拍品的推流密钥，弹出推流/播放地址（主播用 OBS/抖音直播伴侣 推流即开播）。
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
      // 开始直播 shows "已设置直播视频" instead of a blank upload prompt.
      const videoUrl = typeof s?.livePlayUrl === 'string' && s.livePlayUrl.includes('/uploads/') ? s.livePlayUrl : undefined;
      setStreamInfo({ id: r.id, name: r.name, push, play, videoUrl });
      setLiveStarted((prev) => new Set(prev).add(r.id));
    } catch (e: any) {
      message.error('开始直播失败：' + (e?.message || e));
    }
  };

  // 用准备好的视频自动直播：把这一场的 livePlayUrl 指向上传的 mp4/webm，观众端
  // 直播间会自动循环播放（无需 OBS 推流）。返回 false 阻止 antd 默认上传行为。
  const onPickVideo = (file: File): boolean => {
    const info = streamInfo;
    if (!info) return false;
    if (!/^video\/(mp4|webm)$/.test(file.type)) { message.error('仅支持 mp4 / webm 格式'); return false; }
    if (file.size > 64 * 1024 * 1024) { message.error('视频不能超过 64MB，请压缩后再上传'); return false; }
    setUploadingVideo(true);
    (async () => {
      try {
        await ensureSession('seller-demo');
        const res: any = await api.uploadStreamVideo(info.id, file);
        const url = res?.livePlayUrl || '';
        setStreamInfo((cur) => (cur && cur.id === info.id ? { ...cur, videoUrl: url } : cur));
        message.success('直播视频已设置，观众进直播间将自动循环播放');
      } catch (e: any) {
        message.error('上传失败：' + (e?.message || e));
      } finally {
        setUploadingVideo(false);
      }
    })();
    return false;
  };

  // 后台「直播商品」只显示在拍的（LIVE），历史已结束/已取消项不再堆积。
  const rows = products
    .filter((p) => (tab === 'live' ? p.status === 'live' : p.status === 'waiting'))
    .filter((p) => (search ? p.name.includes(search) || p.id.includes(search) : true));

  const columns: ColumnsType<Prod> = [
    {
      title: '商品', dataIndex: 'name', width: 360,
      render: (_, r) => (
        <div className="prod-cell">
          <img className="prod-thumb" src={r.image} alt="" loading="lazy" />
          <div className="prod-meta">
            <Tooltip title={r.name}><div className="name">{r.name}</div></Tooltip>
            <div className="id">ID: {r.id}</div>
            <Space size={4} wrap>
              {r.status === 'live' && <Tag color="red">竞拍中</Tag>}
              {r.status === 'done' && <Tag color="default">已结束</Tag>}
              {r.status === 'waiting' && <Tag color="gold">待开拍</Tag>}
              {r.tags.map((t) => (<Tag key={t} bordered={false} style={{ background: '#f5f5f5', color: '#666' }}>{t}</Tag>))}
            </Space>
          </div>
        </div>
      ),
    },
    { title: '起拍价', dataIndex: 'start', align: 'right', width: 100, render: (v: number) => <span className="num-strong">{v === 0 ? '0 元起' : '¥' + fmtMoney(v)}</span> },
    { title: '固定加价', dataIndex: 'step', align: 'right', width: 96, render: (v: number) => <span className="num-strong">¥{fmtMoney(v)}</span> },
    { title: '封顶价', dataIndex: 'cap', align: 'right', width: 110, render: (v: number) => <span className="num-strong">{v === 0 ? '不封顶' : '¥' + fmtMoney(v)}</span> },
    { title: '当前出价', dataIndex: 'current', align: 'right', width: 120, render: (v: number, r) => (r.status === 'waiting' ? <span style={{ color: '#bbb' }}>—</span> : <span className="num-red">¥{fmtMoney(v)}</span>) },
    { title: '出价次数', dataIndex: 'bids', align: 'right', width: 96, render: (v: number) => (<a className="count-bar">{v} <LinkOutlined style={{ fontSize: 11 }} /></a>) },
    {
      title: '状态', key: 'status', width: 160,
      render: (_, r) => {
        if (r.status === 'live') return (
          <Space direction="vertical" size={2}>
            <Tag color="red" style={{ marginInlineEnd: 0, fontWeight: 700 }}>竞价中</Tag>
            {r.endTs && (
              <span style={{ fontSize: 15, fontWeight: 700, color: '#fe2c55', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                竞价中 <LiveCountdown endTs={r.endTs} />
              </span>
            )}
          </Space>
        );
        if (r.status === 'done') return <Tag color="green">已结束</Tag>;
        return <Tag color="gold">待开拍</Tag>;
      },
    },
    {
      title: '操作', key: 'op', fixed: 'right', width: 430,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.status === 'live' && (
            <Button size="small" type="primary" icon={<VideoCameraOutlined />} onClick={() => startLive(r)}
              style={liveStarted.has(r.id) ? { background: '#52c41a', borderColor: '#52c41a' } : undefined}>
              {liveStarted.has(r.id) ? '直播设置' : '开始直播'}
            </Button>
          )}
          <Button size="small" type={explaining === r.key ? 'primary' : 'default'} icon={<SoundOutlined />} onClick={() => { setExplaining(explaining === r.key ? null : r.key); message.info(explaining === r.key ? '已取消讲解' : '开始讲解中'); }}>{explaining === r.key ? '取消讲解' : '讲解'}</Button>
          <Button size="small" onClick={() => message.info('提词器已打开（演示）')}>设置提词</Button>
          <Button size="small" onClick={() => message.info('卖点信息编辑（演示）')}>卖点</Button>
          <Popconfirm title="确认下架该拍品？" okText="确认下架" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => cancelAuction(r.id, r.name)}>
            <Button size="small" danger>下架</Button>
          </Popconfirm>
          <Dropdown menu={{ items: [{ key: 'cancel', label: <span style={{ color: '#fe2c55' }}>取消异常竞拍</span>, danger: true }], onClick: ({ key }) => { if (key === 'cancel') cancelAuction(r.id, r.name); } }}>
            <Button size="small" icon={<EllipsisOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <div className="admin-content">
      <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'live', label: `直播商品 (${products.filter((p) => p.status === 'live').length})` }, { key: 'waiting', label: `待上架商品 (${products.filter((p) => p.status === 'waiting').length})` }]} />
      <div className="admin-toolbar">
        <Checkbox>全选</Checkbox>
        <Input allowClear prefix={<SearchOutlined style={{ color: '#bbb' }} />} placeholder="请输入商品名称 / ID" style={{ width: 240 }} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button icon={<FilterOutlined />}>筛选</Button>
        <span style={{ marginLeft: 8, color: '#fe2c55', fontWeight: 600, fontSize: 13 }}>● 直播中</span>
        <div className="spacer" />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新列表</Button>
        <Button icon={<AppstoreOutlined />}>查看分组</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => message.info('请前往「竞拍发布」添加商品')}>添加商品</Button>
      </div>
      <Table<Prod> columns={columns} dataSource={rows} loading={loading} rowKey="key" rowSelection={{ type: 'checkbox' }} locale={{ emptyText: '暂无拍品 · 去「竞拍发布」开拍' }} pagination={{ pageSize: 6, showTotal: (t) => `共 ${t} 件拍品` }} scroll={{ x: 1480 }} size="middle" />

      <Modal
        open={!!streamInfo}
        title={<span><VideoCameraOutlined style={{ color: '#fe2c55' }} /> 开始直播 · {streamInfo?.name}</span>}
        onCancel={() => setStreamInfo(null)}
        footer={[<Button key="ok" type="primary" onClick={() => setStreamInfo(null)}>知道了</Button>]}
        width={620}
      >
        <p style={{ color: '#52c41a', fontWeight: 600, marginTop: 0 }}>● 推流通道已就绪 · 上传视频或用 OBS 推流后，观众即可在移动端实时观看</p>

        {/* 推荐路径：上传准备好的视频，观众端自动循环播放，无需 OBS。 */}
        <div style={{ marginBottom: 18, padding: '14px 16px', background: '#fff7f8', border: '1px solid #ffd6dd', borderRadius: 10 }}>
          <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <VideoCameraOutlined style={{ color: '#fe2c55' }} /> 用准备好的视频直播 <Tag color="red" bordered={false} style={{ marginInlineStart: 2 }}>推荐 · 无需 OBS</Tag>
          </div>
          {streamInfo?.videoUrl ? (
            <>
              <div style={{ color: '#52c41a', fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircleFilled /> 已设置直播视频 · 观众进直播间将自动循环播放
              </div>
              <Upload accept="video/mp4,video/webm" showUploadList={false} beforeUpload={onPickVideo} disabled={uploadingVideo}>
                <Button size="small" icon={<UploadOutlined />} loading={uploadingVideo}>更换视频</Button>
              </Upload>
            </>
          ) : (
            <>
              <div style={{ color: '#666', fontSize: 13, marginBottom: 10 }}>上传一段 mp4 / webm（≤64MB），观众端直播间会自动循环播放你的视频，无需打开 OBS。</div>
              <Upload accept="video/mp4,video/webm" showUploadList={false} beforeUpload={onPickVideo} disabled={uploadingVideo}>
                <Button type="primary" icon={<UploadOutlined />} loading={uploadingVideo}>选择视频上传</Button>
              </Upload>
            </>
          )}
        </div>

        {/* 备选路径：用 OBS / 直播伴侣 推真实镜头（保留原有能力）。 */}
        <details>
          <summary style={{ cursor: 'pointer', color: '#666', fontWeight: 600, marginBottom: 10 }}>或：用 OBS / 抖音直播伴侣 推真实镜头</summary>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>推流地址（OBS / 抖音直播伴侣）</div>
            <Typography.Paragraph copyable={{ text: streamInfo?.push }} style={{ background: '#f6f6f6', padding: '8px 10px', borderRadius: 6, marginBottom: 0, wordBreak: 'break-all' }}>{streamInfo?.push}</Typography.Paragraph>
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>播放地址（观众端 HLS）</div>
            <Typography.Paragraph copyable={{ text: streamInfo?.play }} style={{ background: '#f6f6f6', padding: '8px 10px', borderRadius: 6, marginBottom: 0, wordBreak: 'break-all' }}>{streamInfo?.play}</Typography.Paragraph>
          </div>
          <ol style={{ color: '#666', fontSize: 13, paddingLeft: 18, marginBottom: 0 }}>
            <li>打开 OBS / 抖音直播伴侣 → 设置 → 推流 → 服务器填入上方「推流地址」；</li>
            <li>点「开始推流」即把你的真实镜头（商品全方位）推上直播间；</li>
            <li>观众在移动端直播间实时拉流观看，竞价同步进行。</li>
          </ol>
        </details>
      </Modal>
    </div>
  );
}
