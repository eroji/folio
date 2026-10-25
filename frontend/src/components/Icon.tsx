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
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  CircleCheck,
  Ellipsis,
  EllipsisVertical,
  Eye,
  EyeOff,
  Gauge,
  Globe,
  Headphones,
  House,
  Image,
  LayoutGrid,
  LibraryBig,
  List,
  LoaderCircle,
  LogOut,
  Maximize2,
  Menu,
  Minimize2,
  MonitorSmartphone,
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
  Square,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  X,
  type LucideIcon,
} from "lucide-react";

/** Every icon the app renders, keyed by name: the Direction C material names
 * still used by current call sites (rewritten in phases 2–7) plus the
 * Direction D names from the HANDOFF icon table. */
const ICONS = {
  // current call sites (material names → lucide equivalents)
  admin_panel_settings: Shield,
  auto_stories: BookOpen,
  bedtime: Moon,
  check: Check,
  chevron_left: ChevronLeft,
  close: X,
  close_fullscreen: Minimize2,
  devices: MonitorSmartphone,
  error: CircleAlert,
  headphones: Headphones,
  keyboard_double_arrow_left: ChevronsLeft,
  keyboard_double_arrow_right: ChevronsRight,
  logout: LogOut,
  more_horiz: Ellipsis,
  open_in_full: Maximize2,
  pause: Pause,
  person: User,
  play_arrow: Play,
  progress_activity: LoaderCircle,
  record_voice_over: Speech,
  refresh: RefreshCw,
  replay: RotateCcw,
  restart_alt: RotateCcw,
  search: Search,
  settings: Settings,
  skip_next: SkipForward,
  skip_previous: SkipBack,
  speed: Gauge,
  stop: Square,
  task_alt: CircleCheck,
  toc: List,
  upload: Upload,
  visibility: Eye,
  visibility_off: EyeOff,
  warning: TriangleAlert,
  // Direction D table (HANDOFF.md §2)
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
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** The four transport icons are drawn filled (HANDOFF icon table). */
const FILLED = new Set<IconName>([
  "play_arrow",
  "pause",
  "skip_next",
  "skip_previous",
  "Play",
  "Pause",
  "SkipBack",
  "SkipForward",
]);

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
