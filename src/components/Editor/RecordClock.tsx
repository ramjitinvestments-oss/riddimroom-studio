/**
 * FINAL FIX Part 1 — the recording clock, isolated from the camera
 * tree.
 *
 * Before this component existed, CameraCapture held the elapsed
 * seconds in ITS OWN React state and bumped it with a 1-second
 * interval on the component: every tick re-rendered the whole
 * ~3,800-line camera surface — viewfinder overlays, settings sheet,
 * review panels and all — once a second for the entire take. The
 * R41 periodicity forensics measured that re-render as one of the
 * two ~100ms main-thread strikes landing every second of every take
 * (the pair that dominates the remaining viewfinder frame deficit).
 *
 * This leaf owns the seconds now. It is mounted only while a take
 * is recording (mount = the take's zero; unmount clears the
 * interval), holds the counter in its own state, and re-renders
 * ONLY its own small subtree per tick — the camera tree renders
 * once at record start and once at stop, never per second.
 *
 * The parent's per-second duties that are NOT display — the
 * 10-second camera-test auto-stop, the 60-second diagnostics
 * auto-stop and the universal duration cap — are reported upward
 * through `onSecond`, which the parent keeps in a ref: the callback
 * runs, it never renders anything.
 *
 * Pure display ownership; no camera logic lives here. $0: no deps.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface RecordClockProps {
  /**
   * Called once per elapsed second (1, 2, 3, …) for the parent's
   * enforcement checks. Held in a ref internally, so a new callback
   * identity never restarts the interval and never renders.
   */
  onSecond?: (seconds: number) => void;
  /** The ticking display, rendered from the leaf's own seconds. */
  children: (seconds: number) => ReactNode;
}

export function RecordClock({ onSecond, children }: RecordClockProps) {
  const [seconds, setSeconds] = useState(0);
  const onSecondRef = useRef(onSecond);
  onSecondRef.current = onSecond;
  const secondsRef = useRef(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
      onSecondRef.current?.(secondsRef.current);
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  return <>{children(seconds)}</>;
}
