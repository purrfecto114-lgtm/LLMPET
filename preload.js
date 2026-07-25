'use strict';

/**
 * #p24-fix: IPC contextBridge security surface (audit R19).
 *
 * Security contract (enforced by test/preload-contextbridge-security.js):
 *   - contextIsolation: true  (main.js webPreferences — verified by audit)
 *   - nodeIntegration:  false
 *   - sandbox:          true
 *   - Only `contextBridge.exposeInMainWorld` is used to reach the renderer.
 *   - The raw `ipcRenderer` / `require` / `electron` objects are NEVER exposed.
 *   - Every value on the exposed `pet` object is a Function (no primitives or
 *     nested objects holding privileged handles leak into the main world).
 *   - The exact set of exposed keys is locked down by the regression test; any
 *     addition/removal/rename must be a deliberate, reviewed change.
 *
 * `subscribe()` is the only place the renderer registers callbacks. It validates
 * that `cb` is a function before registering, and returns a real unsubscribe
 * closure (a no-op unsubscribe is returned for non-functions so the renderer
 * never throws if it passes garbage).
 *
 * Channel map (renderer -> main):
 *   invoke (request/response):  get-config | get-stats | get-win-pos
 *   send    (fire-and-forget):  open-panel | close-panel | set-mode | set-skin
 *                               | set-budget | set-currency | toggle-mute
 *                               | set-providers | territory-run-now
 *                               | territory-toggle-auto | quit-app | set-win-pos
 *                               | launch-claude | launch-codewhale
 *                               | permission-decide | cw-permission-decide
 *                               | cw-permission-decide-batch | focus-session
 *                               | primary-action | set-ignore-mouse | pet-tall
 *                               | pet-big | set-pet-size | set-panel-height
 *                               | pet-focus | pet-blur | open-log | pet-log
 *                               | ui-busy | pet-visual-bounds
 *
 * Channel map (main -> renderer, via subscribe wrappers):
 *   pet:event | pet:stats | pet:config | panel:stats | panel:config | panel:price
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Register a renderer callback for a main->renderer channel.
 * @param {string} channel - IPC channel name.
 * @param {*} cb - Callback invoked with the event payload (data only, event stripped).
 * @returns {() => void} Unsubscribe function; no-op if `cb` is not a function.
 */
function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('pet', {
  // 主进程 -> 渲染进程
  onEvent: (cb) => subscribe('pet:event', cb),
  onStats: (cb) => subscribe('pet:stats', cb),
  onPanelStats: (cb) => subscribe('panel:stats', cb),
  onConfig: (cb) => {
    const offPet = subscribe('pet:config', cb);
    const offPanel = subscribe('panel:config', cb);
    return () => { offPet(); offPanel(); };
  },
  onPrice: (cb) => subscribe('panel:price', cb),
  // 渲染进程 -> 主进程
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  openPanel: () => ipcRenderer.send('open-panel'),
  closePanel: () => ipcRenderer.send('close-panel'),
  setMode: (m) => ipcRenderer.send('set-mode', m),
  setSkin: (s) => ipcRenderer.send('set-skin', s),
  setBudget: (v) => ipcRenderer.send('set-budget', v),
  setCurrency: (c) => ipcRenderer.send('set-currency', c),
  toggleMute: () => ipcRenderer.send('toggle-mute'),
  // Round 8: provider list toggle
  setProviders: (ids) => ipcRenderer.send('set-providers', ids),
  territoryRunNow: () => ipcRenderer.send('territory-run-now'),
  territoryToggleAuto: () => ipcRenderer.send('territory-toggle-auto'),
  quit: () => ipcRenderer.send('quit-app'),
  // 手动拖动窗口
  getWinPos: () => ipcRenderer.invoke('get-win-pos'),
  setWinPos: (x, y) => ipcRenderer.send('set-win-pos', x, y),
  // 唤起 Claude 客户端
  launchClaude: () => ipcRenderer.send('launch-claude'),
  // W26: 唤起 CodeWhale 客户端（新开按钮按当前 provider 选择）
  launchCodeWhale: () => ipcRenderer.send('launch-codewhale'),
  // 原生授权：通过本地 HTTP server 回 CC 决策（allow/deny），不需按键/Accessibility
  decidePermission: (permId, behavior) => ipcRenderer.send('permission-decide', permId, behavior),
  // Round 7: CodeWhale 权限决策路由到独立 IPC channel
  decideCwPermission: (permId, behavior) => ipcRenderer.send('cw-permission-decide', permId, behavior),
  // W11: CodeWhale 批量授权（均限制在当前会话，且会过期）
  decideCwPermissionBatch: (permId, mode) => ipcRenderer.send('cw-permission-decide-batch', permId, mode),
  // 对话类（继续/选择/方案）：不再替你打字，改为定位并唤起该会话所在的窗口/终端
  focusSession: (sessionId) => ipcRenderer.send('focus-session', sessionId),
  // 左键主操作（非待处理情形）：由后端决定聚焦会话 / 开面板 / 新开 CLI
  primaryAction: () => ipcRenderer.send('primary-action'),
  // 透明空白处点击穿透：渲染端命中测试后切换（true=穿透，鼠标事件仍转发回来）
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  // 选项面板需要更高窗口
  setPetTall: (tall) => ipcRenderer.send('pet-tall', tall),
  // 记事本行动中心需要一大块区域
  setPetBig: (on) => ipcRenderer.send('pet-big', on),
  // 按弹层内容精确定高（动态，避免固定大窗口留白）；w/h<=0 复位
  setPetSize: (w, h) => ipcRenderer.send('set-pet-size', w, h),
  // 详情面板按内容高度自适应，避免底部留白 / 内容多时被切
  setPanelHeight: (h) => ipcRenderer.send('set-panel-height', h),
  // 在桌宠输入框打字时，让窗口拿到键盘焦点(隐藏 Dock 的 accessory app 默认拿不到)；用完归还
  focusPet: () => ipcRenderer.send('pet-focus'),
  blurPet: () => ipcRenderer.send('pet-blur'),
  // 打开日志文件
  openLog: () => ipcRenderer.send('open-log'),
  // 渲染端把关键 UI 决策写进日志(便于自检验证，不靠截图)
  petLog: (tag, msg) => ipcRenderer.send('pet-log', tag, msg),
  // 上报「用户正在交互」(选项面板/右键菜单/记事本)——领地模式据此避战/撤退
  uiBusy: (on) => ipcRenderer.send('ui-busy', on),
  petVisualBounds: (rect) => ipcRenderer.send('pet-visual-bounds', rect),
});
