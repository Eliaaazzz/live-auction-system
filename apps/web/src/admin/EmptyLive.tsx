import type { ReactNode } from 'react';
import { Button } from 'antd';
import { VideoCameraOutlined, RightOutlined } from '@ant-design/icons';

/**
 * 行动导向空状态（直播商品 / 实时竞拍监控）：不说「暂无 X」，直接告诉卖家
 * 下一步干嘛，并给一个跳「竞拍发布」的 CTA。文案与图标按页面语境定制：
 * 商品列表 →「快去上架商品」，实时监控 →「快去直播」。
 * 样式见 admin.css `.empty-live*`（呼吸光环 + 渐变 CTA，reduced-motion 自动关动画）。
 */
export function EmptyLive({
  onGo,
  icon = <VideoCameraOutlined />,
  title = '快去直播吧',
  hint = '发布一场竞拍，这里马上热闹起来',
  cta = '去竞拍发布开拍',
}: {
  onGo?: () => void;
  icon?: ReactNode;
  title?: string;
  hint?: string;
  cta?: string;
}) {
  return (
    <div className="empty-live">
      <div className="empty-live-badge">
        {icon}
        <span className="empty-live-spark s1">✨</span>
        <span className="empty-live-spark s2">✨</span>
      </div>
      <div className="empty-live-title">{title}</div>
      <div className="empty-live-hint">{hint}</div>
      {onGo && (
        <Button className="empty-live-cta" type="primary" size="large" onClick={onGo}>
          {cta} <RightOutlined style={{ fontSize: 12 }} />
        </Button>
      )}
    </div>
  );
}

export default EmptyLive;
