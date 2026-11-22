/**
 * Web Bluetooth transport for Coyote V3 and a local simulator.
 *
 * Only BLE-level concerns live here. The safety state machine belongs to the
 * controller in app.js.
 */

import {
  MODE,
  PROTOCOL,
  encodeBFFrame,
  normalizeIntensity,
  parseBattery,
  parseNotification,
} from './protocol.js';

const CONTROL_SERVICE = '0000180c-0000-1000-8000-00805f9b34fb';
const WRITE_CHARACTERISTIC = '0000150a-0000-1000-8000-00805f9b34fb';
const NOTIFY_CHARACTERISTIC = '0000150b-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const BATTERY_CHARACTERISTIC = '00001500-0000-1000-8000-00805f9b34fb';

export function isWebBluetoothSupported() {
  return typeof navigator !== 'undefined'
    && Boolean(navigator.bluetooth)
    && typeof navigator.bluetooth.requestDevice === 'function';
}

/** True inside the Android APK shell, where a native BLE bridge is injected. */
export function isNativeBleAvailable() {
  try {
    return typeof window !== 'undefined'
      && Boolean(window.PulseLabNative)
      && window.PulseLabNative.isAvailable() === true;
  } catch {
    return false;
  }
}

export function isSecureForBluetooth() {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function bluetoothSetupError(message, cause) {
  const error = new Error(message);
  error.cause = cause;
  return error;
}

export class CoyoteBleTransport {
  constructor({ onNotification, onDisconnect } = {}) {
    this.kind = 'ble';
    this.isDemo = false;
    this.device = null;
    this.server = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
    this.batteryCharacteristic = null;
    this.connected = false;
    this.connecting = false;
    this._intentionalDisconnect = false;
    this._deviceListenerAttached = false;
    this._writeQueue = Promise.resolve();
    this._onNotification = onNotification ?? (() => {});
    this._onDisconnect = onDisconnect ?? (() => {});
    this._handleDisconnected = this._handleDisconnected.bind(this);
    this._handleNotification = this._handleNotification.bind(this);
  }

  get name() {
    return this.device?.name || 'Coyote V3';
  }

  get id() {
    return this.device?.id || '';
  }

  get canReconnect() {
    return Boolean(this.device?.gatt);
  }

  get connectionInfo() {
    return {
      kind: this.kind,
      name: this.name,
      id: this.id,
      isDemo: false,
      writeMode: this.writeCharacteristic?.properties?.writeWithoutResponse ? 'without-response' : 'with-response',
    };
  }

  /** Must be called directly from a user gesture to preserve activation. */
  async requestAndConnect() {
    if (!isWebBluetoothSupported()) {
      throw new Error('此浏览器不支持 Web Bluetooth，请使用 Android Chrome。');
    }

    this.connecting = true;
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: '47L' },
          { services: [PROTOCOL.SERVICE_CONTROL] },
        ],
        optionalServices: [CONTROL_SERVICE, BATTERY_SERVICE],
      });
    } catch (error) {
      this.connecting = false;
      throw error;
    }

    return this._connectDevice(device);
  }

  async reconnect() {
    if (!this.device) throw new Error('没有可重连的设备，请重新搜索。');
    this.connecting = true;
    return this._connectDevice(this.device);
  }

  async _connectDevice(device) {
    this.device = device;
    this._intentionalDisconnect = false;

    if (!this._deviceListenerAttached) {
      device.addEventListener('gattserverdisconnected', this._handleDisconnected);
      this._deviceListenerAttached = true;
    }

    try {
      if (!device.gatt) throw new Error('设备没有提供 GATT 服务。');

      const server = await withTimeout(device.gatt.connect(), 15000, '连接超时，请靠近设备后重试。');
      this.server = server;

      let mainService;
      try {
        mainService = await withTimeout(
          server.getPrimaryService(CONTROL_SERVICE),
          10000,
          '没有找到 Coyote 控制服务（180C）。',
        );
      } catch (error) {
        throw bluetoothSetupError('没有找到 Coyote 控制服务（180C）。请选择 47L121000 主机。', error);
      }

      let writeCharacteristic;
      try {
        writeCharacteristic = await withTimeout(
          mainService.getCharacteristic(WRITE_CHARACTERISTIC),
          8000,
          '没有找到写入特征（150A）。',
        );
      } catch (error) {
        throw bluetoothSetupError('没有找到写入特征（150A）。设备可能不是 Coyote V3。', error);
      }

      let notifyCharacteristic;
      try {
        notifyCharacteristic = await withTimeout(
          mainService.getCharacteristic(NOTIFY_CHARACTERISTIC),
          8000,
          '没有找到通知特征（150B）。',
        );
      } catch (error) {
        throw bluetoothSetupError('没有找到通知特征（150B）。设备可能不是 Coyote V3。', error);
      }

      // Bind before subscribing so an initial notification cannot race us.
      notifyCharacteristic.addEventListener('characteristicvaluechanged', this._handleNotification);
      try {
        await withTimeout(notifyCharacteristic.startNotifications(), 8000, '订阅设备通知失败。');
      } catch (error) {
        notifyCharacteristic.removeEventListener('characteristicvaluechanged', this._handleNotification);
        throw bluetoothSetupError('订阅设备通知失败，请重新连接。', error);
      }

      this.writeCharacteristic = writeCharacteristic;
      this.notifyCharacteristic = notifyCharacteristic;
      this.connected = true;
      this.connecting = false;

      let battery = null;
      try {
        const batteryService = await withTimeout(
          server.getPrimaryService(BATTERY_SERVICE),
          5000,
          '电量服务不可用。',
        );
        this.batteryCharacteristic = await withTimeout(
          batteryService.getCharacteristic(BATTERY_CHARACTERISTIC),
          5000,
          '电量特征不可用。',
        );
        const value = await withTimeout(this.batteryCharacteristic.readValue(), 5000, '读取电量超时。');
        battery = parseBattery(value);
      } catch {
        // Battery is optional. A Coyote still works if this service is absent.
        this.batteryCharacteristic = null;
      }

      return {
        ...this.connectionInfo,
        battery,
      };
    } catch (error) {
      this.connecting = false;
      this._intentionalDisconnect = true;
      this._cleanupGatt({ keepDevice: true });
      if (device.gatt?.connected) {
        try { device.gatt.disconnect(); } catch { /* noop */ }
      }
      throw bluetoothSetupError(error?.message || '蓝牙连接失败。', error);
    }
  }

  async write(frame) {
    if (!this.connected || !this.writeCharacteristic) {
      throw new Error('蓝牙尚未连接。');
    }

    // Web Bluetooth may reject overlapping GATT operations. Queue every write,
    // including the priority zero frame, so commands observe BLE ordering.
    const perform = async () => {
      if (!this.connected || !this.writeCharacteristic) {
        throw new Error('蓝牙尚未连接。');
      }

      const characteristic = this.writeCharacteristic;
      try {
        if (characteristic.properties?.writeWithoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') {
          await withTimeout(characteristic.writeValueWithoutResponse(frame), 2500, '蓝牙写入超时。');
        } else if (typeof characteristic.writeValueWithResponse === 'function') {
          await withTimeout(characteristic.writeValueWithResponse(frame), 2500, '蓝牙写入超时。');
        } else {
          await withTimeout(characteristic.writeValue(frame), 2500, '蓝牙写入超时。');
        }
      } catch (error) {
        throw bluetoothSetupError(error?.message || '蓝牙写入失败。', error);
      }
    };

    const task = this._writeQueue.then(perform, perform);
    this._writeQueue = task.catch(() => {});
    return task;
  }

  async writeBF(options) {
    await this.write(encodeBFFrame(options));
  }

  async readBattery() {
    if (!this.connected || !this.batteryCharacteristic) return null;
    try {
      const value = await withTimeout(this.batteryCharacteristic.readValue(), 4000, '读取电量超时。');
      return parseBattery(value);
    } catch {
      return null;
    }
  }

  async disconnect({ intentional = true } = {}) {
    this._intentionalDisconnect = intentional;
    this.connecting = false;
    const device = this.device;
    this._cleanupGatt({ keepDevice: true });
    try {
      if (device?.gatt?.connected) device.gatt.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  _cleanupGatt({ keepDevice = true } = {}) {
    const notifyCharacteristic = this.notifyCharacteristic;
    if (notifyCharacteristic) {
      notifyCharacteristic.removeEventListener('characteristicvaluechanged', this._handleNotification);
      try { notifyCharacteristic.stopNotifications(); } catch { /* noop */ }
    }

    this.connected = false;
    this.server = null;
    this.writeCharacteristic = null;
    this.notifyCharacteristic = null;
    this.batteryCharacteristic = null;
    if (!keepDevice) {
      if (this.device && this._deviceListenerAttached) {
        this.device.removeEventListener('gattserverdisconnected', this._handleDisconnected);
      }
      this._deviceListenerAttached = false;
      this.device = null;
    }
  }

  _handleNotification(event) {
    const value = event?.target?.value;
    if (!value) return;
    const message = parseNotification(value);
    if (message) this._onNotification(message, value);
  }

  _handleDisconnected() {
    const intentional = this._intentionalDisconnect;
    this._cleanupGatt({ keepDevice: true });
    this.connecting = false;
    if (!intentional) {
      this._onDisconnect({ reason: 'unexpected', name: this.name });
    }
    this._intentionalDisconnect = false;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Android APK transport. This talks to CoyoteBleBridge through the
 * PulseLabNative JavascriptInterface, preserving the same transport contract
 * as the Web Bluetooth implementation.
 */
export class NativeCoyoteTransport {
  constructor({ onNotification, onDisconnect } = {}) {
    this.kind = 'native';
    this.isDemo = false;
    this.connected = false;
    this.connecting = false;
    this.hasConnected = false;
    this.name = 'Coyote V3';
    this.id = 'native';
    this.battery = null;
    this._intentionalDisconnect = false;
    this._requests = new Map();
    this._nextRequestId = 1;
    this._onNotification = onNotification ?? (() => {});
    this._onDisconnect = onDisconnect ?? (() => {});
    this._installBridgeHandler();
  }

  get canReconnect() {
    return this.hasConnected && isNativeBleAvailable();
  }

  get connectionInfo() {
    return {
      kind: this.kind,
      name: this.name,
      id: this.id,
      isDemo: false,
      writeMode: 'native',
    };
  }

  async requestAndConnect() {
    this._intentionalDisconnect = false;
    this.connecting = true;
    try {
      const event = await this._request('connect', {}, 120_000);
      this.connected = true;
      this.connecting = false;
      this.hasConnected = true;
      this._applyConnectedEvent(event);
      return {
        ...this.connectionInfo,
        battery: this.battery,
      };
    } catch (error) {
      this.connecting = false;
      this.connected = false;
      this._sendNative('disconnect', {});
      throw error;
    }
  }

  async reconnect() {
    this._intentionalDisconnect = false;
    this.connecting = true;
    try {
      const event = await this._request('reconnect', {}, 60_000);
      this.connected = true;
      this.connecting = false;
      this.hasConnected = true;
      this._applyConnectedEvent(event);
      return {
        ...this.connectionInfo,
        battery: this.battery,
      };
    } catch (error) {
      this.connecting = false;
      this.connected = false;
      this._sendNative('disconnect', {});
      throw error;
    }
  }

  async write(frame) {
    if (!this.connected) throw new Error('蓝牙尚未连接。');
    await this._request('write', { data: bytesToBase64(frame) }, 4_000);
  }

  async writeBF(options) {
    await this.write(encodeBFFrame(options));
  }

  async readBattery() {
    return Number.isFinite(this.battery) ? this.battery : null;
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    this.connected = false;
    this.connecting = false;
    this._sendNative('disconnect', {});
    this._rejectAll(new Error('连接已断开。'));
  }

  _installBridgeHandler() {
    if (typeof window === 'undefined') return;
    window.pulseLabOnNativeEvent = (json) => {
      try {
        const event = typeof json === 'string' ? JSON.parse(json) : json;
        this._handleNativeEvent(event);
      } catch (error) {
        this._onDisconnect({ reason: error?.message || '无法解析原生蓝牙事件' });
      }
    };
  }

  _sendNative(action, payload) {
    try {
      window.PulseLabNative?.send(action, JSON.stringify(payload));
    } catch {
      // The page is being torn down.
    }
  }

  _request(action, payload, timeoutMs) {
    if (!isNativeBleAvailable()) {
      return Promise.reject(new Error('原生蓝牙桥不可用。'));
    }
    const id = this._nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._requests.delete(id);
        reject(new Error('原生蓝牙操作超时。'));
      }, timeoutMs);
      this._requests.set(id, { resolve, reject, timer });
      try {
        window.PulseLabNative.send(action, JSON.stringify({ ...payload, id }));
      } catch (error) {
        clearTimeout(timer);
        this._requests.delete(id);
        reject(new Error(`原生蓝牙调用失败：${error?.message || error}`));
      }
    });
  }

  _takeRequest(id) {
    const request = this._requests.get(id);
    if (!request) return null;
    clearTimeout(request.timer);
    this._requests.delete(id);
    return request;
  }

  _rejectAll(error) {
    for (const [id, request] of this._requests) {
      clearTimeout(request.timer);
      request.reject(error);
      this._requests.delete(id);
    }
  }

  _applyConnectedEvent(event) {
    this.name = event.name || 'Coyote V3';
    this.id = event.address || 'native';
    this.battery = Number.isFinite(event.battery) ? event.battery : null;
    this.connected = true;
    this.hasConnected = true;
  }

  _handleNativeEvent(event) {
    if (!event || typeof event !== 'object') return;
    switch (event.event) {
      case 'connected': {
        const request = this._takeRequest(event.id);
        if (!request) {
          // The JS request was abandoned. Do not leave an unreachable native
          // GATT connection alive.
          this._sendNative('disconnect', {});
          return;
        }
        this._applyConnectedEvent(event);
        this.connecting = false;
        request.resolve(event);
        break;
      }
      case 'writeResult': {
        const request = this._takeRequest(event.id);
        if (!request) return;
        if (event.ok) request.resolve(true);
        else request.reject(new Error(event.message || '蓝牙写入失败。'));
        break;
      }
      case 'notification': {
        if (!this.connected || !event.data) return;
        const bytes = base64ToBytes(event.data);
        const message = parseNotification(new DataView(bytes.buffer));
        if (message) this._onNotification(message, new DataView(bytes.buffer));
        break;
      }
      case 'battery': {
        if (Number.isFinite(event.level)) this.battery = event.level;
        break;
      }
      case 'disconnected': {
        const wasIntentional = this._intentionalDisconnect;
        this._intentionalDisconnect = false;
        this.connected = false;
        this.connecting = false;
        this._rejectAll(new Error(event.reason || '蓝牙已断开。'));
        if (!wasIntentional) {
          this._onDisconnect({
            reason: event.reason || 'unexpected',
            name: this.name,
          });
        }
        break;
      }
      case 'error': {
        const message = event.message || '原生蓝牙错误。';
        if (Number.isFinite(event.id)) {
          const request = this._takeRequest(event.id);
          if (request) request.reject(new Error(message));
        } else if (this.connected) {
          this.connected = false;
          this._rejectAll(new Error(message));
          this._onDisconnect({ reason: message, name: this.name });
        }
        break;
      }
      default:
        break;
    }
  }
}

/**
 * A faithful-enough local device for UI and safety-flow testing.
 * It never touches hardware. It applies the same two-bit intensity modes and
 * emits B1 acknowledgements after a small latency.
 */
export class DemoTransport {
  constructor({ onNotification, onDisconnect } = {}) {
    this.kind = 'demo';
    this.isDemo = true;
    this.connected = false;
    this.connecting = false;
    this.name = 'Coyote V3 · 演示';
    this.id = 'demo-coyote-v3';
    this._onNotification = onNotification ?? (() => {});
    this._onDisconnect = onDisconnect ?? (() => {});
    this._intensityA = 0;
    this._intensityB = 0;
    this._limitA = 30;
    this._limitB = 30;
    this._writeTimer = null;
  }

  get canReconnect() {
    return false;
  }

  get connectionInfo() {
    return {
      kind: this.kind,
      name: this.name,
      id: this.id,
      isDemo: true,
      writeMode: 'simulated',
    };
  }

  async requestAndConnect() {
    this.connecting = true;
    await new Promise((resolve) => setTimeout(resolve, 380));
    this.connected = true;
    this.connecting = false;
    return {
      ...this.connectionInfo,
      battery: 86,
    };
  }

  async reconnect() {
    return this.requestAndConnect();
  }

  async write(frame) {
    if (!this.connected) throw new Error('模拟器尚未连接。');
    if (!(frame instanceof Uint8Array) || frame.length < 1) return;

    if (frame[0] === PROTOCOL.HEADER_BF && frame.length >= 7) {
      this._limitA = frame[1];
      this._limitB = frame[2];
      return;
    }

    if (frame[0] !== PROTOCOL.HEADER_B0 || frame.length < 20) return;

    const control = frame[1];
    const sequence = (control >> 4) & 0x0f;
    const modeA = (control >> 2) & 0x03;
    const modeB = control & 0x03;
    const settingA = frame[2];
    const settingB = frame[3];
    const beforeA = this._intensityA;
    const beforeB = this._intensityB;

    if (modeA !== MODE.HOLD) this._intensityA = this._applyMode(this._intensityA, modeA, settingA, this._limitA);
    if (modeB !== MODE.HOLD) this._intensityB = this._applyMode(this._intensityB, modeB, settingB, this._limitB);

    // The real device documents B1 as a reaction to an intensity *change*. A
    // non-zero sequence on a no-op command therefore may not produce a reply.
    const changed = beforeA !== this._intensityA || beforeB !== this._intensityB;
    if (sequence !== 0 && changed) {
      clearTimeout(this._writeTimer);
      this._writeTimer = setTimeout(() => {
        if (!this.connected) return;
        const packet = new Uint8Array([0xb1, sequence, this._intensityA, this._intensityB]);
        this._onNotification(
          {
            type: 'B1',
            sequence,
            intensityA: this._intensityA,
            intensityB: this._intensityB,
          },
          new DataView(packet.buffer),
        );
      }, 22);
    }
  }

  async writeBF(options) {
    this._limitA = normalizeIntensity(options.limitA);
    this._limitB = normalizeIntensity(options.limitB);
    await this.write(encodeBFFrame(options));
  }

  async readBattery() {
    return this.connected ? 86 : null;
  }

  async disconnect() {
    this.connected = false;
    clearTimeout(this._writeTimer);
    this._writeTimer = null;
  }

  _applyMode(current, mode, setting, limit) {
    const value = normalizeIntensity(setting);
    let next = current;
    if (mode === MODE.ABSOLUTE) next = value;
    if (mode === MODE.INCREASE) next = current + value;
    if (mode === MODE.DECREASE) next = current - value;
    return Math.min(limit, Math.max(0, next));
  }
}

export const BLE_UUIDS = Object.freeze({
  CONTROL_SERVICE,
  WRITE_CHARACTERISTIC,
  NOTIFY_CHARACTERISTIC,
  BATTERY_SERVICE,
  BATTERY_CHARACTERISTIC,
});
