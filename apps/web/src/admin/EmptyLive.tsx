import type { ReactNode } from 'react';
import { Button } from 'antd';
import { VideoCameraOutlined, RightOutlined } from '@ant-design/icons';

/**
 * An action-oriented empty state (live products / live monitor): instead of "nothing here", it tells the
 * seller what to do next and offers a CTA into Publish auction. Copy and icon are tailored per page:
 * the product list says "list your first product", the live monitor says "go live".
 * Styles live in admin.css `.empty-live*` (a breathing halo plus a gradient CTA, with animation disabled
 * automatically under reduced-motion).
 */
export function EmptyLive({
  onGo,
  icon = <VideoCameraOutlined />,
  title = 'Go live',
  hint = 'Publish an auction and this page comes alive',
  cta = 'Go to Publish auction',
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
