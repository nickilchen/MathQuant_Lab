import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MomParams, MomReport } from '../math/momentum';
import type { ActionPlan } from '../math/action';
import {
  AI_PRESETS,
  loadAiConfig,
  maskKey,
  saveAiConfig,
  validateAiConfig,
  type AiConfig
} from '../ai/config';
import { AGENT_TOOLS, mergeParams, type ToolCall } from '../ai/tools';
import { callAgent } from '../ai/agent';
import { buildSnapshot } from '../ai/context';
import { Panel } from './ui';

export interface AiPanelProps {
  code: string;
  name: string;
  marketLabel: string;
  source: string;
  report: MomReport;
  plan: ActionPlan;
  params: MomParams;
  onParams: (next: MomParams) => void;
  onSymbol: (code: string) => void;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  note?: string;
}

const QUICK = [
  '用三句话说明当前信号，以及我该做什么',
  '当前参数适合这只标的吗？不适合就给出一组建议值',
  '如果现在建仓，止损位设在哪里最合理',
  '这套策略在震荡市表现如何，从回测数据看'
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

const PARAM_LABEL: Record<string, string> = {
  lookback: '回看',
  skip: '跳过',
  maLen: '均线',
  entry: '开仓阈值',
  exit: '离场阈值',
  targetVol: '目标波动',
  cap: '仓位上限'
};

export function AiPanel(props: AiPanelProps) {
  const { code, name, marketLabel, source, report, plan, params, onParams, onSymbol } = props;
  const [cfg, setCfg] = useState<AiConfig>(() => loadAiConfig());
  const [openCfg, setOpenCfg] = useState(false);
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const cfgError = useMemo(() => validateAiConfig(cfg), [cfg]);

  useEffect(() => {
    saveAiConfig(cfg);
  }, [cfg]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [turns, busy]);

  const applyTool = (tc: ToolCall): string => {
    if (tc.name === 'set_momentum_params') {
      const { next, changed } = mergeParams(params, tc.args);
      if (changed.length === 0) return '参数未变化（模型给的值与当前相同或非法）';
      onParams(next);
      return '已修改参数：' + changed.map((k) => PARAM_LABEL[k] ?? k).join('、') + '，页面已重算';
    }
    if (tc.name === 'switch_symbol') {
      const c = typeof tc.args.code === 'string' ? tc.args.code.trim() : '';
      if (!c) return '未提供标的代码';
      onSymbol(c);
      return '已切换到 ' + c;
    }
    return '已生成解释（未修改页面）';
  };

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const bad = validateAiConfig(cfg);
    if (bad) {
      setErr(bad + '。展开「AI 设置」填写后再问。');
      setOpenCfg(true);
      return;
    }
    setErr(null);
    setQ('');
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((cur) => [...cur, { role: 'user', content: text }]);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const snapshot = buildSnapshot({ code, name, marketLabel, source, report, plan, params });
      const res = await callAgent({ cfg, snapshot, history, question: text }, AGENT_TOOLS, ac.signal);
      if (!res.ok || !res.reply) {
        setErr(res.error ?? '未知错误');
        setTurns((cur) => cur.slice(0, Math.max(0, cur.length - 1)));
      } else {
        const reply = res.reply;
        const note = reply.toolCall ? applyTool(reply.toolCall) : undefined;
        setTurns((cur) => [
          ...cur,
          { role: 'assistant', content: reply.text || '（模型未返回文字，仅执行了工具调用）', note }
        ]);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const pickPreset = (label: string) => {
    const p = AI_PRESETS.find((x) => x.label === label);
    if (!p) return;
    setCfg((c) => ({ ...c, baseUrl: p.baseUrl, model: p.model }));
  };

  return (
    <Panel
      title="AI 策略助手"
      icon="🤖"
      desc="基于本页真实指标回答，可代你调参；需要自备 OpenAI 兼容 API Key"
      extra={
        <button type="button" className="chip-toggle" onClick={() => setOpenCfg((v) => !v)}>
          {openCfg ? '收起设置' : 'AI 设置'}
        </button>
      }
    >
      {openCfg && (
        <div
          style={{
            border: '1px solid rgba(127,127,127,0.22)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {AI_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="chip-toggle"
                title={p.note}
                onClick={() => pickPreset(p.label)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 10
            }}
          >
            <label style={{ fontSize: 12, color: 'var(--text-3)' }}>
              API 地址
              <input
                style={{ ...inputStyle, marginTop: 4 }}
                value={cfg.baseUrl}
                onChange={(e) => setCfg((c) => ({ ...c, baseUrl: e.target.value }))}
                placeholder="https://api.deepseek.com"
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--text-3)' }}>
              API Key
              <input
                style={{ ...inputStyle, marginTop: 4 }}
                type="password"
                value={cfg.apiKey}
                onChange={(e) => setCfg((c) => ({ ...c, apiKey: e.target.value }))}
                placeholder="sk-..."
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--text-3)' }}>
              模型
              <input
                style={{ ...inputStyle, marginTop: 4 }}
                value={cfg.model}
                onChange={(e) => setCfg((c) => ({ ...c, model: e.target.value }))}
                placeholder="deepseek-chat"
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--text-3)' }}>
              温度 {cfg.temperature.toFixed(1)}
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={cfg.temperature}
                onChange={(e) => setCfg((c) => ({ ...c, temperature: Number(e.target.value) }))}
                style={{ width: '100%', marginTop: 10 }}
              />
            </label>
          </div>
          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.7 }}>
            Key 只存在本机 localStorage，不会上传到除你填写的 API 之外的地方。
            {cfg.apiKey ? ' 当前：' + maskKey(cfg.apiKey) : ''}
            {' '}浏览器直连若被 CORS 拦截，可把地址改为同源代理 <code>/ai</code>（开发服务器已内置）。
          </div>
          {cfgError && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--down)' }}>{cfgError}</div>}
        </div>
      )}

      <div
        ref={listRef}
        style={{
          maxHeight: 340,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          paddingRight: 4,
          marginBottom: 10
        }}
      >
        {turns.length === 0 && !busy && (
          <div style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: 1.8 }}>
            问它当前信号该怎么处理、参数是否合适、止损放哪里。它只能看到本页算出的指标，不会编造行情。
          </div>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            style={{
              alignSelf: t.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '88%',
              padding: '8px 11px',
              borderRadius: 10,
              fontSize: 13,
              lineHeight: 1.75,
              whiteSpace: 'pre-wrap',
              background: t.role === 'user' ? 'rgba(80,140,255,0.14)' : 'rgba(127,127,127,0.10)',
              border: '1px solid rgba(127,127,127,0.18)'
            }}
          >
            {t.content}
            {t.note && <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--up)' }}>⚙ {t.note}</div>}
          </div>
        ))}
        {busy && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>思考中…</div>}
      </div>

      {err && <div style={{ marginBottom: 8, fontSize: 12.5, color: 'var(--down)', lineHeight: 1.7 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {QUICK.map((s) => (
          <button key={s} type="button" className="chip-toggle" onClick={() => void ask(s)} disabled={busy}>
            {s.length > 18 ? s.slice(0, 18) + '…' : s}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
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
          placeholder="问点什么，例如：现在该建仓吗"
          disabled={busy}
        />
        <button type="button" className="chip-toggle" onClick={() => void ask(q)} disabled={busy || !q.trim()}>
          发送
        </button>
        {busy && (
          <button type="button" className="chip-toggle" onClick={() => abortRef.current?.abort()}>
            停止
          </button>
        )}
        {turns.length > 0 && !busy && (
          <button type="button" className="chip-toggle" onClick={() => setTurns([])}>
            清空
          </button>
        )}
      </div>

      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.7 }}>
        AI 结论基于本页指标推导，不含实时新闻与财报；模型给参数时会被夹到合法区间。不构成投资建议。
      </div>
    </Panel>
  );
}
