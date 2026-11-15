/**
 * The on-screen touch widgets: the floating stick, the spring-centred throttle slider, the
 * hold-to-strafe pair and the tap buttons. Each one binds its own pointer tracking in an
 * effect and writes straight to `inputSources.touch` and to the DOM through refs — no React
 * render happens while a finger moves. Unbinding (unmount) releases the widget and zeroes
 * the axes it owns.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { emitAction, type ActionName } from '../state/actions';
import { useGameStore } from '../state/useGameStore';
import { inputSources } from './input';
import { bindPointerDrag } from './pointerDrag';
import { sliderValue, stickVector, type SliderResult, type StickResult } from './touchMath';

const touch = inputSources.touch;

/** Gap kept between the slider thumb and the ends of its track, in CSS pixels. */
const SLIDER_END_MARGIN = 4;

/**
 * Virtual stick filling the left corner: X = yaw, Y = tilt (up = toward the bow;
 * `settings.invertY` flips it). The origin floats: the base jumps to where the thumb lands.
 */
export function TouchStick() {
  const zoneRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const zone = zoneRef.current;
    const base = baseRef.current;
    const knob = knobRef.current;
    if (!zone || !base || !knob) return undefined;

    const result: StickResult = { x: 0, y: 0, knobX: 0, knobY: 0 };
    let originX = 0;
    let originY = 0;

    const apply = (e: PointerEvent): void => {
      stickVector(e.clientX - originX, e.clientY - originY, result);
      touch.yaw = result.x;
      touch.tilt = useGameStore.getState().settings.invertY ? -result.y + 0 : result.y;
      knob.style.transform = `translate3d(${result.knobX}px, ${result.knobY}px, 0)`;
    };

    return bindPointerDrag(zone, {
      onStart(e) {
        const rect = zone.getBoundingClientRect();
        originX = e.clientX;
        originY = e.clientY;
        const restX = rect.left + rect.width / 2;
        const restY = rect.top + rect.height / 2;
        base.style.transform = `translate3d(${originX - restX}px, ${originY - restY}px, 0)`;
        zone.classList.add('touch-stick--active');
        apply(e);
      },
      onMove: apply,
      onEnd() {
        touch.yaw = 0;
        touch.tilt = 0;
        base.style.transform = '';
        knob.style.transform = '';
        zone.classList.remove('touch-stick--active');
      },
    });
  }, []);

  return (
    <div
      ref={zoneRef}
      className="touch-zone touch-zone--left touch-stick"
      data-testid="touch-stick"
      role="img"
      aria-label="Steering stick: left and right turn the ship, up and down tilt the turbines"
    >
      <div ref={baseRef} className="touch-stick-base">
        <span className="touch-chevron touch-chevron--up" />
        <span className="touch-chevron touch-chevron--right" />
        <span className="touch-chevron touch-chevron--down" />
        <span className="touch-chevron touch-chevron--left" />
        <div ref={knobRef} className="touch-stick-knob" />
      </div>
      <span className="touch-caption">YAW · TILT</span>
    </div>
  );
}

/**
 * Vertical collective slider: the thumb follows the finger, the value is the finger's height
 * above the centre of the track (+1 at the top, -1 at the bottom, a detent in the middle),
 * and it springs back to 0 on release.
 */
export function TouchThrottle() {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return undefined;

    const result: SliderResult = { value: 0, thumb: 0 };
    let centreY = 0;
    let travel = 0;

    const apply = (e: PointerEvent): void => {
      sliderValue(centreY - e.clientY, travel, result);
      touch.collective = result.value;
      thumb.style.transform = `translate3d(0, ${-result.thumb}px, 0)`;
    };

    return bindPointerDrag(track, {
      onStart(e) {
        const rect = track.getBoundingClientRect();
        centreY = rect.top + rect.height / 2;
        travel = (rect.height - thumb.offsetHeight) / 2 - SLIDER_END_MARGIN;
        track.classList.add('touch-throttle--active');
        apply(e);
      },
      onMove: apply,
      onEnd() {
        touch.collective = 0;
        thumb.style.transform = '';
        track.classList.remove('touch-throttle--active');
      },
    });
  }, []);

  return (
    <div
      ref={trackRef}
      className="touch-throttle"
      data-testid="touch-throttle"
      role="img"
      aria-label="Lift slider: push up to climb, down to descend"
    >
      <span className="touch-chevron touch-chevron--up" />
      <span className="touch-throttle-detent" />
      <span className="touch-chevron touch-chevron--down" />
      <div ref={thumbRef} className="touch-throttle-thumb">
        LIFT
      </div>
    </div>
  );
}

/** Port / starboard strafe buttons: held = -1 / +1, both held cancel. */
export function TouchStrafe() {
  const portRef = useRef<HTMLButtonElement>(null);
  const starboardRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const port = portRef.current;
    const starboard = starboardRef.current;
    if (!port || !starboard) return undefined;

    let portHeld = 0;
    let starboardHeld = 0;
    const write = (): void => {
      touch.strafe = starboardHeld - portHeld;
    };
    const ignoreMove = (): void => undefined;

    const unbindPort = bindPointerDrag(port, {
      onStart() {
        portHeld = 1;
        port.classList.add('touch-btn--held');
        write();
      },
      onMove: ignoreMove,
      onEnd() {
        portHeld = 0;
        port.classList.remove('touch-btn--held');
        write();
      },
    });
    const unbindStarboard = bindPointerDrag(starboard, {
      onStart() {
        starboardHeld = 1;
        starboard.classList.add('touch-btn--held');
        write();
      },
      onMove: ignoreMove,
      onEnd() {
        starboardHeld = 0;
        starboard.classList.remove('touch-btn--held');
        write();
      },
    });
    return () => {
      unbindPort();
      unbindStarboard();
    };
  }, []);

  return (
    <div className="touch-strafe">
      <button
        ref={portRef}
        type="button"
        tabIndex={-1}
        className="touch-btn touch-btn--strafe"
        data-testid="touch-btn-strafeLeft"
        aria-label="Strafe to port (hold)"
      >
        <span className="touch-chevron touch-chevron--left" />
        PORT
      </button>
      <button
        ref={starboardRef}
        type="button"
        tabIndex={-1}
        className="touch-btn touch-btn--strafe"
        data-testid="touch-btn-strafeRight"
        aria-label="Strafe to starboard (hold)"
      >
        <span className="touch-chevron touch-chevron--right" />
        STBD
      </button>
    </div>
  );
}

interface TouchActionButtonProps {
  action: ActionName;
  /** Lit state for toggles; omit for one-shot actions. */
  pressed?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Tap button for a discrete action. It fires on the press, not the release (a game control,
 * not a form button), and never takes the keyboard focus, so Space and the arrows keep
 * flying the ship afterwards.
 */
export function TouchActionButton({
  action,
  pressed,
  className,
  children,
}: TouchActionButtonProps) {
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    emitAction(action);
  };
  return (
    <button
      type="button"
      tabIndex={-1}
      className={className ? `touch-btn ${className}` : 'touch-btn'}
      data-testid={`touch-btn-${action}`}
      aria-pressed={pressed}
      onPointerDown={onPointerDown}
    >
      {children}
    </button>
  );
}
