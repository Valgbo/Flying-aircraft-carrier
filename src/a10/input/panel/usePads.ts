/**
 * Polling the Gamepad API for the controls panel (the flight loop does not run on the menu).
 * OWNED BY THE INPUT MODULE.
 */
import { useEffect, useState } from 'react';
import type { PadLike } from '../devices';
import { readPads } from '../runtime';

/** A plain copy of a pad (Firefox mutates Gamepad objects in place). */
export function copyPads(pads: ArrayLike<PadLike | null>): PadLike[] {
  const out: PadLike[] = [];
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p || !p.connected) continue;
    out.push({
      id: p.id,
      index: p.index,
      mapping: p.mapping,
      connected: true,
      axes: Array.from(p.axes),
      buttons: Array.from(p.buttons, (b) => ({ pressed: b.pressed, value: b.value })),
    });
  }
  return out;
}

/** Calls `fn` on every animation frame while `active`. */
export function useAnimationFrame(active: boolean, fn: (dt: number) => void): void {
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      fn(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/** The connected controllers, refreshed `hz` times a second while `active`. */
export function usePads(active: boolean, hz = 20): PadLike[] {
  const [pads, setPads] = useState<PadLike[]>(() => copyPads(readPads()));
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const period = 1000 / hz;
    const loop = (now: number) => {
      if (now - last >= period) {
        last = now;
        setPads(copyPads(readPads()));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const refresh = () => setPads(copyPads(readPads()));
    window.addEventListener('gamepadconnected', refresh);
    window.addEventListener('gamepaddisconnected', refresh);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('gamepadconnected', refresh);
      window.removeEventListener('gamepaddisconnected', refresh);
    };
  }, [active, hz]);
  return pads;
}

export interface PadSummary {
  id: string;
  index: number;
  mapping: string;
}

/** The connected controllers (identity only): re-renders only when the list changes. */
export function usePadList(): PadSummary[] {
  const [list, setList] = useState<PadSummary[]>(() => summarize(readPads()));
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const update = () => {
      const next = summarize(readPads());
      setList((prev) =>
        prev.length === next.length &&
        prev.every((p, i) => p.id === next[i].id && p.index === next[i].index)
          ? prev
          : next,
      );
    };
    // pads appear on a button press without always firing an event: look twice a second
    const loop = (now: number) => {
      if (now - last > 500) {
        last = now;
        update();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    window.addEventListener('gamepadconnected', update);
    window.addEventListener('gamepaddisconnected', update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('gamepadconnected', update);
      window.removeEventListener('gamepaddisconnected', update);
    };
  }, []);
  return list;
}

function summarize(pads: ArrayLike<PadLike | null>): PadSummary[] {
  const out: PadSummary[] = [];
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected) out.push({ id: p.id, index: p.index, mapping: p.mapping });
  }
  return out;
}
