/** AI 配置：存 localStorage，不写进代码或仓库 */
export interface AiConfig {
  /** OpenAI 兼容的 chat completions 根地址 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

const STORE_KEY = 'mq.ai.config.v1';

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.3
};

export interface AiPreset {
  label: string;
  baseUrl: string;
  model: string;
  note: string;
}

export const AI_PRESETS: AiPreset[] = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', note: '性价比高，中文金融理解好' },
  { label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', note: '长上下文' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', note: '通用能力强' },
  { label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', note: '完全本地，无需联网' }
];

/** 去掉首尾空白与尾部斜杠 */
export function normalizeBaseUrl(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  return s.replace(/\/+$/, '');
}

/** 拼接 chat completions 地址 */
export function chatUrl(cfg: AiConfig): string {
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!base) return '';
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

/** 校验配置，返回人话错误；通过返回 null */
export function validateAiConfig(cfg: AiConfig): string | null {
  const base = normalizeBaseUrl(cfg.baseUrl);
  if (!base) return '请填写 API 地址';
  if (!/^https?:\/\//.test(base)) return 'API 地址需以 http:// 或 https:// 开头';
  if (!cfg.apiKey.trim()) return '请填写 API Key';
  if (!cfg.model.trim()) return '请填写模型名';
  return null;
}

export function loadAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_AI_CONFIG };
    const o = JSON.parse(raw) as Partial<AiConfig>;
    return {
      baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : DEFAULT_AI_CONFIG.baseUrl,
      apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
      model: typeof o.model === 'string' ? o.model : DEFAULT_AI_CONFIG.model,
      temperature: typeof o.temperature === 'number' ? o.temperature : DEFAULT_AI_CONFIG.temperature
    };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

export function saveAiConfig(cfg: AiConfig): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
  } catch {
    /* 隐私模式写入失败，忽略 */
  }
}

/** 掩码显示 Key，避免截图泄露 */
export function maskKey(k: string): string {
  const s = (k || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '*'.repeat(Math.min(12, s.length - 8)) + s.slice(-4);
}
