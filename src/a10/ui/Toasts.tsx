/**
 * Toasts: the store's transient messages (store.pushMessage; the bridge also turns the sim's
 * 'message' events and, in Relaxed, kill confirmations into messages). The store drops expired
 * messages only when a new one arrives, so this component hides them itself as they expire.
 */
import { useEffect, useState } from 'react';
import { useA10Store } from '../state/store';

export default function Toasts() {
  const messages = useA10Store((s) => s.messages);
  const [now, setNow] = useState(() => performance.now());
  const live = messages.filter((m) => m.until > now);

  // tick while a message is showing, and stop once the last one has expired
  useEffect(() => {
    const t0 = performance.now();
    setNow(t0);
    if (!messages.some((m) => m.until > t0)) return;
    const id = window.setInterval(() => {
      const t = performance.now();
      setNow(t);
      if (!messages.some((m) => m.until > t)) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, [messages]);

  return (
    <div className="a10-toasts" data-testid="a10-toasts" role="status" aria-live="polite">
      {live.map((m) => (
        <div key={m.id} className={`a10-toast a10-toast--${m.level}`}>
          {m.text}
        </div>
      ))}
    </div>
  );
}
