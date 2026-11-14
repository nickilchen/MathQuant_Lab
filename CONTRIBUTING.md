# 贡献指南

欢迎参与 MathQuant Lab。这是一个**纯前端、零业务后端**的数学模型项目，所有计算都在浏览器里完成，因此贡献主要集中在数学引擎、数据适配与可视化。

## 环境要求

- Node.js ≥ 20（CI 使用 22）
- npm（仓库自带 `package-lock.json`，请用它安装以保证版本一致）

```bash
git clone https://github.com/nickilchen/MathQuant_Lab.git
cd MathQuant_Lab
npm ci
npm run dev          # 开发态，带 /px/ 本地代理，端口 5173
```

生产预览：`npm run build && npm run serve`（`server.mjs` 提供静态托管 + 代理，默认 4173）。

## 提交前的验证链

请按**顺序**全部跑通再提 PR：

```bash
npm test             # vitest run --pool=threads
npm run typecheck    # tsc --noEmit
npm run build        # 含类型检查 + vite build
```

`npm test` 使用 `--pool=threads`：本项目测试文件较多，默认的进程池在部分 Windows 沙箱里会触发并发写 `EPERM`。

## 代码约定

1. **先 math，再 pipeline，最后页面**：`src/math/` 必须是无 UI、无网络依赖的纯函数；`src/pipelines/` 负责把行情喂给模型；`src/pages/` 只做展示与交互。改模型请先改纯函数并补单测。
2. **测试与实现同批提交**：`tests/` 下按模块命名，覆盖边界值、空数据、阈值边界与「无未来函数」。
3. **不许伪造行情**：个股分析使用 `allowDemo=false`，实时源全部失败时页面必须显示「实时行情暂不可达」并提供重试；指数类页面降级到模拟数据时必须显著标注 DEMO。
4. **请求禁用 HTTP 缓存**：所有行情请求带 `cache: 'no-store'`。
5. **新增数据源**：在 `src/data/sources/` 实现 `KlineSource { canHandle, fetch }` 并注册到 `registry.ts`；无 CORS 的接口同时把 host 加进 `server.mjs` 与 `vite.config.ts` 的 `/px/` 白名单。
6. **涨红跌绿**：A 股习惯，涨用红色、跌用绿色；负仓位代表可做空。
7. **回测成本**默认佣金万 2.5 双边 + 卖出印花税千 1，可在顶栏调整。

## 不进入仓库的内容

`node_modules/`、`dist/`、`tmp/`、`.env*`、`coverage/`、`design-prototypes/`、临时冒烟脚本与截图已在 `.gitignore` 中排除。仓库**不含任何 API Key、token 或用户数据**；AI 相关配置只存在使用者本机浏览器的 `localStorage`。

## PR 检查清单

- [ ] 三条验证命令全绿
- [ ] 新增/修改的数学模型有对应单测
- [ ] 未在代码中写入密钥、内网地址或个人邮箱
- [ ] 若改动了模型口径，同步更新 README 的数学模型说明
- [ ] 若新增页面，说明它属于哪个市场、数据不足时如何降级

## 问题反馈

功能建议与数据源可用性请用 [Issues](https://github.com/nickilchen/MathQuant_Lab/issues)；涉及凭据泄露等安全问题请走 [SECURITY.md](./SECURITY.md) 的私有渠道。
