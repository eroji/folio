/** Material Symbols (rounded) icon layer — a visual trial replacing lucide, see
 * docs/DECISIONS.md. Glyphs are filled shapes, so the SVG is painted with
 * `fill="currentColor"` and never the default SVG black. Transport glyphs use
 * the solid (-fill) files; everything else the outlined ones. */
import Add from "@material-symbols/svg-400/rounded/add.svg?react";
import ArrowBack from "@material-symbols/svg-400/rounded/arrow_back.svg?react";
import Check from "@material-symbols/svg-400/rounded/check.svg?react";
import CheckCircle from "@material-symbols/svg-400/rounded/check_circle.svg?react";
import Close from "@material-symbols/svg-400/rounded/close.svg?react";
import DarkMode from "@material-symbols/svg-400/rounded/dark_mode.svg?react";
import Delete from "@material-symbols/svg-400/rounded/delete.svg?react";
import DragIndicator from "@material-symbols/svg-400/rounded/drag_indicator.svg?react";
import Edit from "@material-symbols/svg-400/rounded/edit.svg?react";
import FormatAlignLeft from "@material-symbols/svg-400/rounded/format_align_left.svg?react";
import GraphicEq from "@material-symbols/svg-400/rounded/graphic_eq.svg?react";
import GridView from "@material-symbols/svg-400/rounded/grid_view.svg?react";
import Home from "@material-symbols/svg-400/rounded/home.svg?react";
import ImageIcon from "@material-symbols/svg-400/rounded/image.svg?react";
import KeyboardArrowDown from "@material-symbols/svg-400/rounded/keyboard_arrow_down.svg?react";
import KeyboardArrowLeft from "@material-symbols/svg-400/rounded/keyboard_arrow_left.svg?react";
import KeyboardArrowRight from "@material-symbols/svg-400/rounded/keyboard_arrow_right.svg?react";
import KeyboardArrowUp from "@material-symbols/svg-400/rounded/keyboard_arrow_up.svg?react";
import KeyboardDoubleArrowDown from "@material-symbols/svg-400/rounded/keyboard_double_arrow_down.svg?react";
import LibraryBooks from "@material-symbols/svg-400/rounded/library_books.svg?react";
import LinkIcon from "@material-symbols/svg-400/rounded/link.svg?react";
import List from "@material-symbols/svg-400/rounded/list.svg?react";
import Lock from "@material-symbols/svg-400/rounded/lock.svg?react";
import Logout from "@material-symbols/svg-400/rounded/logout.svg?react";
import Menu from "@material-symbols/svg-400/rounded/menu.svg?react";
import MenuBook from "@material-symbols/svg-400/rounded/menu_book.svg?react";
import MoreVert from "@material-symbols/svg-400/rounded/more_vert.svg?react";
import PauseFilled from "@material-symbols/svg-400/rounded/pause-fill.svg?react";
import Person from "@material-symbols/svg-400/rounded/person.svg?react";
import PlayArrowFilled from "@material-symbols/svg-400/rounded/play_arrow-fill.svg?react";
import Public from "@material-symbols/svg-400/rounded/public.svg?react";
import RecordVoiceOver from "@material-symbols/svg-400/rounded/record_voice_over.svg?react";
import Refresh from "@material-symbols/svg-400/rounded/refresh.svg?react";
import Replay from "@material-symbols/svg-400/rounded/replay.svg?react";
import Search from "@material-symbols/svg-400/rounded/search.svg?react";
import Settings from "@material-symbols/svg-400/rounded/settings.svg?react";
import ManageAccounts from "@material-symbols/svg-400/rounded/manage_accounts.svg?react";
import SkipNextFilled from "@material-symbols/svg-400/rounded/skip_next-fill.svg?react";
import SkipPreviousFilled from "@material-symbols/svg-400/rounded/skip_previous-fill.svg?react";
import Speed from "@material-symbols/svg-400/rounded/speed.svg?react";
import TextDecrease from "@material-symbols/svg-400/rounded/text_decrease.svg?react";
import TextIncrease from "@material-symbols/svg-400/rounded/text_increase.svg?react";
import Upload from "@material-symbols/svg-400/rounded/upload.svg?react";
import Visibility from "@material-symbols/svg-400/rounded/visibility.svg?react";
import VisibilityOff from "@material-symbols/svg-400/rounded/visibility_off.svg?react";
import Warning from "@material-symbols/svg-400/rounded/warning.svg?react";

/** Outlined glyphs: every app icon except the transport controls. */
const OUTLINED = {
  House: Home,
  LibraryBig: LibraryBooks,
  Menu,
  Plus: Add,
  TextDecrease,
  TextIncrease,
  RotateCcw: Replay,
  Gauge: Speed,
  Moon: DarkMode,
  Speech: RecordVoiceOver,
  ChevronUp: KeyboardArrowUp,
  ChevronDown: KeyboardArrowDown,
  X: Close,
  EllipsisVertical: MoreVert,
  ChevronLeft: KeyboardArrowLeft,
  ChevronRight: KeyboardArrowRight,
  Check,
  AudioLines: GraphicEq,
  CircleCheck: CheckCircle,
  User: Person,
  Pencil: Edit,
  Globe: Public,
  Image: ImageIcon,
  RefreshCw: Refresh,
  Trash2: Delete,
  Settings,
  ManageAccounts,
  LogOut: Logout,
  LayoutGrid: GridView,
  List,
  ChevronsDown: KeyboardDoubleArrowDown,
  AlignLeft: FormatAlignLeft,
  Eye: Visibility,
  EyeOff: VisibilityOff,
  TriangleAlert: Warning,
  Lock,
  Link: LinkIcon,
  GripVertical: DragIndicator,
  Search,
  Upload,
  ArrowLeft: ArrowBack,
  BookOpen: MenuBook,
} as const;

/** Solid transport glyphs (play/pause/skip) so they read as filled. */
const FILLED = {
  Play: PlayArrowFilled,
  Pause: PauseFilled,
  SkipBack: SkipPreviousFilled,
  SkipForward: SkipNextFilled,
} as const;

const ICONS = { ...OUTLINED, ...FILLED };

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** Material glyph at the requested size, painted in the surrounding text
 * colour. Decorative unless `label` is given; forward the button's accessible
 * name through `label`, never render text here. */
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
  const Glyph = ICONS[name];
  return (
    <Glyph
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
