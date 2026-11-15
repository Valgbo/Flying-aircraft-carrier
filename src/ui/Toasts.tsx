/**
 * Toasts — transient status messages pushed with `useGameStore.getState().pushMessage()`.
 * On the flying screens they are placed around the HUD (toasts.css): `toasts--flying`, plus
 * `toasts--touch` while the on-screen touch controls hold the two bottom corners.
 */
import { useEffect } from 'react';
import { useTouchControlsVisible } from '../controls/touchVisibility';
import { isFlyingScreen, useGameStore } from '../state/useGameStore';
import './toasts.css';

export default function Toasts() {
  const messages = useGameStore((s) => s.messages);
  const flying = useGameStore((s) => isFlyingScreen(s.screen));
  const touch = useTouchControlsVisible();
  useEffect(() => {
    if (messages.length === 0) return;
    const id = window.setInterval(
      () => useGameStore.getState().pruneMessages(performance.now()),
      250,
    );
    return () => window.clearInterval(id);
  }, [messages.length]);
  if (messages.length === 0) return null;
  const className = ['toasts', flying && 'toasts--flying', flying && touch && 'toasts--touch']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className} data-testid="toasts" role="status" aria-live="polite">
      {messages.map((m) => (
        <div key={m.id} className={`toast toast--${m.level}`}>
          {m.text}
        </div>
      ))}
    </div>
  );
}
