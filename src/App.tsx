import { NavLink, Route, Routes } from 'react-router-dom';
import Overview from './pages/Overview';
import StrategyPage from './pages/StrategyPage';
import StockPage from './pages/StockPage';
import TPage from './pages/TPage';
import SwingPage from './pages/SwingPage';
import MonitorPage from './pages/MonitorPage';
import ValuationPage from './pages/ValuationPage';
import InstitutionsPage from './pages/InstitutionsPage';
import SentimentPage from './pages/SentimentPage';
import WatchlistPage from './pages/WatchlistPage';
import ComparePage from './pages/ComparePage';
import MomentumPage from './pages/MomentumPage';
import HmmPage from './pages/HmmPage';
import FactorPage from './pages/FactorPage';
import VolPage from './pages/VolPage';
import RiskParityPage from './pages/RiskParityPage';
import PcaPage from './pages/PcaPage';
import MlPage from './pages/MlPage';
import HeaderBar from './components/HeaderBar';
import ErrorBoundary from './components/ErrorBoundary';

const NAV = [
  { path: '/', icon: '📊', label: '总览 Dashboard' },
  { path: '/strategy', icon: '🎯', label: '策略信号' },
  { path: '/stock', icon: '🔍', label: '个股分析' },
  { path: '/t', icon: '🔁', label: '做 T 分析' },
  { path: '/swing', icon: '📈', label: '波段 · 抄底' },
  { path: '/valuation', icon: '💎', label: '价值估值评断' },
  { path: '/sentiment', icon: '🌡️', label: '情绪晴雨表' },
  { path: '/institutions', icon: '🏛️', label: '机构持仓分析' },
  { path: '/monitor', icon: '🔔', label: '实时监控' },
  { path: '/watchlist', icon: '⭐', label: '自选池 · 批量体检' },
  { path: '/compare', icon: '🆚', label: '多标的对比' },
  { path: '/momentum', icon: '🚀', label: '动能动量策略' },
  { path: '/hmm', icon: '🧠', label: 'HMM 市场状态' },
  { path: '/factors', icon: '🗳️', label: '因子投票择时' },
  { path: '/vol', icon: '🌊', label: '波动率模型' },
  { path: '/riskparity', icon: '⚖️', label: '风险平价' },
  { path: '/pca', icon: '🧬', label: 'PCA 统计套利' },
  { path: '/ml', icon: '🤖', label: '机器学习 MLP' }
];

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">📐</span>
          <div>
            <div className="brand-name">MathQuant Lab</div>
            <div className="brand-sub">数学模型股市分析终端</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.path} to={n.path} end={n.path === '/'} className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
              <span className="nav-icon">{n.icon}</span>
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="foot-title">模型覆盖</div>
          <div className="foot-tags">
            <span>情绪六维</span><span>HMM</span><span>因子投票</span><span>GARCH</span><span>ERC</span><span>HRP</span><span>PCA</span><span>MLP</span>
          </div>
          <div className="foot-title" style={{ marginTop: 10 }}>市场覆盖</div>
          <div className="foot-tags">
            <span>A股</span><span>港股</span><span>美股</span><span>日股</span><span>韩股</span>
          </div>
        </div>
      </aside>
      <div className="main">
        <HeaderBar />
        <main className="content">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/strategy" element={<StrategyPage />} />
              <Route path="/stock" element={<StockPage />} />
              <Route path="/t" element={<TPage />} />
              <Route path="/swing" element={<SwingPage />} />
              <Route path="/valuation" element={<ValuationPage />} />
              <Route path="/sentiment" element={<SentimentPage />} />
              <Route path="/monitor" element={<MonitorPage />} />
              <Route path="/institutions" element={<InstitutionsPage />} />
              <Route path="/watchlist" element={<WatchlistPage />} />
              <Route path="/compare" element={<ComparePage />} />
              <Route path="/momentum" element={<MomentumPage />} />
              <Route path="/hmm" element={<HmmPage />} />
              <Route path="/factors" element={<FactorPage />} />
              <Route path="/vol" element={<VolPage />} />
              <Route path="/riskparity" element={<RiskParityPage />} />
              <Route path="/pca" element={<PcaPage />} />
              <Route path="/ml" element={<MlPage />} />
              <Route path="*" element={<Overview />} />
            </Routes>
          </ErrorBoundary>
          <footer className="disclaimer">
            ⚠️ 本站所有模型与回测仅供学习研究，不构成任何投资建议。回测未充分考虑涨跌停、融券可得性、流动性冲击与税费细节，历史表现不代表未来收益。
            覆盖市场：A股 / 港股 / 美股 / 日股 / 韩股（韩国数据来自 Naver，经本地代理或公共 CORS 代理转发）；
            跨境指数的资金流向因子不可用，已自动剔除。
          </footer>
        </main>
      </div>
    </div>
  );
}
