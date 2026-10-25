import type { FC, SVGProps } from "react";
import AdminPanelSettings from "@material-symbols/svg-400/rounded/admin_panel_settings.svg?react";
import AutoStories from "@material-symbols/svg-400/rounded/auto_stories.svg?react";
import Bedtime from "@material-symbols/svg-400/rounded/bedtime.svg?react";
import Check from "@material-symbols/svg-400/rounded/check.svg?react";
import ChevronLeft from "@material-symbols/svg-400/rounded/chevron_left.svg?react";
import Close from "@material-symbols/svg-400/rounded/close.svg?react";
import CloseFullscreen from "@material-symbols/svg-400/rounded/close_fullscreen.svg?react";
import Contrast from "@material-symbols/svg-400/rounded/contrast.svg?react";
import Devices from "@material-symbols/svg-400/rounded/devices.svg?react";
import ErrorIcon from "@material-symbols/svg-400/rounded/error.svg?react";
import Headphones from "@material-symbols/svg-400/rounded/headphones.svg?react";
import KeyboardDoubleArrowLeft from "@material-symbols/svg-400/rounded/keyboard_double_arrow_left.svg?react";
import KeyboardDoubleArrowRight from "@material-symbols/svg-400/rounded/keyboard_double_arrow_right.svg?react";
import Logout from "@material-symbols/svg-400/rounded/logout.svg?react";
import MoreHoriz from "@material-symbols/svg-400/rounded/more_horiz.svg?react";
import OpenInFull from "@material-symbols/svg-400/rounded/open_in_full.svg?react";
import Pause from "@material-symbols/svg-400/rounded/pause.svg?react";
import Person from "@material-symbols/svg-400/rounded/person.svg?react";
import PlayArrow from "@material-symbols/svg-400/rounded/play_arrow.svg?react";
import ProgressActivity from "@material-symbols/svg-400/rounded/progress_activity.svg?react";
import RecordVoiceOver from "@material-symbols/svg-400/rounded/record_voice_over.svg?react";
import Refresh from "@material-symbols/svg-400/rounded/refresh.svg?react";
import Replay from "@material-symbols/svg-400/rounded/replay.svg?react";
import RestartAlt from "@material-symbols/svg-400/rounded/restart_alt.svg?react";
import Search from "@material-symbols/svg-400/rounded/search.svg?react";
import Settings from "@material-symbols/svg-400/rounded/settings.svg?react";
import SkipNext from "@material-symbols/svg-400/rounded/skip_next.svg?react";
import SkipPrevious from "@material-symbols/svg-400/rounded/skip_previous.svg?react";
import Speed from "@material-symbols/svg-400/rounded/speed.svg?react";
import Stop from "@material-symbols/svg-400/rounded/stop.svg?react";
import TaskAlt from "@material-symbols/svg-400/rounded/task_alt.svg?react";
import Toc from "@material-symbols/svg-400/rounded/toc.svg?react";
import Upload from "@material-symbols/svg-400/rounded/upload.svg?react";
import Visibility from "@material-symbols/svg-400/rounded/visibility.svg?react";
import VisibilityOff from "@material-symbols/svg-400/rounded/visibility_off.svg?react";
import Warning from "@material-symbols/svg-400/rounded/warning.svg?react";

type Svg = FC<SVGProps<SVGSVGElement>>;

/** Every symbol in the handoff's icon table, keyed by Material symbol name.
 * The rounded set is outlined; its play_arrow, pause and skip_* are already
 * visually filled, so one file covers both variants. */
const ICONS = {
  admin_panel_settings: AdminPanelSettings,
  auto_stories: AutoStories,
  bedtime: Bedtime,
  check: Check,
  chevron_left: ChevronLeft,
  close: Close,
  close_fullscreen: CloseFullscreen,
  contrast: Contrast,
  devices: Devices,
  error: ErrorIcon,
  headphones: Headphones,
  keyboard_double_arrow_left: KeyboardDoubleArrowLeft,
  keyboard_double_arrow_right: KeyboardDoubleArrowRight,
  logout: Logout,
  more_horiz: MoreHoriz,
  open_in_full: OpenInFull,
  pause: Pause,
  person: Person,
  play_arrow: PlayArrow,
  progress_activity: ProgressActivity,
  record_voice_over: RecordVoiceOver,
  refresh: Refresh,
  replay: Replay,
  restart_alt: RestartAlt,
  search: Search,
  settings: Settings,
  skip_next: SkipNext,
  skip_previous: SkipPrevious,
  speed: Speed,
  stop: Stop,
  task_alt: TaskAlt,
  toc: Toc,
  upload: Upload,
  visibility: Visibility,
  visibility_off: VisibilityOff,
  warning: Warning,
} as const satisfies Record<string, Svg>;

export type IconName = keyof typeof ICONS;

/** Material Symbols icon. Decorative unless `label` is given; forward the
 * button's accessible name through `label`, never render text here. */
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
  const Svg: Svg = ICONS[name];
  return (
    <Svg
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      {...(label
        ? { role: "img" as const, "aria-label": label }
        : { "aria-hidden": true })}
    />
  );
}
