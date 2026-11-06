/**
 * 全局搜索面板（Ctrl/Cmd + K）
 * 本地标的库 + 东财 suggest 合并去重；↑↓ 选择、Enter 打开、Esc 关闭。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MARKET_LABEL, SYMBOLS } from '../data/symbols';
import type { SymbolDef } from '../data/types';
import { searchStocks, type StockHit } from '../data/search';
import { loadRecent, pushRecent, saveRecent } from '../data/watchlist';

export function symbolToHit(s: SymbolDef): StockHit {
  return {
    code: s.code,
    name: s.name,
    market: s.market,
    marketLabel: MARKET_LABEL[s.market],
    secid: s.secid || undefined,
    sina: s.sina,
    naver: s.naver,
    yahoo: s.yahoo
  };
}

export default function CommandPalette({
  open,
  onClose,
  onPick
}: {
  open: boolean;
  onClose: () => void;
  onPick: (hit: StockHit) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  // 最近访问只在打开时读一次，避免每次输入都读 localStorage
  const recent = useMemo(() => (open ? loadRecent() : []), [open]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setHits([]);
    setActive(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!q.trim()) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      const needle = q.trim().toLowerCase();
      const local = SYMBOLS.filter(
        (s) => s.name.includes(q.trim()) || s.code.toLowerCase().includes(needle)
      )
        .slice(0, 6)
        .map(symbolToHit);
      let remote: StockHit[] = [];
      try {
        remote = await searchStocks(q.trim(), 10);
      } catch {
        remote = [];
      }
      const merged: StockHit[] = [];
      const seen = new Set<string>();
      for (const h of [...local, ...remote]) {
        if (seen.has(h.code)) continue;
        seen.add(h.code);
        merged.push(h);
      }
      setHits(merged.slice(0, 12));
      setActive(0);
      setLoading(false);
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q, open]);

  const list = q.trim() ? hits : recent;

  const commit = (h: StockHit) => {
    saveRecent(pushRecent(loadRecent(), h));
    onPick(h);
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, Math.max(list.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        const h = list[active];
        if (h) {
          e.preventDefault();
          commit(h);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, list, active]);

  if (!open) return null;

  return (
    <div className="cmdk-overlay" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 5 个市场的指数 / ETF / 个股（Ctrl/Cmd + K）"
        />
        <div className="cmdk-list">
          {loading && <div className="cmdk-empty">搜索中…</div>}
          {!loading && list.length === 0 && (
            <div className="cmdk-empty">
              {q.trim() ? '没有匹配结果' : '输入名称或代码开始搜索（如 茅台 / 00700 / AAPL）'}
            </div>
          )}
          {!loading &&
            list.map((h, i) => (
              <div
                key={h.code}
                className={'cmdk-item' + (i === active ? ' on' : '')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={() => commit(h)}
              >
                <span className="badge info">{h.marketLabel}</span>
                <b>{h.name}</b>
                <span className="code">{h.code}</span>
              </div>
            ))}
        </div>
        <div className="cmdk-hint">↑↓ 选择 · Enter 打开 · Esc 关闭 · 个股分析禁用模拟数据</div>
      </div>
    </div>
  );
}
