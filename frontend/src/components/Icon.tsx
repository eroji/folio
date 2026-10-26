import {
  AlignLeft,
  ArrowLeft,
  AudioLines,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsDown,
  CircleCheck,
  EllipsisVertical,
  Eye,
  EyeOff,
  Gauge,
  Globe,
  House,
  Image,
  LayoutGrid,
  LibraryBig,
  List,
  LogOut,
  Menu,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  Shield,
  SkipBack,
  SkipForward,
  Speech,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  X,
  type LucideIcon,
} from "lucide-react";

/** Every icon the app renders, keyed by name: the Direction D names from the
 * HANDOFF icon table, plus BookOpen for the "Already in your library" row. */
const ICONS = {
  House,
  LibraryBig,
  Menu,
  Plus,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
  Gauge,
  Moon,
  Speech,
  ChevronUp,
  ChevronDown,
  X,
  EllipsisVertical,
  ChevronLeft,
  ChevronRight,
  Check,
  AudioLines,
  CircleCheck,
  User,
  Pencil,
  Globe,
  Image,
  RefreshCw,
  Trash2,
  Settings,
  Shield,
  LogOut,
  LayoutGrid,
  List,
  AlignLeft,
  ChevronsDown,
  Eye,
  EyeOff,
  TriangleAlert,
  Search,
  Upload,
  ArrowLeft,
  BookOpen,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** The four transport icons are drawn filled (HANDOFF icon table). */
const FILLED = new Set<IconName>(["Play", "Pause", "SkipBack", "SkipForward"]);

/** Lucide icon at the requested size, stroke width 2. Decorative unless
 * `label` is given; forward the button's accessible name through `label`,
 * never render text here. */
export function Icon({
  name,
  size = 20,
  className,
  label,
}: {
  name: IconName;
  size?: number;
  className?: string;
  label?: string;
}) {
  const Svg: LucideIcon = ICONS[name];
  const filled = FILLED.has(name);
  return (
    <Svg
      size={size}
      className={className}
      strokeWidth={filled ? 0 : 2}
      fill={filled ? "currentColor" : undefined}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
    />
  );
}
