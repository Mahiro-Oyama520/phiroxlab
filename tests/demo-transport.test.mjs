import assert from 'node:assert/strict';
import test from 'node:test';

import { DemoTransport } from '../js/ble.js';
import { MODE, encodeB0Frame, silentSamples } from '../js/protocol.js';

function frameFor(options) {
  return encodeB0Frame({
    samplesA: silentSamples(),
    samplesB: silentSamples(),
    ...options,
  });
}

function waitForNotification(transport, timeout = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('notification timeout')), timeout);
    const original = transport._onNotification;
    transport._onNotification = (message, value) => {
      clearTimeout(timer);
      transport._onNotification = original;
      original?.(message, value);
      resolve(message);
    };
  });
}

test('demo transport connects without hardware and reports a battery', async () => {
  const transport = new DemoTransport({});
  assert.equal(transport.isDemo, true);
  const info = await transport.requestAndConnect();
  assert.equal(transport.connected, true);
  assert.equal(info.isDemo, true);
  assert.equal(info.battery, 86);
  await transport.disconnect();
  assert.equal(transport.connected, false);
});

test('demo applies BF soft limits and B0 absolute intensity with B1 acknowledgement', async () => {
  const transport = new DemoTransport({});
  await transport.requestAndConnect();
  await transport.writeBF({ limitA: 42, limitB: 20, balance1A: 128, balance1B: 128, balance2A: 128, balance2B: 128 });

  const notification = waitForNotification(transport);
  await transport.write(frameFor({
    sequence: 1,
    modeA: MODE.ABSOLUTE,
    intensityA: 99,
    modeB: MODE.ABSOLUTE,
    intensityB: 9,
  }));
  const message = await notification;
  assert.equal(message.sequence, 1);
  assert.equal(message.intensityA, 42, 'A is capped at its soft limit');
  assert.equal(message.intensityB, 9);
  await transport.disconnect();
});

test('demo respects HOLD and relative intensity modes', async () => {
  const transport = new DemoTransport({});
  await transport.requestAndConnect();
  await transport.writeBF({ limitA: 50, limitB: 50, balance1A: 128, balance1B: 128, balance2A: 128, balance2B: 128 });

  let notification = waitForNotification(transport);
  await transport.write(frameFor({
    sequence: 1,
    modeA: MODE.INCREASE,
    intensityA: 10,
    modeB: MODE.INCREASE,
    intensityB: 3,
  }));
  assert.deepEqual(
    { a: (await notification).intensityA, b: (await notification).intensityB },
    { a: 10, b: 3 },
  );

  notification = waitForNotification(transport);
  await transport.write(frameFor({
    sequence: 2,
    modeA: MODE.HOLD,
    intensityA: 0,
    modeB: MODE.DECREASE,
    intensityB: 5,
  }));
  const message = await notification;
  assert.equal(message.intensityA, 10);
  assert.equal(message.intensityB, 0);

  notification = waitForNotification(transport);
  await transport.write(frameFor({
    sequence: 3,
    modeA: MODE.ABSOLUTE,
    intensityA: 0,
    modeB: MODE.ABSOLUTE,
    intensityB: 0,
  }));
  const zero = await notification;
  assert.equal(zero.intensityA, 0);
  assert.equal(zero.intensityB, 0);
  await transport.disconnect();
});

test('demo does not send a B1 for sequence zero', async () => {
  const transport = new DemoTransport({});
  await transport.requestAndConnect();
  let received = 0;
  transport._onNotification = () => { received += 1; };
  await transport.write(frameFor({
    sequence: 0,
    modeA: MODE.ABSOLUTE,
    intensityA: 12,
    modeB: MODE.HOLD,
  }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(received, 0);
  await transport.disconnect();
});

test('demo does not send a B1 when a sequenced command is a no-op', async () => {
  const transport = new DemoTransport({});
  await transport.requestAndConnect();
  let received = 0;
  transport._onNotification = () => { received += 1; };
  await transport.write(frameFor({
    sequence: 4,
    modeA: MODE.ABSOLUTE,
    intensityA: 0,
    modeB: MODE.ABSOLUTE,
    intensityB: 0,
  }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(received, 0, 'a no-change zero command may not produce B1');
  await transport.disconnect();
});
