/**
 * ErrorBoundary — keeps a render error (or a failed lazy import) inside its subtree: the
 * children are replaced by `fallback` and `onError` is told once. Works in the DOM tree and
 * inside the <Canvas>. A boundary does not recover by itself; remount it to try again.
 */
import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Rendered instead of the children after an error (default: nothing). */
  fallback?: ReactNode;
  onError?: (error: Error) => void;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
