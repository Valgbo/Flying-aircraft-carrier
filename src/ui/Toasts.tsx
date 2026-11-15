/** Toasts — transient status messages pushed with `useGameStore.getState().pushMessage()`. */
import { useEffect } from 'react';
import { useGameStore } from '../state/useGameStore';
import './toasts.css';

export default function Toasts() {
  const messages = useGameStore((s) => s.messages);
  useEffect(() => {
    if (messages.length === 0) return;
    const id = window.setInterval(
      () => useGameStore.getState().pruneMessages(performance.now()),
      250,
    );
    return () => window.clearInterval(id);
  }, [messages.length]);
  if (messages.length === 0) return null;
  return (
    <div className="toasts" data-testid="toasts" role="status" aria-live="polite">
      {messages.map((m) => (
        <div key={m.id} className={`toast toast--${m.level}`}>
          {m.text}
        </div>
      ))}
    </div>
  );
}
