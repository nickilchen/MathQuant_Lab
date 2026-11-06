import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './hooks/AppContext';
import { MonitorProvider } from './hooks/MonitorContext';
import { applyTheme, readStoredTheme } from './theme';
import { syncPalette } from './components/chartOptions';
import './styles.css';
import './styles-tools.css';

// 首帧之前先把主题写到 <html data-theme> 并同步图表色板，
// 避免刷新时闪一下默认配色，也保证第一张图拿到的是当前主题的颜色。
const bootTheme = readStoredTheme();
applyTheme(bootTheme);
syncPalette();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AppProvider>
        <MonitorProvider>
          <App />
        </MonitorProvider>
      </AppProvider>
    </HashRouter>
  </React.StrictMode>
);
