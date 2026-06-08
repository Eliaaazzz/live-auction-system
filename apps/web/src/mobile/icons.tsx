import {
  Heart, MessageCircle, Forward, ShoppingBag, X, Eye, Plus, Minus, Gavel, Clock, History, Flame,
  Crown, Lock, Zap, ChevronRight, ChevronDown, Bell, Check, User, Gift, Trophy, Sparkles, ScrollText,
  ShieldCheck, Tag, Send, PlusCircle, Volume2, VolumeX, type LucideIcon,
} from 'lucide-react';

export type IconName =
  | 'heart' | 'comment' | 'share' | 'bag' | 'close' | 'eye' | 'plus' | 'minus'
  | 'gavel' | 'clock' | 'history' | 'flame' | 'crown' | 'lock' | 'bolt' | 'chevronR' | 'chevronD'
  | 'bell' | 'check' | 'user' | 'gift' | 'trophy' | 'sparkle' | 'scroll' | 'shield' | 'tag' | 'send'
  | 'plusCircle' | 'volume' | 'mute';

const MAP: Record<IconName, LucideIcon> = {
  heart: Heart, comment: MessageCircle, share: Forward, bag: ShoppingBag, close: X, eye: Eye,
  plus: Plus, minus: Minus, gavel: Gavel, clock: Clock, history: History, flame: Flame, crown: Crown,
  lock: Lock, bolt: Zap, chevronR: ChevronRight, chevronD: ChevronDown, bell: Bell, check: Check,
  user: User, gift: Gift, trophy: Trophy, sparkle: Sparkles, scroll: ScrollText, shield: ShieldCheck,
  tag: Tag, send: Send, plusCircle: PlusCircle, volume: Volume2, mute: VolumeX,
};

export function Icon({ name, size = 22, fill = false, stroke = 2, style }: { name: IconName; size?: number; fill?: boolean; stroke?: number; style?: React.CSSProperties; }) {
  const Cmp = MAP[name];
  return <Cmp size={size} strokeWidth={stroke} fill={fill ? 'currentColor' : 'none'} style={{ display: 'block', flexShrink: 0, ...style }} aria-hidden="true" />;
}
