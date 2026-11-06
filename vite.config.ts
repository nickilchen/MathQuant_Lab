/// <reference types="node" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    host: true,
    // 韩国数据（Naver）无 CORS 头 + 通用本地代理回退（浏览器直连失败时兜底）
    proxy: {
      // AI 代理：浏览器同源调用，规避多数供应商不返回 CORS 头
      // 目标可用环境变量 AI_PROXY_TARGET 覆盖
      '/ai': {
        target: process.env.AI_PROXY_TARGET || 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ai/, '')
      },
      '/naver-api': {
        target: 'https://api.finance.naver.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/naver-api/, '')
      },
      // 多源实时监控：新浪行情 / 新浪 7×24 / 东财快讯 / Naver 韩股报价，均校验 Referer
      '/px/hq.sinajs.cn': {
        target: 'https://hq.sinajs.cn',
        changeOrigin: true,
        headers: { Referer: 'https://finance.sina.com.cn/' },
        rewrite: (path) => path.replace(/^\/px\/hq\.sinajs\.cn/, '')
      },
      '/px/zhibo.sina.com.cn': {
        target: 'https://zhibo.sina.com.cn',
        changeOrigin: true,
        headers: { Referer: 'https://finance.sina.com.cn/7x24/' },
        rewrite: (path) => path.replace(/^\/px\/zhibo\.sina\.com\.cn/, '')
      },
      '/px/np-listapi.eastmoney.com': {
        target: 'https://np-listapi.eastmoney.com',
        changeOrigin: true,
        headers: { Referer: 'https://kuaixun.eastmoney.com/' },
        rewrite: (path) => path.replace(/^\/px\/np-listapi\.eastmoney\.com/, '')
      },
      '/px/m.stock.naver.com': {
        target: 'https://m.stock.naver.com',
        changeOrigin: true,
        headers: { Referer: 'https://m.stock.naver.com/' },
        rewrite: (path) => path.replace(/^\/px\/m\.stock\.naver\.com/, '')
      },
      '/px/qt.gtimg.cn': {
        target: 'https://qt.gtimg.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/qt\.gtimg\.cn/, '')
      },
      '/px/web.ifzq.gtimg.cn': {
        target: 'https://web.ifzq.gtimg.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/web\.ifzq\.gtimg\.cn/, '')
      },
      '/px/push2his.eastmoney.com': {
        target: 'https://push2his.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/push2his\.eastmoney\.com/, '')
      },
      '/px/push2ex.eastmoney.com': {
        target: 'https://push2ex.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/push2ex\.eastmoney\.com/, '')
      },
      '/px/push2.eastmoney.com': {
        target: 'https://push2.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/push2\.eastmoney\.com/, '')
      },
      '/px/api.finance.naver.com': {
        target: 'https://api.finance.naver.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/api\.finance\.naver\.com/, '')
      },
      '/px/searchapi.eastmoney.com': {
        target: 'https://searchapi.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/searchapi\.eastmoney\.com/, '')
      },
      // 机构持仓：数据中心报表 + F10 股东研究（均无 CORS 头）
      '/px/guba.eastmoney.com': {
        target: 'https://guba.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/guba\.eastmoney\.com/, '')
      },
      '/px/www.cls.cn': {
        target: 'https://www.cls.cn',
        changeOrigin: true,
        headers: {
          Referer: 'https://www.cls.cn/telegraph',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'
        },
        rewrite: (path) => path.replace(/^\/px\/www\.cls\.cn/, '')
      },
      '/px/www.tgb.cn': {
        target: 'https://www.tgb.cn',
        changeOrigin: true,
        // 淘股吧校验 Referer（浏览器 fetch 不允许设置该头），必须在代理层注入
        headers: {
          Referer: 'https://www.tgb.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'
        },
        rewrite: (path) => path.replace(/^\/px\/www\.tgb\.cn/, '')
      },
      '/px/mguba.eastmoney.com': {
        target: 'https://mguba.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/mguba\.eastmoney\.com/, '')
      },
      '/px/emappdata.eastmoney.com': {
        target: 'https://emappdata.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/emappdata\.eastmoney\.com/, '')
      },
      '/px/datacenter-web.eastmoney.com': {
        target: 'https://datacenter-web.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/datacenter-web\.eastmoney\.com/, '')
      },
      '/px/emweb.securities.eastmoney.com': {
        target: 'https://emweb.securities.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/emweb\.securities\.eastmoney\.com/, '')
      },
      // 日股適時開示：Yahoo!ファイナンス 个股披露页（HTML）
      '/px/finance.yahoo.co.jp': {
        target: 'https://finance.yahoo.co.jp',
        changeOrigin: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
          Accept: 'text/html'
        },
        rewrite: (path) => path.replace(/^\/px\/finance\.yahoo\.co\.jp/, '')
      },
      // 韩股新闻：Naver 股票 API，校验 Referer
      '/px/api.stock.naver.com': {
        target: 'https://api.stock.naver.com',
        changeOrigin: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
          Referer: 'https://m.stock.naver.com/'
        },
        rewrite: (path) => path.replace(/^\/px\/api\.stock\.naver\.com/, '')
      },
      // 美股 SEC：要求 User-Agent 声明应用与联系方式（浏览器不能自定义 UA，只能在代理层注入）
      '/px/www.sec.gov': {
        target: 'https://www.sec.gov',
        changeOrigin: true,
        headers: {
          'User-Agent': 'MathQuantLab/0.1 (research tool; contact: mathquant@example.com)',
          Accept: 'application/json'
        },
        rewrite: (path) => path.replace(/^\/px\/www\.sec\.gov/, '')
      },
      '/px/data.sec.gov': {
        target: 'https://data.sec.gov',
        changeOrigin: true,
        headers: {
          'User-Agent': 'MathQuantLab/0.1 (research tool; contact: mathquant@example.com)',
          Accept: 'application/json'
        },
        rewrite: (path) => path.replace(/^\/px\/data\.sec\.gov/, '')
      },
      // 海外季度财报（港/美/日/韩）：HTML 页面，无 CORS 头
      '/px/stockanalysis.com': {
        target: 'https://stockanalysis.com',
        changeOrigin: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        rewrite: (path) => path.replace(/^\/px\/stockanalysis\.com/, '')
      },
      // 个股公告（消息面）：无 CORS 头，且校验 Referer
      '/px/np-anotice-stock.eastmoney.com': {
        target: 'https://np-anotice-stock.eastmoney.com',
        changeOrigin: true,
        headers: { Referer: 'https://data.eastmoney.com/' },
        rewrite: (path) => path.replace(/^\/px\/np-anotice-stock\.eastmoney\.com/, '')
      },
      '/px/quotes.sina.cn': {
        target: 'https://quotes.sina.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/quotes\.sina\.cn/, '')
      },
      '/px/vip.stock.finance.sina.com.cn': {
        target: 'https://vip.stock.finance.sina.com.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/vip\.stock\.finance\.sina\.com\.cn/, '')
      },
      '/px/stock.finance.sina.com.cn': {
        target: 'https://stock.finance.sina.com.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/stock\.finance\.sina\.com\.cn/, '')
      },
      '/px/query1.finance.yahoo.com': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/query1\.finance\.yahoo\.com/, '')
      },
      '/px/query2.finance.yahoo.com': {
        target: 'https://query2.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/px\/query2\.finance\.yahoo\.com/, '')
      }
    }
  },
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    sequence: { concurrent: false }
  }
});
