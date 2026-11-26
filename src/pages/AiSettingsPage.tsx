import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  AI_PRESETS,
  DEFAULT_AI_CONFIG,
  loadAiConfig,
  maskKey,
  normalizeBaseUrl,
  saveAiConfig,
  validateAiConfig,
  type AiConfig
} from '../ai/config';
import { callGeneralAnalysis } from '../ai/general';
import { MathPanel, Panel } from '../components/ui';

const inputStyle: CSSProperties = {
  border: '1px solid var(--border-strong)',
  borderRadius: 8,
  padding: '9px 11px',
  fontSize: 13.5,
  outline: 'none',
  background: 'var(--panel-2)',
  color: 'var(--text)',
  width: '100%',
  boxSizing: 'border-box'
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 12.5,
  color: 'var(--text-3)',
  marginBottom: 12
};

/** 清除本机配置：把存储项移除并写回默认值 */
function clearLocalConfig(): void {
  try {
    localStorage.removeItem('mq.ai.config.v1');
  } catch {
    /* 隐私模式忽略 */
  }
}

export default function AiSettingsPage() {
  const [cfg, setCfg] = useState<AiConfig>(() => loadAiConfig());
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const cfgError = useMemo(() => validateAiConfig(cfg), [cfg]);

  // 编辑后提示「未保存」；保存写入本机 localStorage
  useEffect(() => {
    setSaved(false);
    setTestMsg(null);
  }, [cfg.baseUrl, cfg.apiKey, cfg.model, cfg.temperature]);

  const pickPreset = (label: string) => {
    const p = AI_PRESETS.find((x) => x.label === label);
    if (!p) return;
    setCfg((c) => ({ ...c, baseUrl: p.baseUrl, model: p.model }));
  };

  const doSave = () => {
    saveAiConfig(cfg);
    setSaved(true);
  };

  const doClear = () => {
    clearLocalConfig();
    setCfg({ ...DEFAULT_AI_CONFIG });
    setReveal(false);
    setSaved(false);
    setTestMsg('已清除本机配置');
  };

  const doTest = async () => {
    if (cfgError) {
      setTestMsg(cfgError);
      return;
    }
    setTesting(true);
    setTestMsg(null);
    const snapshot = {
      module: '连接测试',
      facts: [{ label: '状态', value: '这是一条连通性测试，请只回复“连接正常”四个字' }]
    };
    try {
      const res = await callGeneralAnalysis(cfg, snapshot, [], '请回复“连接正常”');
      setTestMsg(res.ok ? '✅ 连接正常，模型已返回响应' : '❌ ' + (res.error ?? '未知错误'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <div className="page-title-row">
        <h2>⚙️ AI 设置</h2>
        <span className="en">AI Settings · Local Only</span>
      </div>
      <p className="page-lead">
        配置供全站「AI 分析」按钮使用的 OpenAI 兼容模型。<b>所有配置只保存在你当前浏览器</b>，
        不上传本站服务器、不写进分享链接、不写入代码仓库、不记录日志；换设备或换浏览器需重新配置，
        别人打开同一个链接也看不到你的配置。<b>本站不会共用任何人的 Key。</b>
      </p>

      <div className="panel notice" style={{ borderColor: 'var(--up)' }}>
        <div className="panel-title">🔒 隐私承诺</div>
        <div className="panel-desc" style={{ lineHeight: 2 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>API Key 仅存本机 <code>localStorage</code>，刷新页面仍在，但不会随网址分享、不进入任何日志。</li>
            <li>调用时由你的浏览器<b>直接请求你填写的 API 地址</b>；本站服务器不保存、不中转、不记录你的 Key。</li>
            <li>同一链接的其他访问者各用各的浏览器，<b>互相看不到配置，也不共用</b>。</li>
            <li>Key 在界面上以掩码显示，输入框为密码类型，关闭「AI 设置」页不留存明文。</li>
            <li>清除浏览器站点数据会一并删除配置；公开电脑上用完建议点「清除配置」。</li>
          </ul>
        </div>
      </div>

      <Panel title="模型配置" icon="🧩" desc="支持任意 OpenAI 兼容的 chat completions 服务；预设可一键填入常用地址与模型名">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          {AI_PRESETS.map((p) => (
            <button key={p.label} type="button" className="chip-toggle" title={p.note} onClick={() => pickPreset(p.label)}>
              {p.label}
            </button>
          ))}
        </div>

        <label style={labelStyle}>
          API 地址（OpenAI 兼容 chat completions 根地址）
          <input
            style={inputStyle}
            value={cfg.baseUrl}
            onChange={(e) => setCfg((c) => ({ ...c, baseUrl: e.target.value }))}
            placeholder="https://api.deepseek.com"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label style={labelStyle}>
          API Key（仅存本机，输入后以掩码显示）
          <input
            style={inputStyle}
            type={reveal ? 'text' : 'password'}
            value={cfg.apiKey}
            onChange={(e) => setCfg((c) => ({ ...c, apiKey: e.target.value }))}
            placeholder="sk-..."
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: -6, marginBottom: 14 }}>
          {cfg.apiKey ? '当前 Key：' + maskKey(cfg.apiKey) : '未填写'}
          {' · '}
          <button type="button" className="ai-inline-link" onClick={() => setReveal((v) => !v)}>
            {reveal ? '隐藏明文' : '临时显示明文'}
          </button>
        </div>

        <label style={labelStyle}>
          模型名
          <input
            style={inputStyle}
            value={cfg.model}
            onChange={(e) => setCfg((c) => ({ ...c, model: e.target.value }))}
            placeholder="deepseek-chat"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <label style={labelStyle}>
          温度（越小越稳定，越大越发散）：{cfg.temperature.toFixed(1)}
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={cfg.temperature}
            onChange={(e) => setCfg((c) => ({ ...c, temperature: Number(e.target.value) }))}
            style={{ width: '100%', marginTop: 8 }}
          />
        </label>

        {cfgError && <div style={{ fontSize: 12.5, color: 'var(--down)', marginBottom: 10 }}>{cfgError}</div>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="chip-toggle" onClick={doSave}>💾 保存到本机</button>
          <button type="button" className="chip-toggle" onClick={() => void doTest()} disabled={testing || !!cfgError}>
            {testing ? '测试中…' : '🔌 测试连接'}
          </button>
          <button type="button" className="chip-toggle" onClick={doClear}>🗑️ 清除配置</button>
          {saved && <span style={{ fontSize: 12.5, color: 'var(--up)' }}>✅ 已保存到当前浏览器</span>}
        </div>
        {testMsg && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: testMsg.startsWith('✅') ? 'var(--up)' : 'var(--down)', lineHeight: 1.7 }}>
            {testMsg}
          </div>
        )}
        <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.8 }}>
          当前地址：{normalizeBaseUrl(cfg.baseUrl) || '（未填写）'}。若浏览器直连被 CORS 拦截，可把地址改为同源 <code>/ai</code>（本地开发服务器已内置代理）。
        </div>
      </Panel>

      <MathPanel>
        <div style={{ fontSize: 13, lineHeight: 2, color: 'var(--text-2)' }}>
          <p><b>存储</b>：配置写入浏览器 <code>localStorage</code> 的 <code>mq.ai.config.v1</code> 键，仅本站点、本浏览器可读。</p>
          <p><b>传输</b>：点击页面上的「AI 分析」时，浏览器把事实快照与你的问题直接 POST 到你填写的 <code>baseUrl/chat/completions</code>，请求头带 <code>Authorization: Bearer &lt;你的 Key&gt;</code>；本站服务器既不接收也不保存该请求。</p>
          <p><b>隔离</b>：Key 不进入 URL、不写入仓库、不写日志、不随分享链接传播；每个浏览器各自独立，不构成共用。</p>
          <p><b>只读</b>：通用 AI 分析不传 tools，模型没有可调用的改参/切标工具，只能基于快照做解释。</p>
        </div>
      </MathPanel>

      <Panel title="⚠️ 使用边界" icon="⚠️">
        <div style={{ fontSize: 13, lineHeight: 2.1, color: 'var(--text-2)' }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>请自行注册模型服务并获取 Key，费用与配额由你与服务方直接结算，本站不涉及。</li>
            <li>AI 输出基于页面已有的近似指标，可能出错，务必自行复核；仅供学习研究，不构成投资建议。</li>
            <li>在公用电脑上用完请点「清除配置」，避免下一位使用者看到你的 Key（虽然它只在这台浏览器）。</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
