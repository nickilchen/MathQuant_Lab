import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** 单页崩溃不应拖垮整个应用 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel" style={{ margin: 16 }}>
          <div className="panel-title">⚠️ 页面渲染出错</div>
          <div className="panel-desc" style={{ whiteSpace: 'pre-wrap' }}>
            {String(this.state.error.message ?? this.state.error)}
          </div>
          <button type="button" className="gear-btn" style={{ marginTop: 10 }} onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
