import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadAiConfig, validateAiConfig, type AiConfig } from '../ai/config';
import { callGeneralAnalysis, type GeneralSnapshot } from '../ai/general';

export interface AiAnalyzeProps {
  /** 模块名，如「技术面体检」「价值估值」 */
  module: string;
  /** 标的名（可选） */
  symbol?: string;
  /** 事实快照条目：名称 + 值（页面已算出的真实指标） */
  facts: { label: string; value: string }[];
  /** 口径补充（可选） */
  note?: string;
  /** 默认快捷问题（可选） */
  suggestions?: string[];
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_SUGGESTIONS = [
  '用三句话总结这些指标说明什么',
  '哪些指标偏多、哪些偏空？分别依据是什么',
  '这些数值里有什么风险信号需要留意'
];

const inputStyle: CSSProperties = {
  border: '1px solid var(--border-strong)',
  borderRadius: 8,
  padding: '7px 10px',
  fontSize: 13,
  outline: 'none',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  width: '100%',
  boxSizing: 'border-box'
};

/**
 * 通用 AI 指标解读按钮。只读：模型拿不到任何工具，无法改参数或切标的。
 * 配置只从本机 localStorage 读取，Key 不上传项目服务器、不进 URL、不写日志。
 */
export function AiAnalyze({ module, symbol, facts, note, suggestions }: AiAnalyzeProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<AiConfig | null>(() => loadAiConfig());
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 每次展开面板时重新读一次本机配置（用户可能在 AI 设置页刚改过）
  useEffect(() => {
    if (open) setCfg(loadAiConfig());
  }, [open]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [turns, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const configured = cfg ? validateAiConfig(cfg) === null : false;

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const cur = loadAiConfig(); // 用最新配置，避免设置页改过后此组件持有旧值
    setCfg(cur);
    const bad = validateAiConfig(cur);
    if (bad) {
      setErr(bad + '。请到「AI 设置」配置后再用。');
      setOpen(true);
      return;
    }
    setErr(null);
    setQ('');
    const snapshot: GeneralSnapshot = { module, symbol, facts, note };
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((c) => [...c, { role: 'user', content: text }]);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await callGeneralAnalysis(cur, snapshot, history, text, ac.signal);
      if (!res.ok || res.text == null) {
        setErr(res.error ?? '未知错误');
        setTurns((c) => c.slice(0, Math.max(0, c.length - 1)));
      } else {
        setTurns((c) => [...c, { role: 'assistant', content: res.text as string }]);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const quick = suggestions?.length ? suggestions : DEFAULT_SUGGESTIONS;

  return (
    <div className="ai-analyze">
      <div className="ai-analyze-bar">
        <button type="button" className="chip-toggle ai-analyze-btn" onClick={() => setOpen((v) => !v)}>
          {open ? '收起 AI 分析' : '🤖 AI 分析' + (configured ? '' : '（未配置）')}
        </button>
        {!configured && (
          <button type="button" className="chip-toggle" onClick={() => navigate('/ai-settings')} title="打开 AI 设置">
            ⚙️ 去配置
          </button>
        )}
        {configured && (
          <button type="button" className="chip-toggle" onClick={() => navigate('/ai-settings')} title="管理本机 AI 配置">
            ⚙️ AI 设置
          </button>
        )}
        <span className="ai-analyze-hint">只读解读 · 不改参数、不切标的 · Key 仅存本机</span>
      </div>

      {open && (
        <div className="ai-analyze-body">
          {!configured && (
            <div className="ai-analyze-notice">
              尚未配置 AI 模型。请到 <button type="button" className="ai-inline-link" onClick={() => navigate('/ai-settings')}>AI 设置</button>
              填写 API 地址、Key 与模型名；配置只保存在当前浏览器，其他人看不到，也不会共用。
            </div>
          )}

          <div ref={listRef} className="ai-analyze-list">
            {turns.length === 0 && !busy && (
              <div className="ai-analyze-empty">
                本助手只看本页「{module}」的事实快照，解读这些指标意味着什么，不会编造数据、不改任何设置。
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={'ai-analyze-msg ' + (t.role === 'user' ? 'user' : 'assistant')}>
                {t.content}
              </div>
            ))}
            {busy && <div className="ai-analyze-thinking">思考中…</div>}
          </div>

          {err && <div className="ai-analyze-error">{err}</div>}

          <div className="ai-analyze-quick">
            {quick.map((s) => (
              <button key={s} type="button" className="chip-toggle" onClick={() => void ask(s)} disabled={busy}>
                {s.length > 20 ? s.slice(0, 20) + '…' : s}
              </button>
            ))}
          </div>

          <div className="ai-analyze-input">
            <input
              style={inputStyle}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void ask(q);
                }
              }}
              placeholder="针对本页指标问点什么…"
              disabled={busy}
            />
            <button type="button" className="chip-toggle" onClick={() => void ask(q)} disabled={busy || !q.trim()}>发送</button>
            {busy && (
              <button type="button" className="chip-toggle" onClick={() => abortRef.current?.abort()}>停止</button>
            )}
            {turns.length > 0 && !busy && (
              <button type="button" className="chip-toggle" onClick={() => setTurns([])}>清空</button>
            )}
          </div>

          <div className="ai-analyze-foot">
            AI 结论基于本页指标推导，仅供学习研究，不构成投资建议。
          </div>
        </div>
      )}
    </div>
  );
}

export default AiAnalyze;
