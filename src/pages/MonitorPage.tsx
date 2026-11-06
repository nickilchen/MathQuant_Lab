import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CtrlGroup, EmptyTip, MetricGrid, Panel } from '../components/ui';
import { useMonitor } from '../hooks/MonitorContext';
import { searchStocks, type StockHit } from '../data/search';
import { loadWatchlist } from '../data/watchlist';
import {
  EVENT_KIND_LABEL,
  EVENT_LEVEL_LABEL,
  formatClock,
  type EventKind,
  type MonitorConfig,
  type MonitorEvent
} from '../math/monitor';

type Filter = 'all' | EventKind | 'critical';

const FILTER_LABEL: Record<Filter, string> = {
  all: '全部',
  news: '快讯',
  quote: '行情',
  announcement: '公告',
  system: '系统',
  critical: '仅重要'
};

const KIND_ICON: Record<EventKind, string> = {
  news: '📰',
  quote: '📉',
  announcement: '📄',
  system: '⚙️'
};

/** 秒 → 人类可读 */
const dur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`);

export default function MonitorPage() {
  const m = useMonitor();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [showDrop, setShowDrop] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  // 进入监控页即视为已读（事件流就在本页）；红点的作用是在别的页面提示新事件
  useEffect(() => {
    m.markAllRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) {
      setHits([]);
      setShowDrop(false);
      return;
    }
    debounce.current = setTimeout(async () => {
      const r = await searchStocks(query, 10).catch(() => []);
      setHits(r);
      setShowDrop(r.length > 0);
    }, 300);
    return () => clearTimeout(debounce.current);
  }, [query]);

  const add = (hit: StockHit) => {
    m.addTarget(hit);
    setQuery('');
    setHits([]);
    setShowDrop(false);
  };

  const importWatchlist = () => {
    const watch = loadWatchlist();
    if (!watch.length) return;
    const cur = new Set(m.targets.map((t) => t.code));
    m.setTargets([...m.targets, ...watch.filter((w) => !cur.has(w.code))]);
  };

  const shownEvents = useMemo(() => {
    const list = m.events.filter((e) => {
      if (filter === 'all') return true;
      if (filter === 'critical') return e.level !== 'info';
      return e.kind === filter;
    });
    return list.slice(0, 80);
  }, [m.events, filter]);

  const setCfg = (patch: Partial<MonitorConfig>) => m.setConfig(patch);
  const setRule = (patch: Partial<MonitorConfig['rules']>) => setCfg({ rules: { ...m.config.rules, ...patch } });

  const quoteMap = new Map(m.quotes.map((q) => [q.code, q]));
  const statusColor = m.config.running ? 'var(--up)' : 'var(--text-3)';

  return (
    <>
      <div className="page-title-row">
        <h2>🔔 实时监控 · 消息与个股</h2>
        <span className="en">Realtime Monitor</span>
      </div>
      <p className="page-lead">
        全局定时盯盘：分钟级轮询<b>财联社快讯</b>、<b>五市场实时行情</b>与<b>个股公告</b>，只在
        <b>出现新消息 / 涨跌幅越过阈值 / 瞬时急拉急跌 / 新公告</b>时产生一条事件。
        引擎挂在应用外层，<b>切到别的页面也不中断</b>，顶栏 🔔 会累计未读。
      </p>

      {/* ===== 运行状态 ===== */}
      <Panel
        title="运行状态"
        icon="🟢"
        desc="三条数据流各自计时，互不拖累；任一路失败只记错误，不影响其他两路"
        extra={
          <span className="inst-hint">
            距下次轮询 <b>{m.busy ? '执行中…' : dur(m.nextIn)}</b>
          </span>
        }
      >
        <div className="mon-ctrl">
          <span className={`mon-status ${m.config.running ? 'on' : ''}`} style={{ color: statusColor }}>
            ● {m.config.running ? '监控运行中' : '已暂停'}
          </span>
          <button type="button" className="gear-btn" onClick={m.toggle}>
            {m.config.running ? '⏸ 暂停' : '▶️ 启动'}
          </button>
          <button type="button" className="gear-btn" onClick={m.pollNow} disabled={m.busy}>
            🔄 立即轮询
          </button>
          <button
            type="button"
            className={`chip-toggle${m.config.notify ? ' on' : ''}`}
            onClick={() => void m.requestNotify()}
            title={
              m.notifyPermission === 'unsupported'
                ? '当前浏览器不支持桌面通知'
                : m.notifyPermission === 'denied'
                  ? '通知权限已被拒绝，需在浏览器站点设置里开启'
                  : '开启浏览器桌面通知'
            }
          >
            🔔 桌面通知{m.notifyPermission === 'granted' ? ' ✓' : ''}
          </button>
          <button
            type="button"
            className={`chip-toggle${m.config.sound ? ' on' : ''}`}
            onClick={() => setCfg({ sound: !m.config.sound })}
          >
            🔊 提示音
          </button>
          <button type="button" className="gear-btn" onClick={m.markAllRead}>
            ✓ 全部已读
          </button>
          <button type="button" className="gear-btn" onClick={m.clearEvents}>
            🗑 清空事件
          </button>
        </div>

        <MetricGrid
          items={[
            { label: '监控标的', value: `${m.targets.length} 只`, sub: '上限 30 只' },
            { label: '累计轮询', value: `${m.pollCount} 次` },
            { label: '失败次数', value: `${m.errorCount} 次`, tone: m.errorCount > 0 ? 'down' : 'flat' },
            { label: '事件总数', value: `${m.events.length} 条`, sub: `未读 ${m.unread}` },
            { label: '行情上次', value: m.lastPoll.quote ? formatClock(m.lastPoll.quote) : '—' },
            { label: '快讯上次', value: m.lastPoll.news ? formatClock(m.lastPoll.news) : '—' },
            { label: '公告上次', value: m.lastPoll.ann ? formatClock(m.lastPoll.ann) : '—' },
            { label: '报价源', value: m.quotes.length ? `${m.quotes.length} 条` : '待拉取' },
            { label: '降频倍率', value: `×${m.factor}`, tone: m.factor > 1 ? 'down' : 'flat', sub: m.factor > 1 ? '休市/后台已降频' : '正常频率' },
            { label: '保护跳过', value: `${m.skipped} 次`, sub: '限流预算主动跳过' }
          ]}
        />
        {m.lastError && (
          <div className="inst-hint" style={{ color: 'var(--amber)', marginTop: 8 }}>
            最近一次失败：{m.lastError}（单路失败会自动在下一轮重试）
          </div>
        )}
      </Panel>

      {/* ===== 参数 ===== */}
      <Panel title="⚙️ 轮询与告警阈值" icon="⚙️" desc="改动即时生效，配置保存在本地；间隔下限有保护，避免高频请求">
        <div className="mon-form">
          <div className="mon-form-row">
            <CtrlGroup label="行情间隔（秒）">
              <input
                className="mon-input"
                type="number"
                min={10}
                max={3600}
                value={m.config.quoteInterval}
                onChange={(e) => setCfg({ quoteInterval: Number(e.target.value) })}
              />
            </CtrlGroup>
            <CtrlGroup label="快讯间隔（秒）">
              <input
                className="mon-input"
                type="number"
                min={20}
                max={3600}
                value={m.config.newsInterval}
                onChange={(e) => setCfg({ newsInterval: Number(e.target.value) })}
              />
            </CtrlGroup>
            <CtrlGroup label="公告间隔（秒）">
              <input
                className="mon-input"
                type="number"
                min={60}
                max={7200}
                value={m.config.annInterval}
                onChange={(e) => setCfg({ annInterval: Number(e.target.value) })}
              />
            </CtrlGroup>
            <CtrlGroup label="日内涨跌阈值（%）">
              <input
                className="mon-input"
                type="number"
                step={0.5}
                min={0.2}
                max={30}
                value={m.config.rules.movePct}
                onChange={(e) => setRule({ movePct: Number(e.target.value) })}
              />
            </CtrlGroup>
            <CtrlGroup label="瞬时跳变阈值（%）">
              <input
                className="mon-input"
                type="number"
                step={0.5}
                min={0.2}
                max={20}
                value={m.config.rules.jumpPct}
                onChange={(e) => setRule({ jumpPct: Number(e.target.value) })}
              />
            </CtrlGroup>
            <button type="button" className="gear-btn" onClick={m.resetConfig}>
              ↺ 恢复默认
            </button>
          </div>
          <div className="mon-form-row">
            <CtrlGroup label="快讯最低档位">
              {(['S', 'A', 'B'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip-toggle${m.config.rules.newsTier === t ? ' on' : ''}`}
                  onClick={() => setRule({ newsTier: t })}
                >
                  {t} 级及以上
                </button>
              ))}
            </CtrlGroup>
            <CtrlGroup label="监控开关">
              {(
                [
                  ['enableQuotes', '行情'],
                  ['enableNews', '快讯'],
                  ['enableAnn', '公告']
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={`chip-toggle${m.config.rules[k] ? ' on' : ''}`}
                  onClick={() => setRule({ [k]: !m.config.rules[k] })}
                >
                  {label}
                </button>
              ))}
            </CtrlGroup>
            <button
              type="button"
              className={`chip-toggle${m.config.rules.annImportantOnly ? ' on' : ''}`}
              onClick={() => setRule({ annImportantOnly: !m.config.rules.annImportantOnly })}
              title="关闭后会连说明会、人事变动、例行披露一起报，容易刷屏"
            >
              公告只报重要动作
            </button>
          </div>
          <div className="mon-form-row">
            <CtrlGroup label="快讯多源策略">
              {(['primary', 'rotate', 'all'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`chip-toggle${m.config.flashStrategy === k ? ' on' : ''}`}
                  onClick={() => setCfg({ flashStrategy: k })}
                  title={{ primary: '财联社为主，失败切备源，低频交叉补一次', rotate: '每轮只拉一个源并轮换，请求量不变', all: '三源齐发，请求量约 ×3' }[k]}
                >
                  {{ primary: '主源优先', rotate: '轮流', all: '三源齐发' }[k]}
                </button>
              ))}
            </CtrlGroup>
            <CtrlGroup label="快讯交叉间隔（轮）">
              <input className="mon-input" type="number" min={0} max={60} value={m.config.crossEvery}
                onChange={(e) => setCfg({ crossEvery: Number(e.target.value) })} />
            </CtrlGroup>
            <CtrlGroup label="行情交叉验证（轮）">
              <input className="mon-input" type="number" min={0} max={60} value={m.config.verifyEvery}
                onChange={(e) => setCfg({ verifyEvery: Number(e.target.value) })} />
            </CtrlGroup>
            <button type="button" className={`chip-toggle${m.config.adaptive ? ' on' : ''}`}
              onClick={() => setCfg({ adaptive: !m.config.adaptive })}
              title="休市 ×3、后台标签页 ×4 自动拉长轮询间隔">
              休市/后台自动降频
            </button>
          </div>
        </div>
        <div className="inst-hint">
          首次轮询只建立基线、不产生事件；行情用「阈值穿越」而非「当前状态」，所以一只票一直涨 4% 不会每 30 秒报一次。
          跳变按分钟分桶去重，剧烈波动时最多每分钟一条。
          <b style={{ color: 'var(--amber)' }}>「三源齐发」会把快讯请求量放大约 3 倍</b>，仅在需要最大覆盖面时开启。
        </div>
      </Panel>

      {/* ===== 监控标的 ===== */}
      <Panel
        title={`⭐ 监控标的 ${m.targets.length} 只`}
        icon="⭐"
        desc="A 股 / 港股 / 美股 / 日股 / 韩股通用：腾讯批量报价一次拿全；公告按市场走各自数据源"
        extra={
          <button type="button" className="gear-btn" onClick={importWatchlist} title="从「自选池」导入未添加的标的">
            ⬇ 导入自选池
          </button>
        }
      >
        <div style={{ position: 'relative', maxWidth: 460, marginBottom: 12 }}>
          <input
            type="text"
            placeholder="添加标的：名称或代码，如 英伟达 / 00700 / 7203"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              width: '100%',
              border: '1px solid var(--border-strong)',
              borderRadius: 8,
              padding: '9px 12px',
              fontSize: 13.5,
              outline: 'none',
              background: 'var(--panel-2)',
              color: 'var(--text)'
            }}
          />
          {showDrop && (
            <div className="search-pop">
              {hits.map((h) => (
                <div key={h.code} className="search-item" onMouseDown={() => add(h)}>
                  <span className="badge info">{h.marketLabel}</span>
                  <b>{h.name}</b>
                  <span className="code">{h.code}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {!m.targets.length ? (
          <EmptyTip text="还没有监控标的，搜索添加或从自选池导入" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>标的</th>
                  <th>市场</th>
                  <th>现价</th>
                  <th>涨跌幅</th>
                  <th>今日区间</th>
                  <th>行情时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {m.targets.map((t) => {
                  const q = quoteMap.get(t.code);
                  const up = (q?.chgPct ?? 0) >= 0;
                  return (
                    <tr key={t.code}>
                      <td>
                        <b>{t.name}</b> <span className="code">{t.code}</span>
                      </td>
                      <td>{t.marketLabel}</td>
                      <td className="num">{q ? `${q.price} ${q.currency}` : '—'}</td>
                      <td className="num" style={{ color: q ? (up ? 'var(--up)' : 'var(--down)') : undefined }}>
                        {q ? `${up ? '+' : ''}${q.chgPct.toFixed(2)}%` : '—'}
                      </td>
                      <td className="num">{q && q.high > 0 ? `${q.low} ~ ${q.high}` : '—'}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{q?.time || '—'}</td>
                      <td>
                        <button type="button" className="gear-btn" onClick={() => m.removeTarget(t.code)} title="移出监控">
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="inst-hint" style={{ marginTop: 8 }}>
          报价来自腾讯行情（GBK，单请求批量）。美股为上一交易日收盘价、日韩为当地交易所最近成交时间，非交易时段不会变化。
        </div>
      </Panel>

      {/* ===== 数据源与限流 ===== */}
      <Panel
        title="🛡️ 数据源与限流防护"
        icon="🛡️"
        desc="每个 host 独立的最小间隔、每分钟预算与失败退避；被保护跳过时沿用上一轮数据，不把源打挂"
        extra={
          <button type="button" className="gear-btn" onClick={m.refreshHealth}>
            🔄 刷新状态
          </button>
        }
      >
        <div className="fund-sec">各数据源最近一次状态（累计至第 {m.round} 轮）</div>
        {!m.sources.length ? (
          <EmptyTip text="等待首轮轮询完成" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>数据源</th><th>状态</th><th>条数</th><th>说明</th></tr>
              </thead>
              <tbody>
                {m.sources.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.label}</b></td>
                    {/* 不用红/绿表示「正常」——在 A 股语境里红涨绿跌会混淆，用中性强调色 */}
                    <td style={{ color: r.ok ? 'var(--accent)' : r.skipped ? 'var(--text-3)' : 'var(--down)' }}>
                      {r.ok ? '✓ 正常' : r.skipped ? '⏸ 保护跳过' : '✕ 失败'}
                    </td>
                    <td className="num">{r.count}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="fund-sec">按 host 的请求预算与健康度</div>
        {!m.health.length ? (
          <EmptyTip text="尚无请求记录" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>host</th><th>请求</th><th>失败</th><th>跳过</th><th>连续失败</th><th>冷却剩余</th><th>最近延迟</th><th>最近错误</th></tr>
              </thead>
              <tbody>
                {m.health.map((h) => {
                  const cool = Math.max(0, h.cooldownUntil - Date.now());
                  return (
                    <tr key={h.host}>
                      <td><b>{h.host}</b></td>
                      <td className="num">{h.requests}</td>
                      <td className="num" style={{ color: h.failures ? 'var(--down)' : undefined }}>{h.failures}</td>
                      <td className="num">{h.throttled}</td>
                      <td className="num">{h.consecutiveFailures}</td>
                      <td className="num" style={{ color: cool > 0 ? 'var(--amber)' : undefined }}>
                        {cool > 0 ? `${Math.ceil(cool / 1000)}s` : '—'}
                      </td>
                      <td className="num">{h.lastLatency ? `${h.lastLatency}ms` : '—'}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{h.lastError || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ===== 事件流 ===== */}
      <Panel
        title={`📋 事件流 ${m.events.length} 条`}
        icon="📋"
        desc="按时间倒序，最多保留 200 条；刷新页面后仍在（本地持久化）"
        extra={<span className="inst-hint">未读 {m.unread} 条</span>}
      >
        <div className="news-chips" style={{ marginBottom: 10 }}>
          {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`chip-toggle${filter === f ? ' on' : ''}`}
              onClick={() => setFilter(f)}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
        </div>

        {!shownEvents.length ? (
          <EmptyTip text={m.events.length ? '当前筛选下没有事件' : '暂无事件：首次轮询正在建立基线，之后只在出现新消息或异动时提醒'} />
        ) : (
          <div className="mon-events">
            {shownEvents.map((e) => (
              <EventRow key={e.id} e={e} onJump={() => e.link && navigate(e.link)} />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="⚠️ 口径与局限（务必先读）" icon="⚠️">
        <ul className="inst-list">
          <li>
            <b>纯前端轮询，不是服务端推送</b>：标签页在后台时浏览器会把定时器节流到约 1 次/分钟；<b>关闭页面后不再监控</b>。
            需要 7×24 常驻请部署服务端定时任务。
          </li>
          <li>
            <b>首次启动不刷屏</b>：第一轮只记录当前已有的快讯与公告 ID 作为基线，从第二轮起才对比增量。
            快照写入 localStorage，刷新后仍能发现「关页面期间」新增的消息；报价快照超过 10 分钟作废，避免隔夜价差被误判成瞬时跳变。
          </li>
          <li>
            <b>行情告警是「事件」不是「信号」</b>：涨跌幅越阈值、瞬时跳变只说明发生了异动，不代表买点或卖点；
            是否值得动手请回到波段 / 抄底 / 估值页面判断。
          </li>
          <li>
            <b>快讯分级与公告标签沿用站内同一套算法</b>（影响力 S/A/B/C、繁简归一、SEC form 枚举、日韩词表），
            所以这里看到的标签和情绪晴雨表、个股分析页一致。
          </li>
          <li>
            <b>公告源有缓存</b>：东财 / SEC / Yahoo JP / Naver 复用适配器自带的 10 分钟缓存，<b>不再强制刷新</b>；
            缓存命中即零请求，监控层另有前置熔断与 400ms 错峰。请求失败会在下一轮自动重试，不会用旧数据冒充新公告。
          </li>
          <li>
            <b>桌面通知</b>需要浏览器授权；权限被拒绝时只能靠顶栏红点与页面内事件流。提示音只在出现「重要」级别事件时响。
          </li>
          <li>
            <b>防限流</b>：每个 host 有独立最小间隔与每分钟预算，429/403/5xx/超时会触发指数退避（最长 5 分钟）并进入冷却；
            冷却期内直接复用上一轮快照。公告已取消强制刷新，改用适配器自带的 10 分钟缓存，命中即零请求。
          </li>
          <li>
            <b>多源策略</b>：行情腾讯为主（五市场），东财 / 新浪（A·港·美）、Naver（韩）、Yahoo JP（日）为备，仅在主源失效时补齐，
            平时低频交叉验证；快讯财联社为主，新浪 7×24 与东财快讯为备。默认策略每轮请求量约 1~2 次，不会三源齐发。
          </li>
          <li>
            <b>交易时段感知</b>：所有监控市场都休市时轮询间隔 ×3，后台标签页 ×4；休市期间仍在低频监听消息面（盘后公告与政策一样重要）。
          </li>
        </ul>
      </Panel>
    </>
  );
}

function EventRow({ e, onJump }: { e: MonitorEvent; onJump: () => void }) {
  const fresh = Date.now() - e.ts < 10 * 60 * 1000;
  return (
    <div className={`mon-event lv-${e.level}${fresh ? ' fresh' : ''}`}>
      <span className="me-time">{formatClock(e.ts)}</span>
      <span className={`me-level ${e.level}`}>{EVENT_LEVEL_LABEL[e.level]}</span>
      <span className="me-kind" title={EVENT_KIND_LABEL[e.kind]}>
        {KIND_ICON[e.kind]} {EVENT_KIND_LABEL[e.kind]}
      </span>
      <div className="me-body">
        <div className="me-title">{e.title}</div>
        <div className="me-detail">{e.detail}</div>
      </div>
      {e.link && (
        <button type="button" className="gear-btn me-jump" onClick={onJump}>
          查看 →
        </button>
      )}
    </div>
  );
}
