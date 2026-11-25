/**
 * 生产用本地服务器：静态托管 dist/ + 转发韩国数据（Naver 无 CORS 头）
 *   + /px/{host}/{path} 通用行情代理 + /ai 同源 AI 代理（与 vite.config.ts 对齐）。
 * 用法：npm run build && npm run serve  → http://localhost:4173
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
// Node 原生 fetch 不读取 HTTP_PROXY/HTTPS_PROXY 环境变量；
// 企业内网 / 代理网关环境下需要显式设置全局 ProxyAgent（无代理环境时为无副作用空操作）
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const envProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
if (envProxy) {
  setGlobalDispatcher(new ProxyAgent(envProxy));
  console.log(`[proxy] 上游请求经代理: ${envProxy}`);
}

const PORT = Number(process.env.PORT ?? 4173);
// URL pathname 会百分号编码（中文路径），需 decode
const DIST = decodeURIComponent(new URL('./dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PROXY_PREFIX = '/naver-api';
const NAVER = 'https://api.finance.naver.com';

/** AI 同源代理：/ai/{path} → AI_TARGET/{path}，与 vite.config.ts 的 /ai 对齐。
 *  target 固定（环境变量可覆盖），不接受客户端指定 host，避免成为开放代理；
 *  AI_PROXY_TARGET 末尾斜杠统一去掉，拼接路径时不会出现双斜杠。 */
const AI_PREFIX = '/ai';
const AI_TARGET = (process.env.AI_PROXY_TARGET || 'https://api.deepseek.com').replace(/\/+$/, '');

/** 通用代理白名单：/px/{host}/{path} → https://{host}/{path} */
const PX_PREFIX = '/px/';
const PX_HOSTS = new Set([
  'web.ifzq.gtimg.cn',
  'qt.gtimg.cn',
  'hq.sinajs.cn',
  'zhibo.sina.com.cn',
  'np-listapi.eastmoney.com',
  'm.stock.naver.com',
  'push2his.eastmoney.com',
  'push2.eastmoney.com',
  'push2ex.eastmoney.com',
  'api.finance.naver.com',
  'searchapi.eastmoney.com',
  'datacenter-web.eastmoney.com',
  'guba.eastmoney.com',
  'mguba.eastmoney.com',
  'www.tgb.cn',
  'www.cls.cn',
  'emappdata.eastmoney.com',
  'emweb.securities.eastmoney.com',
  'np-anotice-stock.eastmoney.com',
  'www.sec.gov',
  'data.sec.gov',
  'finance.yahoo.co.jp',
  'api.stock.naver.com',
  'quotes.sina.cn',
  'stock.finance.sina.com.cn',
  'vip.stock.finance.sina.com.cn',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'stockanalysis.com'
]);

/** SEC 要求 UA 声明应用与联系方式，浏览器 UA 不合规 */
const SEC_UA = 'MathQuantLab/0.1 (research tool; contact: mathquant@example.com)';
const USER_AGENT = {
  'www.sec.gov': SEC_UA,
  'data.sec.gov': SEC_UA
};

/** 部分站点校验 Referer，按 host 指定 */
const REFERER = {
  'quotes.sina.cn': 'https://finance.sina.com.cn',
  'stock.finance.sina.com.cn': 'https://finance.sina.com.cn',
  'vip.stock.finance.sina.com.cn': 'https://finance.sina.com.cn',
  'query1.finance.yahoo.com': 'https://finance.yahoo.com/',
  'query2.finance.yahoo.com': 'https://finance.yahoo.com/',
  'api.finance.naver.com': 'https://finance.naver.com/',
  'datacenter-web.eastmoney.com': 'https://data.eastmoney.com/',
  'guba.eastmoney.com': 'https://guba.eastmoney.com/',
  'mguba.eastmoney.com': 'https://guba.eastmoney.com/',
  'www.tgb.cn': 'https://www.tgb.cn/',
  'www.cls.cn': 'https://www.cls.cn/telegraph',
  'hq.sinajs.cn': 'https://finance.sina.com.cn/',
  'zhibo.sina.com.cn': 'https://finance.sina.com.cn/7x24/',
  'np-listapi.eastmoney.com': 'https://kuaixun.eastmoney.com/',
  'm.stock.naver.com': 'https://m.stock.naver.com/',
  'emappdata.eastmoney.com': 'https://guba.eastmoney.com/',
  'emweb.securities.eastmoney.com': 'https://emweb.securities.eastmoney.com/',
  'np-anotice-stock.eastmoney.com': 'https://data.eastmoney.com/',
  'stockanalysis.com': 'https://stockanalysis.com/',
  'finance.yahoo.co.jp': 'https://finance.yahoo.co.jp/',
  'api.stock.naver.com': 'https://m.stock.naver.com/'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // ---- Naver 代理（兼容旧路径） ----
  if (url.pathname.startsWith(PROXY_PREFIX)) {
    try {
      const target = `${NAVER}${url.pathname.slice(PROXY_PREFIX.length)}${url.search}`;
      const upstream = await fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' }
      });
      const body = await upstream.text();
      res.writeHead(upstream.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`naver proxy error: ${String(e)}`);
    }
    return;
  }

  // ---- 通用代理：/px/{host}/{path} ----
  if (url.pathname.startsWith(PX_PREFIX)) {
    const rest = url.pathname.slice(PX_PREFIX.length);
    const slash = rest.indexOf('/');
    const host = slash > 0 ? rest.slice(0, slash) : '';
    const path = slash > 0 ? rest.slice(slash) : '/';
    if (!PX_HOSTS.has(host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('host not allowed');
      return;
    }
    try {
      const upstream = await fetch(`https://${host}${path}${url.search}`, {
        headers: {
          'User-Agent': USER_AGENT[host] ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
          Referer: REFERER[host] ?? `https://${host}/`
        }
      });
      // 必须按字节透传：部分上游（新浪行业页 newSinaHy.php 等）是 GBK 编码，
      // 若用 upstream.text() 会先按 UTF-8 解码成 U+FFFD，字节不可逆损坏；
      // 前端 getGbk() 用 TextDecoder('gbk') 自行解码，这里只负责原样搬运字节。
      // undici 已自动处理 gzip/br 解压，arrayBuffer() 拿到的是解压后的原始字节。
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`px proxy error: ${String(e)}`);
    }
    return;
  }

  // ---- AI 同源代理（与 vite.config.ts 的 /ai 对齐）----
  // 与只读的 /px 不同：/ai 是 POST + Bearer Key + JSON body，且上游可能返回
  // SSE 流式响应，因此透传方法与头、流式回写而不整体缓冲。
  if (url.pathname === AI_PREFIX || url.pathname.startsWith(AI_PREFIX + '/')) {
    // 预检：同源请求一般不需要，但自定义 Authorization 场景下浏览器可能发 OPTIONS
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }
    try {
      const rest = url.pathname.slice(AI_PREFIX.length); // '' 或 '/chat/completions'
      const target = `${AI_TARGET}${rest || '/'}${url.search}`;
      // 收集请求体（POST /chat/completions 的 JSON）
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = {
        'Content-Type': req.headers['content-type'] || 'application/json'
      };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      if (req.headers.accept) headers.Accept = req.headers.accept;
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
      });
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      // 流式转发（兼容 stream:true 的 SSE）；fromWeb 需要 ReadableStream，Node>=20 支持
      if (upstream.body) {
        Readable.fromWeb(upstream.body).pipe(res);
      } else {
        res.end();
      }
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`ai proxy error: ${String(e)}`);
      } else {
        res.destroy();
      }
    }
    return;
  }

  // ---- 静态文件（SPA 回退 index.html） ----
  let filePath = normalize(join(DIST, url.pathname));
  if (!filePath.startsWith(normalize(DIST))) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    let body = await readFile(filePath);
    if (extname(filePath) === '') {
      body = await readFile(join(DIST, 'index.html'));
      filePath = join(DIST, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found（先执行 npm run build）');
    }
  }
});

server.listen(PORT, () => {
  console.log(`MathQuant Lab → http://localhost:${PORT}  (dist/ + /px 行情代理 + /ai AI 代理)`);
});
