import * as React from 'react';
import { DOCK_WIDTH, SIDEBAR_WIDTH, clampWidth, loadLayout, updateLayout } from '../lib/layout.js';
import { cn } from '../lib/utils';
import { layoutStorage } from './layoutStorage';

type Which = 'sidebar' | 'dock';
const BOUNDS = { sidebar: SIDEBAR_WIDTH, dock: DOCK_WIDTH };
/**
 * Paseo keeps 400px for the rest: the sidebar never grows past the window minus that, the
 * explorer past its container (the window less the shown sidebar) minus that.
 */
const REST = 400;

const bounds = (which: Which, reserved = 0) => {
  const { min, max } = BOUNDS[which];
  return { min, max: Math.max(min, Math.min(max, (typeof window === 'undefined' ? Infinity : window.innerWidth) - reserved - REST)) };
};

/**
 * A docked panel's width, as Paseo's sidebar and explorer widths: dragged with the panel's
 * handle, clamped to the panel's bounds, kept across reloads (lib/layout.js).
 */
export function usePanelWidth(which: Which, reserved = 0) {
  const key = which === 'sidebar' ? 'sidebarWidth' : 'dockWidth';
  const [width, setWidth] = React.useState(() => loadLayout(layoutStorage())[key] ?? BOUNDS[which].initial);
  const save = React.useCallback((value: number) => {
    updateLayout(layoutStorage(), layout => ({ ...layout, [key]: value }));
  }, [key]);
  // A narrower window shrinks the shown width, not the saved one.
  const [, rerender] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => {
    window.addEventListener('resize', rerender);
    return () => window.removeEventListener('resize', rerender);
  }, []);
  return { width: clampWidth(width, bounds(which, reserved)) ?? BOUNDS[which].initial, setWidth, save, reserved };
}

/**
 * Paseo's resize handle on a panel's inner edge: a 10px strip over the border, col-resize cursor,
 * a highlight on hover and while dragging. ALP adds the arrow keys (Shift for bigger steps), Home
 * and End, as a separator should have.
 */
export function ResizeHandle({ which, side, width, reserved = 0, onWidth, onCommit, testId }: {
  which: Which;
  /** Width the other docked panel takes from this one's room. */
  reserved?: number;
  /** The panel's edge the handle sits on. */
  side: 'right' | 'left';
  width: number;
  onWidth: (width: number) => void;
  onCommit: (width: number) => void;
  testId?: string;
}) {
  const [dragging, setDragging] = React.useState(false);
  const { min, max } = bounds(which, reserved);
  // A drag cut short by the handle going away (Mod+B mid-drag) still ends cleanly.
  const stop = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => stop.current?.(), []);
  const clamp = (value: number) => clampWidth(value, { min, max }) ?? width;
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const start = width;
    let last = width;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const cursor = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    const move = (next: PointerEvent) => {
      const delta = next.clientX - startX;
      last = clamp(start + (side === 'right' ? delta : -delta));
      onWidth(last);
    };
    const end = () => {
      stop.current = null;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      document.body.style.cursor = cursor;
      setDragging(false);
      onCommit(last);
    };
    stop.current = end;
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 48 : 16;
    const grow = side === 'right' ? 1 : -1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = width + step * grow;
    else if (event.key === 'ArrowLeft') next = width - step * grow;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    const value = clamp(next);
    onWidth(value);
    onCommit(value);
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label={which === 'sidebar' ? 'Resize sidebar' : 'Resize explorer'} tabIndex={0}
      aria-valuenow={width} aria-valuemin={min} aria-valuemax={max} data-testid={testId}
      onPointerDown={onPointerDown} onKeyDown={onKeyDown}
      className={cn('group absolute inset-y-0 z-10 w-2.5 cursor-col-resize touch-none outline-none', side === 'right' ? '-right-[5px]' : '-left-[5px]')}>
      <span aria-hidden className={cn('absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 bg-ring opacity-0 transition-opacity delay-100 group-hover:opacity-100 group-focus-visible:opacity-100', dragging && 'opacity-100')} />
    </div>
  );
}
