/** Drag a full-screen sheet down to close it: the sheet follows the finger,
 * closes past CLOSE_PX (or on a quick flick past FLICK_PX), and otherwise
 * springs back. Spread `handlers` on the drag area (give it `touch-none` so the
 * browser does not scroll instead) and `style` on the sheet. A drag never
 * also counts as a tap on whatever it started on. */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type MouseEvent } from "react";

const SLOP_PX = 8; // smaller moves stay taps
const CLOSE_PX = 96;
const FLICK_PX = 40;
const FLICK_PX_PER_MS = 0.6;
const SETTLE_MS = 180;

export function useSwipeDown(onClose: () => void) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; at: number; id: number } | null>(null);
  const dragged = useRef(false);
  const closing = useRef<number | null>(null);
  useEffect(() => () => {
    if (closing.current !== null) window.clearTimeout(closing.current);
  }, []);

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    start.current = { y: event.clientY, at: Date.now(), id: event.pointerId };
    dragged.current = false;
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const from = start.current;
    if (!from || event.pointerId !== from.id) return;
    const dy = event.clientY - from.y;
    if (!dragged.current) {
      if (dy < SLOP_PX) return;
      dragged.current = true;
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    setOffset(Math.max(0, dy));
  }

  function onPointerUp(event: PointerEvent<HTMLElement>) {
    const from = start.current;
    start.current = null;
    if (!from || !dragged.current) return;
    setDragging(false);
    const dy = Math.max(0, event.clientY - from.y);
    const speed = dy / Math.max(1, Date.now() - from.at);
    if (dy > CLOSE_PX || (dy > FLICK_PX && speed > FLICK_PX_PER_MS)) {
      setOffset(window.innerHeight); // slide the rest of the way, then close
      closing.current = window.setTimeout(onClose, SETTLE_MS);
    } else {
      setOffset(0);
    }
  }

  function onPointerCancel() {
    start.current = null;
    dragged.current = false;
    setDragging(false);
    setOffset(0);
  }

  function onClickCapture(event: MouseEvent<HTMLElement>) {
    if (!dragged.current) return;
    dragged.current = false; // the click that ends a drag is not a tap
    event.preventDefault();
    event.stopPropagation();
  }

  const style: CSSProperties = {
    transform: offset > 0 ? `translateY(${offset}px)` : undefined,
    transition: dragging ? "none" : `transform ${SETTLE_MS}ms ease-out`,
  };
  return { style, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture } };
}
