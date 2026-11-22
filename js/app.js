/**
 * PULSE/LAB — third-party, local-only Coyote V3 Web Bluetooth controller.
 *
 * Safety model:
 *  - intensity changes are absolute, clamped locally, and only one is in flight;
 *  - enabling waits for a zeroing window and a B1 acknowledgement when needed;
 *  - a missing acknowledgement triggers a zeroing stop;
 *  - leaving the page while enabled triggers a zeroing stop by default;
 *  - any write failure tears the link down rather than continuing to stream.
 */

import {
  MODE,
  PROTOCOL,
  clampInt,
  encodeB0Frame,
  silentSamples,
} from './protocol.js';
import {
  PATTERNS,
  averageFrequency,
  getPatternInfo,
  sampleChannel,
} from './patterns.js';
import {
  CoyoteBleTransport,
  DemoTransport,
  NativeCoyoteTransport,
  isNativeBleAvailable,
  isSecureForBluetooth,
  isWebBluetoothSupported,
} from './ble.js';
import { WaveformScope } from './waveform-view.js';

const SETTINGS_KEY = 'pulselab.settings.v1';
const SAFETY_ACK_KEY = 'pulselab.safety.ack.v1';
const SETTINGS_VERSION = 1;

const SPEEDS = [0.5, 1, 1.5, 2];
const AUTO_STOP_OPTIONS = [0, 10, 20, 30, 45];
const PATTERN_IDS = new Set(PATTERNS.map((pattern) => pattern.id));
const ARM_GRACE_MS = 700;
const ARM_ACK_TIMEOUT_MS = 1800;
const INTENSITY_ACK_TIMEOUT_MS = 1600;
const ZERO_TIMEOUT_MS = 4200;
const ZERO_RETRY_MS = 520;
const TICK_MS = PROTOCOL.TICK_MS;

const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  limitA: 30,
  limitB: 30,
  patternA: 'breathe',
  patternB: 'tide',
  speed: 1,
  depth: 70,
  enabledA: true,
  enabledB: true,
  autoStopMinutes: 20,
  backgroundStop: true,
  haptics: true,
  balance1A: 128,
  balance1B: 128,
  balance2A: 128,
  balance2B: 128,
});

const $ = (id) => document.getElementById(id);

const channelElements = {
  A: {
    card: $('channelCardA'),
    value: $('valueA'),
    actual: $('actualA'),
    limit: $('limitA'),
    limitButton: $('limitBtnA'),
    meter: $('meterA'),
    dec: $('decA'),
    inc: $('incA'),
    toggle: $('toggleA'),
    select: $('patternA'),
    canvas: $('canvasA'),
    hz: $('hzA'),
    state: $('patternStateA'),
  },
  B: {
    card: $('channelCardB'),
    value: $('valueB'),
    actual: $('actualB'),
    limit: $('limitB'),
    limitButton: $('limitBtnB'),
    meter: $('meterB'),
    dec: $('decB'),
    inc: $('incB'),
    toggle: $('toggleB'),
    select: $('patternB'),
    canvas: $('canvasB'),
    hz: $('hzB'),
    state: $('patternStateB'),
  },
};

const ui = {
  statusText: $('statusText'),
  batteryChip: $('batteryChip'),
  batteryFill: $('batteryFill'),
  batteryText: $('batteryText'),
  demoChip: $('demoChip'),
  deviceBtn: $('deviceBtn'),
  settingsBtn: $('settingsBtn'),
  heroConnectBtn: $('heroConnectBtn'),
  heroDemoBtn: $('heroDemoBtn'),
  connectHero: $('connectHero'),
  compatNotice: $('compatNotice'),
  compatTitle: $('compatTitle'),
  compatText: $('compatText'),
  compatHelpBtn: $('compatHelpBtn'),
  installBtnHero: $('installBtnHero'),
  networkBanner: $('networkBanner'),
  networkText: $('networkText'),
  controlArea: $('controlArea'),
  sessionState: $('sessionState'),
  sessionText: $('sessionText'),
  sessionClock: $('sessionClock'),
  safetyLimitA: $('safetyLimitA'),
  safetyLimitB: $('safetyLimitB'),
  safetyAutoStop: $('safetyAutoStop'),
  openSafetyBtn: $('openSafetyBtn'),
  quickZeroBtn: $('quickZeroBtn'),
  speedControl: $('speedControl'),
  depthRange: $('depthRange'),
  depthValue: $('depthValue'),
  eventCount: $('eventCount'),
  eventList: $('eventList'),
  eventsDetails: $('eventsDetails'),
  dock: $('controlDock'),
  dockLabel: $('dockLabel'),
  dockHint: $('dockHint'),
  armBtn: $('armBtn'),
  armProgress: $('armProgress'),
  armText: $('armText'),
  estopBtn: $('estopBtn'),
  estopText: $('estopText'),
  dockMenuBtn: $('dockMenuBtn'),
  toast: $('toast'),
  toastText: $('toastText'),
  onboardingDialog: $('onboardingDialog'),
  onboardingAcceptBtn: $('onboardingAcceptBtn'),
  deviceDialog: $('deviceDialog'),
  settingsDialog: $('settingsDialog'),
  deviceGlyph: $('deviceGlyph'),
  deviceState: $('deviceState'),
  deviceName: $('deviceName'),
  deviceMeta: $('deviceMeta'),
  deviceBattery: $('deviceBattery'),
  dialogConnectBtn: $('dialogConnectBtn'),
  dialogDemoBtn: $('dialogDemoBtn'),
  reconnectBtn: $('reconnectBtn'),
  disconnectBtn: $('disconnectBtn'),
  installBtn: $('installBtn'),
  settings: {
    limitInputA: $('limitInputA'),
    limitInputB: $('limitInputB'),
    limitWarning: $('limitWarning'),
    applySafetyBtn: $('applySafetyBtn'),
    backgroundStopSwitch: $('backgroundStopSwitch'),
    hapticsSwitch: $('hapticsSwitch'),
    autoStopSelect: $('autoStopSelect'),
    balance1A: $('balance1A'),
    balance1B: $('balance1B'),
    balance2A: $('balance2A'),
    balance2B: $('balance2B'),
    balance1AValue: $('balance1AValue'),
    balance1BValue: $('balance1BValue'),
    balance2AValue: $('balance2AValue'),
    balance2BValue: $('balance2BValue'),
    applyBalanceBtn: $('applyBalanceBtn'),
    showSafetyBtn: $('showSafetyBtn'),
    resetPrefsBtn: $('resetPrefsBtn'),
  },
};

const scopes = {
  A: new WaveformScope(channelElements.A.canvas, {
    channel: 'A',
    getConfig: () => ({
      active: state.phase === 'armed' && settings.enabledA,
      speed: settings.speed,
      depth: settings.depth,
      patternId: settings.patternA,
    }),
  }),
  B: new WaveformScope(channelElements.B.canvas, {
    channel: 'B',
    getConfig: () => ({
      active: state.phase === 'armed' && settings.enabledB,
      speed: settings.speed,
      depth: settings.depth,
      patternId: settings.patternB,
    }),
  }),
};

let settings = loadSettings();
let lastBleTransport = null;

const state = {
  connection: 'disconnected',
  phase: 'disconnected',
  connecting: false,
  failingSafe: false,
  transport: null,
  isDemo: false,
  name: 'Coyote V3',
  battery: null,
  actual: { A: 0, B: 0 },
  target: { A: 0, B: 0 },
  revision: { A: 0, B: 0 },
  dirty: { A: false, B: false },
  pending: null,
  gateOpen: true,
  seq: 0,
  loopRunning: false,
  loopTimer: null,
  nextTickAt: 0,
  writeCount: 0,
  armDeadline: 0,
  armAckRequired: false,
  patternStartedAt: 0,
  zero: {
    active: false,
    until: 0,
    nextAt: 0,
    confirmed: false,
    attempts: 0,
    graceUntil: 0,
  },
  session: {
    startedAt: null,
    autoStopAt: null,
    interval: null,
  },
  wakeLock: null,
  batteryTimer: null,
  events: [],
  acknowledged: readSafetyAck(),
  installPrompt: null,
  hiddenStop: false,
  toastTimer: null,
  lastFooterUpdate: 0,
  lastDraw: 0,
  armHold: {
    active: false,
    startedAt: 0,
    raf: 0,
    pointerId: null,
  },
};

/* -------------------------------------------------------------------------- */
/* Settings and small utilities                                               */
/* -------------------------------------------------------------------------- */

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

function readSafetyAck() {
  return safeStorageGet(SAFETY_ACK_KEY) === '1';
}

function normalizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const patternA = PATTERN_IDS.has(source.patternA) ? source.patternA : DEFAULT_SETTINGS.patternA;
  const patternB = PATTERN_IDS.has(source.patternB) ? source.patternB : DEFAULT_SETTINGS.patternB;
  const speed = Number(source.speed);
  const autoStop = Number(source.autoStopMinutes);

  return {
    version: SETTINGS_VERSION,
    limitA: clampInt(source.limitA, 0, 200, DEFAULT_SETTINGS.limitA),
    limitB: clampInt(source.limitB, 0, 200, DEFAULT_SETTINGS.limitB),
    patternA,
    patternB,
    speed: SPEEDS.includes(speed) ? speed : DEFAULT_SETTINGS.speed,
    depth: clampInt(source.depth, 10, 100, DEFAULT_SETTINGS.depth),
    enabledA: typeof source.enabledA === 'boolean' ? source.enabledA : DEFAULT_SETTINGS.enabledA,
    enabledB: typeof source.enabledB === 'boolean' ? source.enabledB : DEFAULT_SETTINGS.enabledB,
    autoStopMinutes: AUTO_STOP_OPTIONS.includes(autoStop) ? autoStop : DEFAULT_SETTINGS.autoStopMinutes,
    backgroundStop: typeof source.backgroundStop === 'boolean'
      ? source.backgroundStop
      : DEFAULT_SETTINGS.backgroundStop,
    haptics: typeof source.haptics === 'boolean' ? source.haptics : DEFAULT_SETTINGS.haptics,
    balance1A: clampInt(source.balance1A, 0, 255, DEFAULT_SETTINGS.balance1A),
    balance1B: clampInt(source.balance1B, 0, 255, DEFAULT_SETTINGS.balance1B),
    balance2A: clampInt(source.balance2A, 0, 255, DEFAULT_SETTINGS.balance2A),
    balance2B: clampInt(source.balance2B, 0, 255, DEFAULT_SETTINGS.balance2B),
  };
}

function loadSettings() {
  const raw = safeStorageGet(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let saveSettingsTimer = null;
function saveSettings({ immediate = false } = {}) {
  clearTimeout(saveSettingsTimer);
  const commit = () => {
    safeStorageSet(SETTINGS_KEY, JSON.stringify(settings));
  };
  if (immediate) commit();
  else saveSettingsTimer = setTimeout(commit, 220);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function nextSequence() {
  state.seq = (state.seq % 15) + 1;
  return state.seq;
}

function haptic(pattern = 8) {
  if (!settings.haptics) return;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(pattern); } catch { /* optional */ }
  }
}

function isConfigured() {
  return state.connection === 'connected';
}

function isArmed() {
  return state.connection === 'connected' && state.phase === 'armed';
}

function canUseBluetooth() {
  return isNativeBleAvailable()
    || (isSecureForBluetooth() && isWebBluetoothSupported());
}

function bfPayload() {
  return {
    limitA: settings.limitA,
    limitB: settings.limitB,
    balance1A: settings.balance1A,
    balance1B: settings.balance1B,
    balance2A: settings.balance2A,
    balance2B: settings.balance2B,
  };
}

/* -------------------------------------------------------------------------- */
/* Events / toasts                                                             */
/* -------------------------------------------------------------------------- */

function addEvent(message, level = 'info') {
  const now = new Date();
  state.events.push({
    at: now,
    time: new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now),
    level,
    message,
  });
  if (state.events.length > 80) state.events.splice(0, state.events.length - 80);
  renderEvents();
}

function renderEvents() {
  if (!ui.eventList) return;
  ui.eventCount.textContent = String(state.events.length);
  const items = state.events.slice(-28).reverse();
  const fragment = document.createDocumentFragment();
  for (const entry of items) {
    const li = document.createElement('li');
    if (entry.level === 'warn') li.className = 'event-warn';
    if (entry.level === 'error') li.className = 'event-error';
    const time = document.createElement('time');
    time.textContent = entry.time;
    const message = document.createElement('span');
    message.textContent = entry.message;
    li.append(time, message);
    fragment.append(li);
  }
  ui.eventList.replaceChildren(fragment);
}

function toast(message, options = {}) {
  const { type = 'info', duration = 3600 } = options;
  clearTimeout(state.toastTimer);
  ui.toast.hidden = true;
  ui.toast.className = 'toast';
  if (type === 'error') ui.toast.classList.add('is-error');
  if (type === 'warn') ui.toast.classList.add('is-warn');
  ui.toastText.textContent = message;
  // Force the entrance animation to replay for rapid messages.
  void ui.toast.offsetWidth;
  ui.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, duration);
}

function describeError(error) {
  if (!error) return '未知错误';
  const message = String(error.message || error);
  if (/[\u4e00-\u9fff]/.test(message)) return message;
  switch (error.name) {
    case 'NotFoundError':
      return '没有选择设备，或附近没有可连接的 Coyote。请确认主机已开机。';
    case 'SecurityError':
      return '浏览器拒绝了蓝牙权限。请确认页面通过 HTTPS 打开，并在提示时允许附近设备权限。';
    case 'NetworkError':
      return '无法建立蓝牙连接。请重启主机蓝牙，并确保它没有被其他手机占用。';
    case 'InvalidStateError':
      return '蓝牙适配器当前不可用。请打开手机蓝牙后重试。';
    case 'NotSupportedError':
      return '此浏览器不支持 Web Bluetooth，请改用 Android Chrome。';
    case 'NotAllowedError':
      return '蓝牙权限被拒绝。请在系统设置中允许 Chrome 使用附近的设备。';
    default:
      return `连接失败：${message}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Pattern/popover rendering                                                   */
/* -------------------------------------------------------------------------- */

function populatePatternSelects() {
  for (const channel of ['A', 'B']) {
    const select = channelElements[channel].select;
    const fragment = document.createDocumentFragment();
    for (const pattern of PATTERNS) {
      const option = document.createElement('option');
      option.value = pattern.id;
      option.textContent = pattern.name;
      fragment.append(option);
    }
    select.replaceChildren(fragment);
  }
}

function syncPatternControls() {
  channelElements.A.select.value = settings.patternA;
  channelElements.B.select.value = settings.patternB;
  settings.patternA = channelElements.A.select.value || DEFAULT_SETTINGS.patternA;
  settings.patternB = channelElements.B.select.value || DEFAULT_SETTINGS.patternB;

  for (const button of ui.speedControl.querySelectorAll('button[data-speed]')) {
    const speed = Number(button.dataset.speed);
    button.classList.toggle('is-active', speed === settings.speed);
    button.setAttribute('aria-pressed', speed === settings.speed ? 'true' : 'false');
  }

  ui.depthRange.value = String(settings.depth);
  ui.depthValue.textContent = String(settings.depth);
  updateRangeProgress(ui.depthRange, settings.depth, 10, 100);
}

function updateRangeProgress(input, value, min, max) {
  const percent = ((Number(value) - min) / (max - min)) * 100;
  input.style.setProperty('--range-progress', `${Math.min(100, Math.max(0, percent))}%`);
}

function updateBalanceRange(input, output) {
  const value = Number(input.value);
  output.textContent = String(value);
  updateRangeProgress(input, value, 0, 255);
}

function syncSettingsInputs() {
  ui.settings.limitInputA.value = String(settings.limitA);
  ui.settings.limitInputB.value = String(settings.limitB);
  updateLimitWarning();

  ui.settings.backgroundStopSwitch.checked = settings.backgroundStop;
  ui.settings.hapticsSwitch.checked = settings.haptics;
  ui.settings.autoStopSelect.value = String(settings.autoStopMinutes);

  ui.settings.balance1A.value = String(settings.balance1A);
  ui.settings.balance1B.value = String(settings.balance1B);
  ui.settings.balance2A.value = String(settings.balance2A);
  ui.settings.balance2B.value = String(settings.balance2B);
  updateBalanceRange(ui.settings.balance1A, ui.settings.balance1AValue);
  updateBalanceRange(ui.settings.balance1B, ui.settings.balance1BValue);
  updateBalanceRange(ui.settings.balance2A, ui.settings.balance2AValue);
  updateBalanceRange(ui.settings.balance2B, ui.settings.balance2BValue);

  ui.safetyLimitA.textContent = String(settings.limitA);
  ui.safetyLimitB.textContent = String(settings.limitB);
  ui.safetyAutoStop.textContent = settings.autoStopMinutes > 0
    ? `${settings.autoStopMinutes} 分钟`
    : '关闭';
}

function updateLimitWarning() {
  const a = Number(ui.settings.limitInputA.value);
  const b = Number(ui.settings.limitInputB.value);
  const high = (Number.isFinite(a) && a > 100) || (Number.isFinite(b) && b > 100);
  ui.settings.limitWarning.hidden = !high;
}

/* -------------------------------------------------------------------------- */
/* Main rendering                                                              */
/* -------------------------------------------------------------------------- */

function renderAll() {
  renderConnection();
  renderPhase();
  renderChannels();
  syncSettingsInputs();
  renderEvents();
}

function renderConnection() {
  const connection = state.connection;
  document.body.dataset.connection = connection === 'connected' ? 'connected' : connection;
  document.body.classList.toggle('is-connected', connection === 'connected');
  document.body.classList.toggle('is-demo', connection === 'connected' && state.isDemo);

  let connectionLabel = '未连接';
  if (connection === 'connecting') connectionLabel = '连接中';
  else if (connection === 'connected') connectionLabel = state.isDemo ? '演示' : '已连接';
  ui.statusText.textContent = connectionLabel;
  ui.deviceBtn.setAttribute('aria-label', `设备与连接，当前${connectionLabel}`);

  // Keep the top pill compact on 360 px screens. The simulator is identified
  // by its status text, the orange dot, the device sheet and a toast.
  ui.demoChip.hidden = true;

  const battery = state.battery;
  const showBattery = connection === 'connected' && !state.isDemo && Number.isFinite(battery);
  ui.batteryChip.hidden = !showBattery;
  if (showBattery) {
    const clamped = clampInt(battery, 0, 100);
    ui.batteryText.textContent = `${clamped}%`;
    ui.batteryFill.setAttribute('width', String(Math.max(1, (clamped / 100) * 11)));
    ui.batteryChip.classList.toggle('is-low', clamped <= 20);
  }

  const bluetoothUsable = canUseBluetooth();
  ui.heroConnectBtn.disabled = connection === 'connecting' || !bluetoothUsable;
  ui.dialogConnectBtn.disabled = connection === 'connecting' || !bluetoothUsable;
  ui.heroDemoBtn.disabled = connection === 'connecting';
  ui.dialogDemoBtn.disabled = connection === 'connecting';

  renderDeviceDialog();
}

function renderDeviceDialog() {
  if (!ui.deviceDialog) return;
  const connected = state.connection === 'connected';
  const connecting = state.connection === 'connecting';
  ui.deviceState.textContent = connecting ? 'CONNECTING' : connected ? (state.isDemo ? 'SIMULATOR' : 'CONNECTED') : 'DISCONNECTED';
  ui.deviceName.textContent = connecting ? '正在寻找设备…' : connected ? state.name : 'Coyote V3';
  ui.deviceMeta.textContent = connecting
    ? '请在系统蓝牙选择器中选择 47L121000'
    : connected
      ? state.isDemo
        ? '本地模拟 · 不会产生真实输出'
        : `${isNativeBleAvailable() ? '原生 BLE' : 'Web Bluetooth'} · ${state.actual.A} / ${state.actual.B}`
      : '等待蓝牙连接';

  const battery = state.battery;
  ui.deviceBattery.hidden = !(connected && Number.isFinite(battery));
  if (Number.isFinite(battery)) ui.deviceBattery.textContent = `${battery}%`;

  ui.dialogConnectBtn.hidden = connected || connecting;
  ui.dialogDemoBtn.hidden = connected || connecting;
  ui.reconnectBtn.hidden = connected || connecting || !lastBleTransport?.canReconnect;
  ui.reconnectBtn.disabled = connecting;
  ui.disconnectBtn.hidden = !connected;
  ui.disconnectBtn.disabled = connecting;
  ui.disconnectBtn.textContent = state.phase === 'armed' ? '急停并断开' : '断开连接';
}

function renderPhase() {
  const phase = state.phase;
  ui.controlArea.dataset.phase = phase;
  document.body.dataset.phase = phase;

  const labels = {
    disconnected: '安全锁',
    locked: '安全锁',
    arming: '归零确认',
    armed: '输出中',
    stopping: '急停归零',
  };
  ui.sessionText.textContent = labels[phase] || '安全锁';
  const showClock = phase === 'armed';
  ui.sessionClock.hidden = !showClock;
  if (showClock) updateSessionClock(true);

  renderDock();
}

function phaseHint() {
  switch (state.phase) {
    case 'armed':
      return `A ${state.actual.A} / B ${state.actual.B}`;
    case 'arming':
      return '正在向设备写入归零指令';
    case 'stopping':
      return '正在发送归零指令，请保持页面在前台';
    case 'locked':
      return state.isDemo ? '演示模式 · 按住启用' : '按住 1 秒启用，设备会先归零';
    default:
      return '连接设备后可用';
  }
}

function renderDock() {
  const connected = state.connection === 'connected';
  ui.dock.hidden = !connected;
  if (!connected) {
    ui.armBtn.hidden = false;
    ui.estopBtn.hidden = true;
    ui.armBtn.disabled = true;
    return;
  }

  ui.dock.dataset.state = state.phase;
  ui.dockLabel.textContent = {
    locked: '安全锁启用',
    arming: '正在归零',
    armed: '输出已启用',
    stopping: '正在急停',
  }[state.phase] || '安全锁启用';
  ui.dockHint.textContent = phaseHint();

  const canArm = state.phase === 'locked';
  ui.armBtn.hidden = !canArm;
  ui.armBtn.disabled = !canArm;
  ui.armBtn.classList.toggle('is-arming', state.phase === 'arming');
  ui.armProgress.style.width = state.phase === 'arming' ? '100%' : '0%';
  ui.armText.textContent = state.phase === 'arming' ? '归零确认中…' : '按住 1 秒启用';

  const showStop = state.phase === 'armed' || state.phase === 'arming' || state.phase === 'stopping';
  ui.estopBtn.hidden = !showStop;
  if (showStop) {
    const stopping = state.phase === 'stopping';
    ui.estopBtn.disabled = stopping;
    ui.estopText.textContent = stopping ? '归零中' : state.phase === 'arming' ? '取消' : '急停';
  }
}

function renderChannels() {
  const connected = isConfigured();
  const armed = isArmed();
  const pendingIntensity = state.pending?.kind === 'intensity';

  for (const channel of ['A', 'B']) {
    const channelUi = channelElements[channel];
    const enabled = settings[`enabled${channel}`];
    const limit = settings[`limit${channel}`];
    const target = state.target[channel];
    const actual = state.actual[channel];

    channelUi.value.textContent = String(target);
    channelUi.value.classList.toggle('is-pending', pendingIntensity || state.phase === 'arming' || state.phase === 'stopping');
    channelUi.actual.textContent = String(actual);
    channelUi.limit.textContent = String(limit);
    channelUi.meter.style.width = `${Math.min(100, (actual / 200) * 100)}%`;

    const steppingDisabled = !armed;
    channelUi.dec.disabled = steppingDisabled || target <= 0;
    channelUi.inc.disabled = steppingDisabled || target >= limit;

    channelUi.toggle.disabled = !connected;
    channelUi.toggle.classList.toggle('is-on', enabled);
    channelUi.toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    channelUi.select.disabled = !connected;
    channelUi.select.value = settings[`pattern${channel}`];
    channelUi.card.classList.toggle('is-disabled', !enabled);
    channelUi.card.classList.toggle('is-live', armed && enabled);

    let patternState = '待机';
    const patternName = getPatternInfo(settings[`pattern${channel}`]).name;
    if (!connected) patternState = '待机';
    else if (state.phase === 'armed') patternState = enabled ? `${patternName} · 运行` : '已静音';
    else if (state.phase === 'arming') patternState = '归零中';
    else if (state.phase === 'stopping') patternState = '归零中';
    else patternState = enabled ? `${patternName} · 待命` : '已静音';
    channelUi.state.textContent = patternState;

    if (!connected) channelUi.hz.textContent = '-- Hz';
  }

  const configurable = connected;
  for (const button of ui.speedControl.querySelectorAll('button[data-speed]')) {
    button.disabled = !configurable;
  }
  ui.depthRange.disabled = !configurable;
  ui.quickZeroBtn.disabled = !connected;
  renderDock();
}

function updateWaveformFooters(now) {
  if (!isConfigured()) return;
  const elapsed = state.phase === 'armed' ? Math.max(0, now - state.patternStartedAt) : 0;
  for (const channel of ['A', 'B']) {
    if (!settings[`enabled${channel}`]) {
      channelElements[channel].hz.textContent = '静音';
      continue;
    }
    const samples = sampleChannel(settings[`pattern${channel}`], elapsed, {
      speed: settings.speed,
      depth: settings.depth,
      channel,
    });
    const frequency = averageFrequency(samples);
    channelElements[channel].hz.textContent = frequency ? `${frequency} Hz` : '-- Hz';
  }
}

/* -------------------------------------------------------------------------- */
/* Session clock / wake lock                                                  */
/* -------------------------------------------------------------------------- */

function configureSessionClock() {
  clearInterval(state.session.interval);
  state.session.interval = null;
  if (state.phase !== 'armed' || !state.session.startedAt) {
    ui.sessionClock.hidden = true;
    return;
  }

  ui.sessionClock.hidden = false;
  state.session.autoStopAt = settings.autoStopMinutes > 0
    ? state.session.startedAt + settings.autoStopMinutes * 60_000
    : null;
  updateSessionClock(true);
  state.session.interval = setInterval(() => updateSessionClock(false), 1000);
}

function updateSessionClock(force = false) {
  if (state.phase !== 'armed' || !state.session.startedAt) {
    ui.sessionClock.hidden = true;
    return;
  }
  const now = Date.now();
  if (state.session.autoStopAt !== null) {
    const remaining = state.session.autoStopAt - now;
    if (remaining <= 0) {
      updateDockHint();
      emergencyStop('达到自动停止时间', {
        message: '已到自动停止时间，正在归零并锁定。',
        type: 'warn',
      });
      return;
    }
    ui.sessionClock.textContent = formatClock(remaining);
    ui.sessionClock.title = '距离自动停止';
  } else {
    ui.sessionClock.textContent = formatClock(now - state.session.startedAt);
    ui.sessionClock.title = '已运行时间';
  }
  if (force) updateDockHint();
}

function updateDockHint() {
  if (state.connection !== 'connected') return;
  ui.dockHint.textContent = phaseHint();
}

async function requestWakeLock() {
  if (isNativeBleAvailable()) {
    try { window.PulseLabNative.setKeepScreenOn(true); } catch { /* optional */ }
    return;
  }
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    const wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock = wakeLock;
    wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
  } catch {
    // Screen wake lock is a convenience. Some browsers deny it in standalone mode.
  }
}

function releaseWakeLock() {
  if (isNativeBleAvailable()) {
    try { window.PulseLabNative.setKeepScreenOn(false); } catch { /* optional */ }
    return;
  }
  if (!state.wakeLock) return;
  try { state.wakeLock.release(); } catch { /* already released */ }
  state.wakeLock = null;
}

/* -------------------------------------------------------------------------- */
/* BLE command loop                                                           */
/* -------------------------------------------------------------------------- */

function startCommandLoop() {
  stopCommandLoop();
  state.loopRunning = true;
  state.nextTickAt = performance.now();
  const run = () => {
    if (!state.loopRunning) return;
    const now = performance.now();
    if (now > state.nextTickAt + 320) state.nextTickAt = now;
    patternTick(now);
    state.nextTickAt += TICK_MS;
    const wait = Math.max(4, state.nextTickAt - performance.now());
    state.loopTimer = setTimeout(run, wait);
  };
  run();
}

function stopCommandLoop() {
  state.loopRunning = false;
  clearTimeout(state.loopTimer);
  state.loopTimer = null;
}

function patternTick(now, { forceWrite = false } = {}) {
  if (state.connection !== 'connected' || !state.transport) return;
  if (state.writeCount > 0 && !forceWrite) return;

  if (handlePendingTimeouts(now)) return;
  if (handleZeroWindow(now)) return;

  const command = makeIntensityCommand(now);
  let samplesA = silentSamples();
  let samplesB = silentSamples();

  if (state.phase === 'armed') {
    const elapsed = Math.max(0, now - state.patternStartedAt);
    if (settings.enabledA) {
      samplesA = sampleChannel(settings.patternA, elapsed, {
        speed: settings.speed,
        depth: settings.depth,
        channel: 'A',
      });
    }
    if (settings.enabledB) {
      samplesB = sampleChannel(settings.patternB, elapsed, {
        speed: settings.speed,
        depth: settings.depth,
        channel: 'B',
      });
    }
  }

  const frame = encodeB0Frame({
    sequence: command?.sequence ?? 0,
    modeA: command?.modeA ?? MODE.HOLD,
    modeB: command?.modeB ?? MODE.HOLD,
    intensityA: command?.intensityA ?? 0,
    intensityB: command?.intensityB ?? 0,
    samplesA,
    samplesB,
  });

  writeFrame(frame, { force: Boolean(command) || forceWrite });

  if (state.phase === 'armed' && now - state.lastFooterUpdate > 320) {
    state.lastFooterUpdate = now;
    updateWaveformFooters(now);
    updateDockHint();
  }
}

function handlePendingTimeouts(now) {
  const pending = state.pending;
  if (!pending) return false;
  const age = now - pending.sentAt;

  if (state.phase === 'arming' && now >= state.armDeadline) {
    state.pending = null;
    state.gateOpen = true;
    const actualIsZero = state.actual.A === 0 && state.actual.B === 0;
    if (state.armAckRequired || !actualIsZero) {
      addEvent(
        state.armAckRequired
          ? '启用超时：未收到设备归零回执'
          : '启用超时：归零窗口内检测到非零强度',
        'error',
      );
      emergencyStop('启用归零确认超时', {
        message: '未确认设备归零，未启用输出。请检查连接后重试。',
        type: 'error',
      });
      return true;
    }
    // If the device was already at zero it may not emit B1 for a no-op. The
    // write itself succeeded and last-known intensity is zero, so enable.
    addEvent('启用：未收到 0→0 的 B1 回执，按已知 0 强度继续', 'info');
    completeArming({ confirmed: false });
    return true;
  }

  if (pending.kind === 'intensity' && age > INTENSITY_ACK_TIMEOUT_MS) {
    state.pending = null;
    state.gateOpen = true;
    addEvent(`强度回执超时（seq ${pending.sequence}）`, 'error');
    emergencyStop('强度回执超时', {
      message: '未收到强度回执，已急停归零。请检查设备连接。',
      type: 'error',
    });
    return true;
  }

  if (pending.kind === 'zero' && age > 900) {
    state.pending = null;
    state.gateOpen = true;
    return false;
  }

  return false;
}

function handleZeroWindow(now) {
  if (!state.zero.active) return false;
  if (state.pending) return false;

  // A no-op zero command may not produce a B1 because intensity did not
  // change. If both channels were already known to be zero, do not keep the
  // user waiting for a response that will never come; the write itself is the
  // safe action here. Any reported non-zero value cancels this shortcut.
  if (state.zero.graceUntil && now >= state.zero.graceUntil) {
    if (state.actual.A === 0 && state.actual.B === 0) {
      state.zero.active = false;
      state.zero.confirmed = false;
      state.phase = 'locked';
      addEvent('急停完成：设备强度已知为 0（未收到 B1）');
      renderAll();
      toast('已急停并锁定。', { type: 'success' });
      return false;
    }
    state.zero.graceUntil = 0;
  }

  if (now >= state.zero.until) {
    state.zero.active = false;
    if (state.phase === 'stopping') state.phase = 'locked';
    const confirmed = state.zero.confirmed;
    if (!confirmed) {
      addEvent('归零窗口结束：未收到 B1 回执', 'error');
      toast('未收到归零回执。请关闭主机电源检查设备。', { type: 'error', duration: 7000 });
    }
    renderAll();
    return false;
  }

  if (now >= state.zero.nextAt) {
    addEvent(`重发归零指令（第 ${state.zero.attempts + 1} 次）`, 'warn');
  }
  return false;
}

function makeIntensityCommand(now) {
  if (state.pending) return null;

  if (state.zero.active && now < state.zero.until) {
    if (now < state.zero.nextAt) return null;
    const sequence = nextSequence();
    state.pending = {
      kind: 'zero',
      sequence,
      sentAt: now,
      modeA: MODE.ABSOLUTE,
      modeB: MODE.ABSOLUTE,
      intensityA: 0,
      intensityB: 0,
    };
    state.gateOpen = false;
    state.zero.attempts += 1;
    state.zero.nextAt = now + ZERO_RETRY_MS;
    return state.pending;
  }

  if (state.phase !== 'armed' || !state.gateOpen) return null;

  const dirtyA = state.dirty.A && state.target.A !== state.actual.A;
  const dirtyB = state.dirty.B && state.target.B !== state.actual.B;
  if (!dirtyA) state.dirty.A = false;
  if (!dirtyB) state.dirty.B = false;
  if (!dirtyA && !dirtyB) return null;

  const sequence = nextSequence();
  state.pending = {
    kind: 'intensity',
    sequence,
    sentAt: now,
    modeA: dirtyA ? MODE.ABSOLUTE : MODE.HOLD,
    modeB: dirtyB ? MODE.ABSOLUTE : MODE.HOLD,
    intensityA: dirtyA ? state.target.A : 0,
    intensityB: dirtyB ? state.target.B : 0,
    revisionA: state.revision.A,
    revisionB: state.revision.B,
  };
  state.gateOpen = false;
  return state.pending;
}

function writeFrame(frame, { force = false } = {}) {
  if (state.connection !== 'connected' || !state.transport) return;
  if (state.writeCount > 0 && !force) return;
  state.writeCount += 1;
  state.transport.write(frame)
    .catch((error) => {
      if (state.connection === 'connected' || state.connection === 'connecting') {
        handleWriteFailure(error);
      }
    })
    .finally(() => {
      state.writeCount = Math.max(0, state.writeCount - 1);
    });
}

function handleWriteFailure(error) {
  if (state.failingSafe) return;
  state.failingSafe = true;
  addEvent(`蓝牙写入失败：${error?.message || error}`, 'error');
  const transport = state.transport;
  hardDisconnectOnFailure(transport, '蓝牙写入失败，已断开连接。请确认主机停止输出，必要时关闭主机电源。');
}

async function hardDisconnectOnFailure(transport, message) {
  stopCommandLoop();
  clearInterval(state.session.interval);
  state.session.interval = null;
  releaseWakeLock();
  state.pending = null;
  state.zero.active = false;
  try { await transport?.disconnect({ intentional: true }); } catch { /* noop */ }
  const wasActive = state.phase === 'armed' || state.phase === 'arming' || state.phase === 'stopping';
  finishDisconnected({
    toastMessage: message,
    toastType: 'error',
    wasActive,
    scrollTop: false,
  });
  if (transport && !transport.isDemo && transport.canReconnect) lastBleTransport = transport;
}

/* -------------------------------------------------------------------------- */
/* Arm / stop state machine                                                   */
/* -------------------------------------------------------------------------- */

function beginArming() {
  if (state.connection !== 'connected' || state.phase !== 'locked' || !state.transport) return;
  const now = performance.now();
  state.phase = 'arming';
  state.armAckRequired = state.actual.A > 0 || state.actual.B > 0;
  state.armDeadline = now + (state.armAckRequired ? ARM_ACK_TIMEOUT_MS : ARM_GRACE_MS);
  state.pending = null;
  state.gateOpen = false;
  state.target.A = 0;
  state.target.B = 0;
  state.dirty.A = false;
  state.dirty.B = false;
  state.zero.active = false;

  const sequence = nextSequence();
  state.pending = {
    kind: 'arm',
    sequence,
    sentAt: now,
    modeA: MODE.ABSOLUTE,
    modeB: MODE.ABSOLUTE,
    intensityA: 0,
    intensityB: 0,
  };
  state.session.startedAt = null;
  state.session.autoStopAt = null;
  clearInterval(state.session.interval);
  state.session.interval = null;

  const frame = encodeB0Frame({
    sequence,
    modeA: MODE.ABSOLUTE,
    modeB: MODE.ABSOLUTE,
    intensityA: 0,
    intensityB: 0,
    samplesA: silentSamples(),
    samplesB: silentSamples(),
  });

  addEvent(
    state.armAckRequired
      ? '启用：检测到非零强度，写入归零并等待回执'
      : '启用：写入归零指令',
  );
  haptic([10, 30, 10]);
  renderAll();
  writeFrame(frame, { force: true });
}

function completeArming({ confirmed }) {
  if (state.connection !== 'connected' || state.phase !== 'arming') return;
  // Never start a pattern while the last known device intensity is non-zero.
  if (state.actual.A !== 0 || state.actual.B !== 0) {
    addEvent('启用被阻止：设备强度不为零', 'error');
    emergencyStop('启用时设备强度不为零', {
      message: '设备强度不为零，输出未启用。',
      type: 'error',
    });
    return;
  }
  state.phase = 'armed';
  state.pending = null;
  state.gateOpen = true;
  state.target.A = 0;
  state.target.B = 0;
  state.dirty.A = false;
  state.dirty.B = false;
  state.patternStartedAt = performance.now();
  state.session.startedAt = Date.now();
  state.zero.active = false;

  addEvent(confirmed ? '归零回执已确认，输出启用' : '输出启用（已知 0 强度起步）');
  configureSessionClock();
  requestWakeLock();
  haptic([12, 24, 12]);
  renderAll();
  toast(
    confirmed
      ? '设备已归零 · 输出已启用。请从 +1 开始。'
      : '输出已启用 · 设备强度已知为 0，请从 +1 开始。',
    { type: 'success', duration: 4200 },
  );
  // Immediately publish silence for this session; the next tick starts the pattern.
  patternTick(performance.now(), { forceWrite: true });
}

function emergencyStop(reason, options = {}) {
  const {
    silent = false,
    message = '已急停，正在确认设备归零。',
    type = 'warn',
  } = options;

  if (state.connection !== 'connected') {
    renderAll();
    return;
  }

  const now = performance.now();
  addEvent(`急停：${reason}`, 'warn');
  state.phase = 'stopping';
  state.pending = null;
  state.gateOpen = true;
  state.target.A = 0;
  state.target.B = 0;
  state.dirty.A = false;
  state.dirty.B = false;
  state.armDeadline = 0;
  state.session.startedAt = null;
  state.session.autoStopAt = null;
  clearInterval(state.session.interval);
  state.session.interval = null;
  releaseWakeLock();

  const wasZero = state.actual.A === 0 && state.actual.B === 0;
  state.zero = {
    active: true,
    until: now + ZERO_TIMEOUT_MS,
    nextAt: now,
    confirmed: false,
    attempts: 0,
    // Keep this below the 900 ms zero-command retry timeout so that a known
    // no-op can finish without scheduling another command.
    graceUntil: wasZero ? now + 700 : 0,
  };

  if (!silent) haptic([32, 55, 32]);
  renderAll();
  if (!silent) toast(message, { type, duration: 4200 });

  // Send the first zero as a priority frame immediately.
  patternTick(now, { forceWrite: true });
}

function handleIncoming(transport, message) {
  if (state.transport !== transport || state.connection !== 'connected') return;
  const previousActual = { ...state.actual };
  state.actual.A = message.intensityA;
  state.actual.B = message.intensityB;
  const pending = state.pending;
  const matching = pending && pending.sequence === message.sequence;

  if (matching) {
    state.pending = null;
    state.gateOpen = true;

    if (pending.kind === 'arm') {
      if (message.intensityA === 0 && message.intensityB === 0) {
        addEvent(`B1 归零回执（seq ${message.sequence}）`);
        completeArming({ confirmed: true });
      } else {
        addEvent('B1 归零失败：设备回报非零强度', 'error');
        emergencyStop('归零回执非零', {
          message: '设备未归零，输出保持锁定。请关闭主机电源检查。',
          type: 'error',
        });
      }
      renderChannels();
      return;
    }

    if (pending.kind === 'zero') {
      if (message.intensityA === 0 && message.intensityB === 0) {
        state.zero.confirmed = true;
        state.zero.active = false;
        state.phase = 'locked';
        addEvent('设备已确认归零，安全锁恢复');
        renderAll();
        toast('设备已归零，安全锁已恢复。', { type: 'success' });
      } else {
        addEvent('归零回执非零，将继续重试', 'error');
        state.zero.nextAt = 0;
      }
      renderChannels();
      renderDeviceDialog();
      return;
    }

    if (pending.kind === 'intensity') {
      for (const channel of ['A', 'B']) {
        const revisionKey = `revision${channel}`;
        if (pending[revisionKey] === state.revision[channel]) {
          state.target[channel] = state.actual[channel];
          state.dirty[channel] = false;
        } else {
          state.dirty[channel] = state.target[channel] !== state.actual[channel];
        }
      }
      addEvent(`B1 强度确认 · A ${message.intensityA} / B ${message.intensityB} · seq ${message.sequence}`);
      renderChannels();
      renderDeviceDialog();
      return;
    }
  } else if (!pending) {
    // A physical wheel change arrives with sequence 0. Follow it only when the
    // app has no unacknowledged target of its own.
    let changed = false;
    for (const channel of ['A', 'B']) {
      if (!state.dirty[channel]) {
        if (state.target[channel] !== state.actual[channel]) {
          state.target[channel] = state.actual[channel];
          changed = true;
        }
      }
    }
    if (changed || previousActual.A !== state.actual.A || previousActual.B !== state.actual.B) {
      if (message.sequence === 0) addEvent(`实体旋钮强度变化 · A ${message.intensityA} / B ${message.intensityB}`, 'warn');
      renderChannels();
    }
  }

  // An external wheel change while arming invalidates a no-change assumption.
  // Require an acknowledgement before arming.
  if (state.phase === 'arming' && (state.actual.A > 0 || state.actual.B > 0)) {
    if (!state.armAckRequired) {
      addEvent('启用期间检测到非零强度，将等待归零回执', 'warn');
    }
    state.armAckRequired = true;
    state.armDeadline = Math.max(state.armDeadline, performance.now() + ARM_ACK_TIMEOUT_MS);
  }

  // Always surface the latest device truth, even for stale or external changes.
  renderChannels();
  renderDeviceDialog();
}

function sendIntensityDelta(channel, delta) {
  if (!isArmed()) return;
  const limit = settings[`limit${channel}`];
  const current = state.target[channel];
  const next = clampInt(current + delta, 0, limit, current);
  if (next === current) {
    if (delta > 0 && current >= limit) haptic(3);
    return;
  }
  state.target[channel] = next;
  state.dirty[channel] = next !== state.actual[channel];
  state.revision[channel] += 1;
  if (delta > 0) haptic(5);
  renderChannels();
}

/* -------------------------------------------------------------------------- */
/* Connection lifecycle                                                       */
/* -------------------------------------------------------------------------- */

function makeTransport(isDemo) {
  // The callback needs the exact transport instance. Create it first, then bind.
  let transport;
  if (isDemo) {
    transport = new DemoTransport({
      onNotification: (message) => handleIncoming(transport, message),
      onDisconnect: (info) => handleUnexpectedDisconnect(transport, info),
    });
  } else if (isNativeBleAvailable()) {
    transport = new NativeCoyoteTransport({
      onNotification: (message) => handleIncoming(transport, message),
      onDisconnect: (info) => handleUnexpectedDisconnect(transport, info),
    });
  } else {
    transport = new CoyoteBleTransport({
      onNotification: (message) => handleIncoming(transport, message),
      onDisconnect: (info) => handleUnexpectedDisconnect(transport, info),
    });
  }
  return transport;
}

async function beginConnection({ demo = false, reconnect = false } = {}) {
  if (state.connection === 'connecting' || state.connection === 'connected') return;

  closeAllSheets();

  let transport;
  if (demo) {
    transport = makeTransport(true);
  } else if (reconnect && lastBleTransport?.canReconnect) {
    transport = lastBleTransport;
  } else {
    transport = makeTransport(false);
  }

  const isReusing = !demo && reconnect && transport === lastBleTransport;
  state.transport = transport;
  state.connection = 'connecting';
  state.phase = 'disconnected';
  state.isDemo = demo;
  state.connecting = true;
  state.failingSafe = false;
  state.battery = null;
  state.actual = { A: 0, B: 0 };
  state.target = { A: 0, B: 0 };
  state.pending = null;
  state.gateOpen = true;
  state.zero.active = false;
  closeAllSheets();
  renderAll();
  toast(demo ? '正在启动本地演示…' : '正在连接 Coyote V3…', { duration: 5000 });

  try {
    const info = isReusing ? await transport.reconnect() : await transport.requestAndConnect();
    if (state.transport !== transport) return;

    // Give Android's GATT stack a moment, then enforce BF limits before any UI
    // is allowed to arm. The zero frame also removes any intensity left over
    // from a previous session/controller. No B1 is requested here (seq 0).
    await delay(80);
    await transport.writeBF(bfPayload());
    await transport.write(encodeB0Frame({
      sequence: 0,
      modeA: MODE.ABSOLUTE,
      modeB: MODE.ABSOLUTE,
      intensityA: 0,
      intensityB: 0,
      samplesA: silentSamples(),
      samplesB: silentSamples(),
    }));
    if (state.transport !== transport) return;
    if (!transport.connected) throw new Error('设备在初始化时断开了连接。');

    state.connection = 'connected';
    state.connecting = false;
    state.phase = 'locked';
    state.isDemo = Boolean(info.isDemo);
    state.name = info.name || 'Coyote V3';
    state.battery = Number.isFinite(info.battery) ? info.battery : null;
    state.seq = 0;
    state.pending = null;
    state.gateOpen = true;
    state.target = { A: 0, B: 0 };
    state.dirty = { A: false, B: false };
    state.actual = { A: 0, B: 0 };
    state.patternStartedAt = performance.now();

    if (!state.isDemo) lastBleTransport = transport;

    addEvent(
      `${state.isDemo ? '演示设备' : state.name} 已连接 · BF 上限 A ${settings.limitA} / B ${settings.limitB}`,
    );
    if (Number.isFinite(state.battery)) addEvent(`设备电量 ${state.battery}%`);
    startCommandLoop();
    startBatteryPolling();
    renderAll();
    updateWaveformFooters(performance.now());
    window.scrollTo({ top: 0, behavior: 'smooth' });
    haptic([10, 30, 10]);
    if (state.isDemo) {
      toast('演示模式已连接 · 不会产生真实输出。', { type: 'warn', duration: 5200 });
    } else {
      toast('Coyote V3 已连接 · 安全锁已启用。', { type: 'success', duration: 4200 });
    }
  } catch (error) {
    if (state.transport !== transport) return;
    state.connecting = false;
    state.connection = 'disconnected';
    state.phase = 'disconnected';
    state.transport = null;
    state.gateOpen = true;
    state.pending = null;
    state.zero.active = false;
    try { await transport.disconnect({ intentional: true }); } catch { /* noop */ }
    if (!demo && transport.canReconnect) lastBleTransport = transport;
    addEvent(describeError(error), 'error');
    renderAll();
    toast(describeError(error), { type: 'error', duration: 6500 });
  }
}

function startBatteryPolling() {
  clearInterval(state.batteryTimer);
  state.batteryTimer = setInterval(async () => {
    if (state.connection !== 'connected' || !state.transport) return;
    // Do not interleave optional GATT reads with the 10 Hz output stream.
    if (state.phase === 'armed' || state.phase === 'arming' || state.phase === 'stopping') return;
    const battery = await state.transport.readBattery();
    if (Number.isFinite(battery)) {
      state.battery = battery;
      renderConnection();
    }
  }, 120_000);
}

function handleUnexpectedDisconnect(transport, info) {
  if (state.transport !== transport) return;
  const wasActive = state.phase === 'armed' || state.phase === 'arming' || state.phase === 'stopping';
  stopCommandLoop();
  clearInterval(state.batteryTimer);
  state.batteryTimer = null;
  clearInterval(state.session.interval);
  state.session.interval = null;
  releaseWakeLock();
  state.pending = null;
  state.zero.active = false;
  if (!transport.isDemo && transport.canReconnect) lastBleTransport = transport;
  addEvent(`蓝牙断开${wasActive ? '（输出期间）' : ''}${info?.reason ? `：${info.reason}` : ''}`, 'error');
  finishDisconnected({
    toastMessage: wasActive
      ? '蓝牙连接中断，已停止发送波形。请确认主机状态，必要时关闭主机电源。'
      : '蓝牙连接已断开。',
    toastType: 'error',
    wasActive,
  });
}

async function disconnectManually() {
  if (state.connection !== 'connected' || !state.transport) {
    closeAllSheets();
    return;
  }
  const transport = state.transport;
  closeAllSheets();
  const needsZero = state.actual.A > 0
    || state.actual.B > 0
    || state.phase === 'armed'
    || state.phase === 'arming'
    || state.phase === 'stopping';
  if (needsZero) {
    emergencyStop('用户断开连接', { silent: true });
    await delay(420);
    if (state.transport !== transport) return;
  }
  stopCommandLoop();
  clearInterval(state.batteryTimer);
  state.batteryTimer = null;
  clearInterval(state.session.interval);
  state.session.interval = null;
  releaseWakeLock();
  state.pending = null;
  state.zero.active = false;
  try { await transport.disconnect({ intentional: true }); } catch { /* noop */ }
  if (!transport.isDemo && transport.canReconnect) lastBleTransport = transport;
  finishDisconnected({
    toastMessage: '已断开连接。若设备仍有输出，请关闭主机电源。',
    toastType: 'info',
  });
  addEvent('用户主动断开连接');
}

function finishDisconnected({ toastMessage = '', toastType = 'info', wasActive = false, scrollTop = true } = {}) {
  stopCommandLoop();
  clearInterval(state.batteryTimer);
  state.batteryTimer = null;
  clearInterval(state.session.interval);
  state.session.interval = null;
  clearTimeout(state.toastTimer);
  releaseWakeLock();

  state.connection = 'disconnected';
  state.phase = 'disconnected';
  state.connecting = false;
  state.failingSafe = false;
  state.transport = null;
  state.isDemo = false;
  state.name = 'Coyote V3';
  state.battery = null;
  state.pending = null;
  state.gateOpen = true;
  state.actual = { A: 0, B: 0 };
  state.target = { A: 0, B: 0 };
  state.dirty = { A: false, B: false };
  state.zero.active = false;
  state.session.startedAt = null;
  state.session.autoStopAt = null;
  state.armDeadline = 0;
  state.writeCount = 0;
  cancelArmHold();

  renderAll();
  updateWaveformFooters(performance.now());
  if (toastMessage) toast(toastMessage, { type: toastType, duration: 6200 });
  if (scrollTop) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleVisibilityChange() {
  if (document.hidden) {
    cancelArmHold();
    releaseWakeLock();
    if (settings.backgroundStop && (state.phase === 'armed' || state.phase === 'arming')) {
      state.hiddenStop = true;
      addEvent('页面进入后台，自动急停', 'warn');
      emergencyStop('页面进入后台', { silent: true });
    }
  } else {
    if (state.hiddenStop) {
      state.hiddenStop = false;
      toast('已从后台返回 · 输出保持锁定。', { type: 'warn' });
    }
    if (state.phase === 'armed') requestWakeLock();
  }
}

/* -------------------------------------------------------------------------- */
/* Arm hold / stepper interaction                                             */
/* -------------------------------------------------------------------------- */

function startArmHold(event) {
  if (state.connection !== 'connected' || state.phase !== 'locked' || state.armHold.active) return;
  if (event?.pointerId !== undefined && event?.button !== undefined && event.button !== 0) return;
  if (event?.preventDefault) event.preventDefault();

  state.armHold.active = true;
  state.armHold.startedAt = performance.now();
  state.armHold.pointerId = event?.pointerId ?? null;
  ui.armBtn.classList.add('is-holding');
  if (event?.pointerId !== undefined && ui.armBtn.setPointerCapture) {
    try { ui.armBtn.setPointerCapture(event.pointerId); } catch { /* noop */ }
  }
  haptic(5);

  const frame = () => {
    if (!state.armHold.active) return;
    const progress = Math.min(1, (performance.now() - state.armHold.startedAt) / 1000);
    ui.armProgress.style.width = `${progress * 100}%`;
    if (progress >= 1) {
      completeArmHold();
      return;
    }
    state.armHold.raf = requestAnimationFrame(frame);
  };
  state.armHold.raf = requestAnimationFrame(frame);
}

function cancelArmHold() {
  if (!state.armHold.active) {
    if (ui.armProgress) ui.armProgress.style.width = '0%';
    return;
  }
  state.armHold.active = false;
  cancelAnimationFrame(state.armHold.raf);
  state.armHold.raf = 0;
  ui.armBtn.classList.remove('is-holding');
  ui.armProgress.style.width = '0%';
}

function completeArmHold() {
  state.armHold.active = false;
  cancelAnimationFrame(state.armHold.raf);
  state.armHold.raf = 0;
  ui.armBtn.classList.remove('is-holding');
  ui.armProgress.style.width = '0%';
  haptic([12, 24, 12]);
  beginArming();
}

function attachStepper(button, channel, delta) {
  let delayTimer = null;
  let repeatTimer = null;

  const stop = () => {
    clearTimeout(delayTimer);
    clearInterval(repeatTimer);
    delayTimer = null;
    repeatTimer = null;
  };

  const nudge = (withHaptic) => {
    if (button.disabled || !isArmed()) return;
    const before = state.target[channel];
    sendIntensityDelta(channel, delta);
    if (withHaptic && state.target[channel] !== before) haptic(delta > 0 ? 5 : 3);
  };

  button.addEventListener('pointerdown', (event) => {
    if (button.disabled) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    stop();
    nudge(true);
    if (button.setPointerCapture) {
      try { button.setPointerCapture(event.pointerId); } catch { /* noop */ }
    }
    delayTimer = setTimeout(() => {
      repeatTimer = setInterval(() => nudge(false), 82);
    }, 380);
  });

  for (const eventName of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
    button.addEventListener(eventName, stop);
  }

  button.addEventListener('click', (event) => {
    if (event.detail === 0) nudge(true);
  });

  button.addEventListener('contextmenu', (event) => event.preventDefault());
}

/* -------------------------------------------------------------------------- */
/* Settings and safety actions                                                */
/* -------------------------------------------------------------------------- */

function openSettings(focusChannel = null) {
  syncSettingsInputs();
  showSheet(ui.settingsDialog);
  if (focusChannel) {
    requestAnimationFrame(() => {
      const input = focusChannel === 'A' ? ui.settings.limitInputA : ui.settings.limitInputB;
      input.focus();
      input.select();
    });
  }
}

async function applySafetySettings() {
  const limitA = clampInt(ui.settings.limitInputA.value, 0, 200, settings.limitA);
  const limitB = clampInt(ui.settings.limitInputB.value, 0, 200, settings.limitB);
  Object.assign(settings, { limitA, limitB });
  ui.settings.limitInputA.value = String(limitA);
  ui.settings.limitInputB.value = String(limitB);
  updateLimitWarning();
  saveSettings({ immediate: true });

  for (const channel of ['A', 'B']) {
    const limit = settings[`limit${channel}`];
    // Lowering the cap must never raise the user's chosen target. If the
    // device reports a higher value, the next absolute write brings it down to
    // min(target, limit).
    state.target[channel] = Math.min(state.target[channel], limit);
    if (isArmed() && state.actual[channel] > limit) state.dirty[channel] = true;
    state.revision[channel] += 1;
  }

  ui.settings.applySafetyBtn.disabled = true;
  const previousLabel = ui.settings.applySafetyBtn.textContent;
  ui.settings.applySafetyBtn.textContent = '正在写入…';
  renderAll();

  let writeOk = true;
  if (state.connection === 'connected' && state.transport) {
    try {
      await state.transport.writeBF(bfPayload());
      addEvent(`BF 已写入 · 上限 A ${limitA} / B ${limitB}`);
    } catch (error) {
      writeOk = false;
      addEvent(`BF 写入失败：${error.message || error}`, 'error');
      toast('软上限写入失败。App 仍会按本机上限拦截。', { type: 'error', duration: 5000 });
      if (isArmed() || state.phase === 'arming' || state.phase === 'stopping') {
        emergencyStop('软上限写入失败', {
          message: '软上限未成功写入设备，已急停归零。',
          type: 'error',
        });
      }
    }
  }

  ui.settings.applySafetyBtn.disabled = false;
  ui.settings.applySafetyBtn.textContent = previousLabel;
  renderAll();
  if (writeOk) {
    toast(`软上限已设为 A ${limitA} / B ${limitB}`, { type: 'success' });
    haptic([8, 24, 8]);
  }
}

async function applyBalanceSettings() {
  settings.balance1A = clampInt(ui.settings.balance1A.value, 0, 255, settings.balance1A);
  settings.balance1B = clampInt(ui.settings.balance1B.value, 0, 255, settings.balance1B);
  settings.balance2A = clampInt(ui.settings.balance2A.value, 0, 255, settings.balance2A);
  settings.balance2B = clampInt(ui.settings.balance2B.value, 0, 255, settings.balance2B);
  saveSettings({ immediate: true });

  ui.settings.applyBalanceBtn.disabled = true;
  const previousLabel = ui.settings.applyBalanceBtn.textContent;
  ui.settings.applyBalanceBtn.textContent = '正在写入…';
  try {
    if (state.connection === 'connected' && state.transport) {
      await state.transport.writeBF(bfPayload());
      addEvent('平衡参数 BF 已写入');
      toast('平衡参数已写入设备。', { type: 'success' });
    } else {
      toast('已保存，将在连接设备时写入。', { type: 'info' });
    }
  } catch (error) {
    addEvent(`平衡参数写入失败：${error.message || error}`, 'error');
    toast('平衡参数写入失败。', { type: 'error' });
  } finally {
    ui.settings.applyBalanceBtn.disabled = false;
    ui.settings.applyBalanceBtn.textContent = previousLabel;
  }
}

function resetPreferences() {
  if (state.connection === 'connected' && (state.phase === 'armed' || state.phase === 'arming' || state.phase === 'stopping')) {
    toast('请先急停并回到安全锁，再重置偏好。', { type: 'warn' });
    return;
  }
  const confirmed = window.confirm('重置所有本机偏好？软上限会恢复为 A/B = 30，并写入已连接的设备。');
  if (!confirmed) return;
  settings = { ...DEFAULT_SETTINGS };
  saveSettings({ immediate: true });
  for (const channel of ['A', 'B']) {
    state.target[channel] = Math.min(state.target[channel], settings[`limit${channel}`]);
    state.revision[channel] += 1;
  }
  syncPatternControls();
  syncSettingsInputs();
  safeStorageRemove(SAFETY_ACK_KEY);
  state.acknowledged = false;
  addEvent('本机偏好已重置');
  renderAll();
  closeAllSheets();
  toast('已重置本机偏好。', { type: 'success' });
  if (state.connection === 'connected' && state.transport) {
    state.transport.writeBF(bfPayload())
      .then(() => addEvent('重置后的 BF 软上限已写入设备'))
      .catch((error) => addEvent(`重置后的 BF 写入失败：${error.message || error}`, 'error'));
  }
}

function setSoftLimitFromShortcut(channel) {
  openSettings(channel);
}

/* -------------------------------------------------------------------------- */
/* Dialog helpers                                                             */
/* -------------------------------------------------------------------------- */

function showSheet(dialog) {
  if (!dialog) return;
  for (const other of [ui.onboardingDialog, ui.deviceDialog, ui.settingsDialog]) {
    if (other !== dialog && other.open) other.close();
  }
  if (!dialog.open) {
    try {
      dialog.showModal();
      // Native dialog focus lands on the first keyboard-focusable element,
      // which paints a large focus ring on the close button. Put initial focus
      // on the dialog container instead; Tab still reaches every control.
      dialog.tabIndex = -1;
      dialog.focus({ preventScroll: true });
    } catch {
      // Already open.
    }
  }
}

function closeSheet(dialog) {
  if (dialog?.open) dialog.close();
}

function closeAllSheets() {
  for (const dialog of [ui.onboardingDialog, ui.deviceDialog, ui.settingsDialog]) {
    if (dialog.open) dialog.close();
  }
}

function openOnboarding({ review = false } = {}) {
  if (ui.onboardingDialog.open) return;
  ui.onboardingAcceptBtn.textContent = review ? '关闭安全说明' : '我已了解，进入控制台';
  ui.onboardingDialog.dataset.review = review ? 'true' : 'false';
  showSheet(ui.onboardingDialog);
}

function acceptOnboarding() {
  state.acknowledged = true;
  safeStorageSet(SAFETY_ACK_KEY, '1');
  ui.onboardingDialog.close();
  addEvent('已确认安全提示');
  haptic(8);
}

/* -------------------------------------------------------------------------- */
/* Connection UI / support / install                                          */
/* -------------------------------------------------------------------------- */

function updateCompatibility() {
  const secure = isSecureForBluetooth();
  const usable = canUseBluetooth();
  ui.heroConnectBtn.disabled = !usable;
  ui.dialogConnectBtn.disabled = !usable;

  if (usable) {
    ui.compatNotice.hidden = true;
    return;
  }

  ui.compatNotice.hidden = false;
  if (!secure) {
    ui.compatTitle.textContent = '需要 HTTPS 安全连接';
    ui.compatText.textContent = 'Android Chrome 只会在 HTTPS 或 localhost 下开放蓝牙。请把本站部署到 HTTPS 静态托管，或在电脑上使用 adb reverse 访问 localhost。';
  } else {
    ui.compatTitle.textContent = '此浏览器不支持 Web Bluetooth';
    ui.compatText.textContent = '请使用 Android Chrome 打开。微信、QQ、系统浏览器和普通 WebView 通常不提供蓝牙 API。';
  }
}

function updateOnlineStatus() {
  if (isNativeBleAvailable()) {
    ui.networkBanner.hidden = true;
    return;
  }
  ui.networkBanner.hidden = navigator.onLine;
  if (!navigator.onLine) {
    ui.networkText.textContent = '离线模式：页面已缓存，蓝牙控制不受影响。';
  }
}

function refreshInstallButtons() {
  if (isNativeBleAvailable()) {
    ui.installBtn.hidden = true;
    ui.installBtnHero.hidden = true;
    return;
  }
  const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
    || window.navigator.standalone === true;
  const canInstall = Boolean(state.installPrompt) && !standalone;
  ui.installBtn.hidden = !canInstall;
  ui.installBtnHero.hidden = !canInstall;
}

async function triggerInstall() {
  if (!state.installPrompt) {
    toast('请用 Chrome 菜单中的“添加到主屏幕 / 安装应用”。', { type: 'info', duration: 5000 });
    return;
  }
  try {
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
  } finally {
    state.installPrompt = null;
    refreshInstallButtons();
  }
}

function registerServiceWorker() {
  if (isNativeBleAvailable()) return;
  if (!('serviceWorker' in navigator)) return;
  if (!isSecureForBluetooth()) return;
  navigator.serviceWorker.register('./sw.js', { scope: './' })
    .then(() => {
      addEvent('离线缓存已就绪');
    })
    .catch(() => {
      addEvent('Service Worker 注册失败，在线功能不受影响', 'warn');
    });
}

function setupInstallPrompt() {
  if (isNativeBleAvailable()) {
    refreshInstallButtons();
    return;
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    refreshInstallButtons();
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    refreshInstallButtons();
    toast('已安装到主屏幕。', { type: 'success' });
    addEvent('PWA 已安装');
  });
  refreshInstallButtons();
}

function setupNativeMode() {
  if (!isNativeBleAvailable()) return;
  document.body.classList.add('is-native');
  document.title = 'PULSE/LAB · Android';
  const eyebrow = document.getElementById('heroEyebrowLabel');
  const copy = document.getElementById('heroCopy');
  if (eyebrow) eyebrow.textContent = 'ANDROID · BLUETOOTH LE';
  if (copy) {
    copy.textContent = '在 Android 上直接连接 Coyote V3。无需网络、无云端中转，所有指令只在本机与设备之间传输。';
  }
  const webNotes = document.getElementById('webConnectionNotes');
  const nativeNotes = document.getElementById('nativeConnectionNotes');
  if (webNotes) webNotes.hidden = true;
  if (nativeNotes) nativeNotes.hidden = false;
  ui.installBtn.hidden = true;
  ui.installBtnHero.hidden = true;
  // Let the Activity's WebViewClient hand external documentation links to the
  // system browser instead of opening a second WebView window.
  for (const anchor of document.querySelectorAll('a[target="_blank"]')) {
    anchor.removeAttribute('target');
  }

  // Called by the native Activity when Android backgrounds the WebView.
  window.__pulseLabNativePause = () => {
    if (!settings.backgroundStop) return;
    if (state.connection !== 'connected') return;
    if (state.phase !== 'armed' && state.phase !== 'arming') return;
    addEvent('Android 切到后台，自动急停', 'warn');
    emergencyStop('Android 切到后台', { silent: true });
  };

  // Called by the native back/exit confirmation.
  window.__pulseLabForceStop = () => {
    if (state.connection !== 'connected') return false;
    addEvent('Android 应用退出，请求急停', 'warn');
    emergencyStop('Android 应用退出', { silent: true });
    return true;
  };
}

/* -------------------------------------------------------------------------- */
/* Event binding                                                              */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  ui.heroConnectBtn.addEventListener('click', () => beginConnection({ demo: false }));
  ui.dialogConnectBtn.addEventListener('click', () => beginConnection({ demo: false }));
  ui.heroDemoBtn.addEventListener('click', () => beginConnection({ demo: true }));
  ui.dialogDemoBtn.addEventListener('click', () => beginConnection({ demo: true }));
  ui.reconnectBtn.addEventListener('click', () => beginConnection({ demo: false, reconnect: true }));

  ui.deviceBtn.addEventListener('click', () => {
    renderDeviceDialog();
    showSheet(ui.deviceDialog);
  });
  ui.settingsBtn.addEventListener('click', () => openSettings());
  ui.dockMenuBtn.addEventListener('click', () => openSettings());
  ui.openSafetyBtn.addEventListener('click', () => openSettings());
  ui.compatHelpBtn.addEventListener('click', () => showSheet(ui.deviceDialog));
  ui.quickZeroBtn.addEventListener('click', () => {
    emergencyStop('手动归零', { message: '已发送归零指令，等待设备回执。' });
  });
  ui.disconnectBtn.addEventListener('click', () => { void disconnectManually(); });

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => closeSheet(button.closest('dialog')));
  }
  for (const dialog of [ui.deviceDialog, ui.settingsDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  ui.onboardingDialog.addEventListener('cancel', (event) => {
    const isReview = ui.onboardingDialog.dataset.review === 'true';
    if (!state.acknowledged && !isReview) event.preventDefault();
  });
  ui.onboardingDialog.addEventListener('click', (event) => {
    if (event.target === ui.onboardingDialog && state.acknowledged) ui.onboardingDialog.close();
  });
  ui.onboardingAcceptBtn.addEventListener('click', acceptOnboarding);

  // Arm and emergency stop.
  ui.armBtn.addEventListener('pointerdown', startArmHold);
  ui.armBtn.addEventListener('pointerup', cancelArmHold);
  ui.armBtn.addEventListener('pointercancel', cancelArmHold);
  ui.armBtn.addEventListener('lostpointercapture', cancelArmHold);
  ui.armBtn.addEventListener('contextmenu', (event) => event.preventDefault());
  ui.armBtn.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      startArmHold(null);
    }
  });
  ui.armBtn.addEventListener('keyup', (event) => {
    if (event.key === ' ' || event.key === 'Enter') cancelArmHold();
  });
  ui.armBtn.addEventListener('blur', cancelArmHold);
  ui.armBtn.addEventListener('click', (event) => event.preventDefault());
  ui.estopBtn.addEventListener('click', () => {
    if (state.phase === 'stopping') return;
    if (state.phase === 'arming') {
      emergencyStop('取消启用', { message: '已取消启用，正在归零。' });
    } else {
      emergencyStop('用户急停', { message: '已急停，正在确认设备归零。' });
    }
  });

  // Channel controls.
  attachStepper(channelElements.A.dec, 'A', -1);
  attachStepper(channelElements.A.inc, 'A', 1);
  attachStepper(channelElements.B.dec, 'B', -1);
  attachStepper(channelElements.B.inc, 'B', 1);

  for (const channel of ['A', 'B']) {
    channelElements[channel].limitButton.addEventListener('click', () => setSoftLimitFromShortcut(channel));
    channelElements[channel].toggle.addEventListener('click', () => {
      if (!isConfigured()) return;
      const key = `enabled${channel}`;
      settings[key] = !settings[key];
      saveSettings();
      addEvent(`${channel} 通道波形${settings[key] ? '开启' : '静音'}`);
      haptic(6);
      renderChannels();
    });
    channelElements[channel].select.addEventListener('change', () => {
      if (!isConfigured()) return;
      const key = `pattern${channel}`;
      if (!PATTERN_IDS.has(channelElements[channel].select.value)) return;
      settings[key] = channelElements[channel].select.value;
      saveSettings();
      addEvent(`${channel} 通道波形切换为「${getPatternInfo(settings[key]).name}」`);
      haptic(4);
      renderChannels();
    });
  }

  for (const button of ui.speedControl.querySelectorAll('button[data-speed]')) {
    button.addEventListener('click', () => {
      if (!isConfigured()) return;
      const speed = Number(button.dataset.speed);
      if (!SPEEDS.includes(speed)) return;
      settings.speed = speed;
      saveSettings();
      syncPatternControls();
      renderChannels();
      haptic(4);
    });
  }

  ui.depthRange.addEventListener('input', () => {
    settings.depth = clampInt(ui.depthRange.value, 10, 100, settings.depth);
    ui.depthValue.textContent = String(settings.depth);
    updateRangeProgress(ui.depthRange, settings.depth, 10, 100);
    saveSettings();
  });

  // Settings.
  ui.settings.limitInputA.addEventListener('input', updateLimitWarning);
  ui.settings.limitInputB.addEventListener('input', updateLimitWarning);
  ui.settings.applySafetyBtn.addEventListener('click', () => { void applySafetySettings(); });
  ui.settings.applyBalanceBtn.addEventListener('click', () => { void applyBalanceSettings(); });
  ui.settings.backgroundStopSwitch.addEventListener('change', () => {
    settings.backgroundStop = ui.settings.backgroundStopSwitch.checked;
    saveSettings({ immediate: true });
    addEvent(`后台自动急停${settings.backgroundStop ? '开启' : '关闭'}`, settings.backgroundStop ? 'info' : 'warn');
    if (!settings.backgroundStop) {
      toast('已关闭后台急停：切换 App 或锁屏时不会自动归零，请谨慎使用。', {
        type: 'warn',
        duration: 6000,
      });
    }
  });
  ui.settings.hapticsSwitch.addEventListener('change', () => {
    settings.haptics = ui.settings.hapticsSwitch.checked;
    saveSettings({ immediate: true });
    if (settings.haptics) haptic(8);
  });
  ui.settings.autoStopSelect.addEventListener('change', () => {
    settings.autoStopMinutes = clampInt(ui.settings.autoStopSelect.value, 0, 45, settings.autoStopMinutes);
    if (!AUTO_STOP_OPTIONS.includes(settings.autoStopMinutes)) settings.autoStopMinutes = DEFAULT_SETTINGS.autoStopMinutes;
    saveSettings({ immediate: true });
    syncSettingsInputs();
    if (state.phase === 'armed') configureSessionClock();
    addEvent(`自动停止设为 ${settings.autoStopMinutes || '关闭'}`);
  });
  for (const key of ['balance1A', 'balance1B', 'balance2A', 'balance2B']) {
    const input = ui.settings[key];
    const output = ui.settings[`${key}Value`];
    input.addEventListener('input', () => updateBalanceRange(input, output));
  }
  ui.settings.showSafetyBtn.addEventListener('click', () => openOnboarding({ review: true }));
  ui.settings.resetPrefsBtn.addEventListener('click', resetPreferences);

  // Install and PWA.
  ui.installBtn.addEventListener('click', () => { void triggerInstall(); });
  ui.installBtnHero.addEventListener('click', () => { void triggerInstall(); });
  ui.toast.addEventListener('click', () => {
    clearTimeout(state.toastTimer);
    ui.toast.hidden = true;
  });

  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', () => {
    cancelArmHold();
    releaseWakeLock();
    if (state.phase === 'armed' || state.phase === 'arming') {
      emergencyStop('页面关闭', { silent: true });
    }
  });
  window.addEventListener('blur', cancelArmHold);

  // Keep the layout honest on orientation changes.
  window.addEventListener('resize', () => {
    if (window.visualViewport) updateWaveformFooters(performance.now());
  });
}

/* -------------------------------------------------------------------------- */
/* Canvas animation loop                                                      */
/* -------------------------------------------------------------------------- */

function animationLoop(now) {
  if (now - state.lastDraw > 32) {
    state.lastDraw = now;
    for (const channel of ['A', 'B']) {
      const config = {
        active: state.phase === 'armed' && settings[`enabled${channel}`],
        speed: settings.speed,
        depth: settings.depth,
        patternId: settings[`pattern${channel}`],
      };
      scopes[channel].draw(now, config);
    }
  }
  state.raf = requestAnimationFrame(animationLoop);
}

/* -------------------------------------------------------------------------- */
/* Init                                                                       */
/* -------------------------------------------------------------------------- */

function init() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  populatePatternSelects();
  bindEvents();
  syncPatternControls();
  syncSettingsInputs();
  setupNativeMode();
  setupInstallPrompt();
  updateCompatibility();
  updateOnlineStatus();
  registerServiceWorker();
  renderAll();
  updateWaveformFooters(performance.now());

  addEvent('控制器已加载，等待连接');
  if (!state.acknowledged) {
    setTimeout(() => openOnboarding(), 320);
  }
  state.raf = requestAnimationFrame(animationLoop);
}

init();
