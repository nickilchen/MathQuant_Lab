/** 浏览器环境下的本地代理回退（server.mjs 或 vite dev 提供 /px/{host}/{path}） */
import type { KlineSource } from './types';

export const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

/** 生成本地代理路径 */
export function px(host: string, path: string): string {
  return `/px/${host}${path}`;
}

export type { KlineSource };
