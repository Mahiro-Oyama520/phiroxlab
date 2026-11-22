import assert from 'node:assert/strict';
import test from 'node:test';

import { CoyoteBleTransport } from '../js/ble.js';
import { MODE, encodeB0Frame, encodeBFFrame } from '../js/protocol.js';

/* ----------------------------- fake Web Bluetooth ---------------------------- */

class FakeCharacteristic extends EventTarget {
  constructor(uuid, properties, value = null) {
    super();
    this.uuid = uuid;
    this.properties = properties;
    this.value = value;
    this.writes = [];
    this.notifying = false;
    this.notificationsStarted = 0;
  }

  async startNotifications() {
    this.notifying = true;
    this.notificationsStarted += 1;
  }

  async stopNotifications() {
    this.notifying = false;
  }

  async readValue() {
    return this.value ?? new DataView(new Uint8Array([78]).buffer);
  }

  async writeValueWithoutResponse(frame) {
    if (!this.notifying && this.uuid.includes('150a')) {
      // Writing is independent of notifications; keep this for realism.
    }
    this.writes.push(Uint8Array.from(frame));
  }

  emitB1(sequence, a, b) {
    const bytes = new Uint8Array([0xb1, sequence, a, b]);
    this.value = new DataView(bytes.buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class FakeGatt {
  constructor(device, services) {
    this.device = device;
    this.services = services;
    this.connected = false;
  }

  async connect() {
    this.connected = true;
    return {
      getPrimaryService: async (uuid) => {
        const service = this.services.get(uuid);
        if (!service) throw new Error(`missing service ${uuid}`);
        return service;
      },
    };
  }

  disconnect() {
    this.connected = false;
    this.device.dispatchEvent(new Event('gattserverdisconnected'));
  }
}

class FakeService {
  constructor(characteristics) {
    this.characteristics = characteristics;
  }

  async getCharacteristic(uuid) {
    const characteristic = this.characteristics.get(uuid);
    if (!characteristic) throw new Error(`missing characteristic ${uuid}`);
    return characteristic;
  }
}

function makeFakeDevice({ withBattery = true, writeWithoutResponse = true } = {}) {
  const device = new EventTarget();
  device.name = '47L121000';
  device.id = 'fake-coyote-id';
  const write = new FakeCharacteristic(
    '0000150a-0000-1000-8000-00805f9b34fb',
    { write: true, writeWithoutResponse },
  );
  const notify = new FakeCharacteristic('0000150b-0000-1000-8000-00805f9b34fb', { notify: true });
  const battery = new FakeCharacteristic(
    '00001500-0000-1000-8000-00805f9b34fb',
    { read: true, notify: true },
    new DataView(new Uint8Array([77]).buffer),
  );
  const services = new Map();
  services.set('0000180c-0000-1000-8000-00805f9b34fb', new FakeService(new Map([
    ['0000150a-0000-1000-8000-00805f9b34fb', write],
    ['0000150b-0000-1000-8000-00805f9b34fb', notify],
  ])));
  if (withBattery) {
    services.set('0000180a-0000-1000-8000-00805f9b34fb', new FakeService(new Map([
      ['00001500-0000-1000-8000-00805f9b34fb', battery],
    ])));
  }
  device.gatt = new FakeGatt(device, services);
  return { device, write, notify, battery };
}

async function withFakeBluetooth(fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let requestedOptions = null;
  const holder = {};
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      bluetooth: {
        requestDevice: async (options) => {
          requestedOptions = options;
          if (!holder.device) throw new Error('no fake device configured');
          return holder.device;
        },
      },
    },
  });
  try {
    return await fn(holder, (device) => {
      holder.device = device;
      return () => requestedOptions;
    });
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}

/* --------------------------------- tests ---------------------------------- */

test('real BLE transport connects, reads battery, writes BF and B0, handles B1', async () => {
  await withFakeBluetooth(async (holder, configure) => {
    const { device, write, notify } = makeFakeDevice();
    const options = configure(device);
    const notifications = [];
    const disconnects = [];
    const transport = new CoyoteBleTransport({
      onNotification: (message) => notifications.push(message),
      onDisconnect: (info) => disconnects.push(info),
    });

    const info = await transport.requestAndConnect();
    assert.equal(info.isDemo, false);
    assert.equal(info.name, '47L121000');
    assert.equal(info.battery, 77);
    assert.equal(info.writeMode, 'without-response');
    assert.equal(notify.notificationsStarted, 1);
    assert.deepEqual(options().optionalServices, [
      '0000180c-0000-1000-8000-00805f9b34fb',
      '0000180a-0000-1000-8000-00805f9b34fb',
    ]);
    assert.deepEqual(options().filters[0], { namePrefix: '47L' });

    await transport.writeBF({ limitA: 30, limitB: 20, balance1A: 128, balance1B: 128, balance2A: 128, balance2B: 128 });
    assert.deepEqual(Array.from(write.writes[0]), Array.from(encodeBFFrame({
      limitA: 30,
      limitB: 20,
      balance1A: 128,
      balance1B: 128,
      balance2A: 128,
      balance2B: 128,
    })));

    const frame = encodeB0Frame({
      sequence: 2,
      modeA: MODE.ABSOLUTE,
      modeB: MODE.HOLD,
      intensityA: 12,
    });
    await transport.write(frame);
    assert.deepEqual(Array.from(write.writes[1]), Array.from(frame));

    notify.emitB1(2, 12, 0);
    assert.deepEqual(notifications, [{ type: 'B1', sequence: 2, intensityA: 12, intensityB: 0 }]);

    assert.equal(transport.canReconnect, true);
    device.gatt.disconnect();
    assert.equal(disconnects.length, 1);
    assert.equal(disconnects[0].reason, 'unexpected');
    assert.equal(transport.connected, false);
  });
});

test('real BLE transport can reconnect the same device', async () => {
  await withFakeBluetooth(async (holder, configure) => {
    const { device, write, notify } = makeFakeDevice();
    configure(device);
    const transport = new CoyoteBleTransport({});
    await transport.requestAndConnect();
    assert.equal(notify.notifying, true);
    await transport.disconnect();
    assert.equal(transport.connected, false);
    assert.equal(notify.notifying, false, 'disconnect should stop notifications');
    const info = await transport.reconnect();
    assert.equal(info.name, '47L121000');
    assert.equal(transport.connected, true);
    assert.equal(notify.notifying, true);
    await transport.write(encodeB0Frame({ sequence: 0 }));
    assert.equal(write.writes.length, 1);
    await transport.disconnect();
  });
});

test('concurrent writes are serialized and preserve order', async () => {
  await withFakeBluetooth(async (holder, configure) => {
    const { device, write } = makeFakeDevice();
    configure(device);
    const transport = new CoyoteBleTransport({});
    await transport.requestAndConnect();

    let busy = false;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    write.writeValueWithoutResponse = async (frame) => {
      if (busy) throw new Error('overlapping GATT write');
      busy = true;
      await delay(15);
      write.writes.push(Uint8Array.from(frame));
      busy = false;
    };

    const first = encodeB0Frame({ sequence: 0 });
    const second = encodeB0Frame({ sequence: 0, intensityA: 4 });
    await Promise.all([transport.write(first), transport.write(second)]);
    assert.equal(write.writes.length, 2);
    assert.deepEqual(Array.from(write.writes[0]), Array.from(first));
    assert.deepEqual(Array.from(write.writes[1]), Array.from(second));
    await transport.disconnect();
  });
});

test('battery absence is non-fatal', async () => {
  await withFakeBluetooth(async (holder, configure) => {
    const { device } = makeFakeDevice({ withBattery: false });
    configure(device);
    const transport = new CoyoteBleTransport({});
    const info = await transport.requestAndConnect();
    assert.equal(info.battery, null);
    assert.equal(transport.connected, true);
    assert.equal(await transport.readBattery(), null);
    await transport.disconnect();
  });
});

test('missing control service rejects and disconnects cleanly', async () => {
  await withFakeBluetooth(async (holder, configure) => {
    const { device } = makeFakeDevice();
    // Remove the control service but leave GATT connectable.
    device.gatt.services.delete('0000180c-0000-1000-8000-00805f9b34fb');
    configure(device);
    const disconnects = [];
    const transport = new CoyoteBleTransport({ onDisconnect: (info) => disconnects.push(info) });
    await assert.rejects(transport.requestAndConnect(), /180C|控制服务/);
    assert.equal(transport.connected, false);
    assert.equal(disconnects.length, 0, 'setup failure is intentional and should not emit a second disconnect');
  });
});
