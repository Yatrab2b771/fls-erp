import { Component, type ReactNode } from "react";

// A screen that throws while drawing would otherwise blank the whole app. This keeps the sidebar and header and shows what went wrong.
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Screen crashed:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="card space-y-2 border-rose-200 bg-rose-50 p-5">
        <p className="text-sm font-black text-rose-800">This screen hit a problem and could not be drawn.</p>
        <p className="font-mono text-xs text-rose-700">{error.message}</p>
        <button type="button" className="btn-ghost btn-sm" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
