import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeCoyoteTransport, isNativeBleAvailable } from '../js/ble.js';
import { MODE, encodeB0Frame } from '../js/protocol.js';

function installMockBridge() {
  const sent = [];
  const bridge = {
    isAvailable: () => true,
    send: (action, payload) => {
      const body = payload ? JSON.parse(payload) : {};
      sent.push({ action, ...body });
    },
    setKeepScreenOn: () => {},
  };
  const previous = globalThis.window;
  const fakeWindow = {
    PulseLabNative: bridge,
    pulseLabOnNativeEvent: null,
  };
  globalThis.window = fakeWindow;
  return {
    bridge,
    sent,
    fakeWindow,
    emit(event) {
      fakeWindow.pulseLabOnNativeEvent(JSON.stringify(event));
    },
    restore() {
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    },
  };
}

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('native bridge is detected only when the Java interface is available', () => {
  assert.equal(isNativeBleAvailable(), false);
  const mock = installMockBridge();
  try {
    assert.equal(isNativeBleAvailable(), true);
  } finally {
    mock.restore();
  }
});

test('native transport connects, writes, receives notifications and disconnects', async () => {
  const mock = installMockBridge();
  try {
    const notifications = [];
    const disconnects = [];
    const transport = new NativeCoyoteTransport({
      onNotification: (message) => notifications.push(message),
      onDisconnect: (info) => disconnects.push(info),
    });

    const connecting = transport.requestAndConnect();
    await tick();
    const connectRequest = mock.sent.find((entry) => entry.action === 'connect');
    assert.ok(connectRequest, 'native connect should be sent');

    mock.emit({
      event: 'connected',
      id: connectRequest.id,
      name: '47L121000',
      address: 'AA:BB:CC:DD:EE:FF',
      battery: 72,
    });
    const info = await connecting;
    assert.equal(info.name, '47L121000');
    assert.equal(info.battery, 72);
    assert.equal(info.kind, 'native');
    assert.equal(transport.connected, true);
    assert.equal(transport.canReconnect, true);
    assert.equal(await transport.readBattery(), 72);

    const frame = encodeB0Frame({
      sequence: 3,
      modeA: MODE.ABSOLUTE,
      intensityA: 12,
      modeB: MODE.HOLD,
    });
    const writing = transport.write(frame);
    await tick();
    const writeRequest = mock.sent.find((entry) => entry.action === 'write');
    assert.ok(writeRequest);
    assert.equal(
      Buffer.from(writeRequest.data, 'base64').toString('hex'),
      Buffer.from(frame).toString('hex'),
    );

    mock.emit({ event: 'writeResult', id: writeRequest.id, ok: true });
    await writing;

    const b1 = Uint8Array.from([0xb1, 3, 12, 0]);
    mock.emit({
      event: 'notification',
      data: Buffer.from(b1).toString('base64'),
    });
    assert.deepEqual(notifications, [{ type: 'B1', sequence: 3, intensityA: 12, intensityB: 0 }]);

    transport.disconnect();
    await tick();
    assert.ok(mock.sent.some((entry) => entry.action === 'disconnect'));
    assert.equal(transport.connected, false);
    assert.equal(disconnects.length, 0, 'intentional disconnect must not fire onDisconnect');
  } finally {
    mock.restore();
  }
});

test('native errors reject the matching request and link loss calls onDisconnect', async () => {
  const mock = installMockBridge();
  try {
    const disconnects = [];
    const transport = new NativeCoyoteTransport({
      onDisconnect: (info) => disconnects.push(info),
    });

    const connecting = transport.requestAndConnect();
    await tick();
    const request = mock.sent.find((entry) => entry.action === 'connect');
    mock.emit({ event: 'error', id: request.id, message: '未找到设备。' });
    await assert.rejects(connecting, /未找到设备/);
    assert.equal(transport.connected, false);

    // A second connect succeeds, then an unexpected GATT loss arrives.
    const second = transport.requestAndConnect();
    await tick();
    const request2 = mock.sent.filter((entry) => entry.action === 'connect').at(-1);
    mock.emit({
      event: 'connected',
      id: request2.id,
      name: 'Coyote V3',
      battery: 50,
    });
    await second;
    mock.emit({ event: 'disconnected', reason: '设备已断开' });
    await tick();
    assert.equal(transport.connected, false);
    assert.equal(disconnects.length, 1);
    assert.match(disconnects[0].reason, /设备已断开/);
  } finally {
    mock.restore();
  }
});

test('native no-op B0 writes still round-trip through the bridge', async () => {
  const mock = installMockBridge();
  try {
    const transport = new NativeCoyoteTransport({});
    const connecting = transport.requestAndConnect();
    await tick();
    const request = mock.sent.find((entry) => entry.action === 'connect');
    mock.emit({ event: 'connected', id: request.id, name: 'Coyote V3' });
    await connecting;

    const frame = encodeB0Frame({ sequence: 0 });
    const writing = transport.write(frame);
    await tick();
    const writeRequest = mock.sent.filter((entry) => entry.action === 'write').at(-1);
    mock.emit({ event: 'writeResult', id: writeRequest.id, ok: true });
    await writing;
  } finally {
    mock.restore();
  }
});
