import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAudioRoutes } from '../engine/output-device.mjs';
const captures = [{ id: 'physical', name: 'USB Mic', default: true }, { id: 'virtual', name: 'CABLE Output' }];
const renders = [{ id: 'cable', name: 'CABLE Input' }, { id: 'phones', name: 'Headphones' }];
const check = (settings, extra = {}) => validateAudioRoutes({ settings, output: { deviceId: 'cable' }, captures, renders, ...extra });
test('pins default physical input and monitor to endpoint IDs', () => {
  const routes = check({ monitorDevice: 'Headphones' });
  assert.equal(routes.input.id, 'physical');
  assert.equal(routes.monitor.id, 'phones');
});
test('rejects virtual input, including a virtual Windows default', () => {
  assert.throws(() => check({ micDeviceId: 'virtual' }), { code: 'audio_route_invalid' });
  assert.throws(() => check({}, { captures: [{ ...captures[1], default: true }] }), { code: 'audio_route_invalid' });
});
test('rejects same output/monitor by ID or name and missing devices', () => {
  for (const monitorDevice of ['cable', 'CABLE Input', 'missing']) assert.throws(() => check({ monitorDevice }), { code: 'audio_route_invalid' });
  assert.throws(() => check({ micDeviceId: 'unplugged' }), { code: 'audio_route_invalid' });
});
test('physical test output cannot also be the monitor; ambiguous names fail closed', () => {
  assert.throws(() => check({ monitorDevice: 'Headphones' }, { output: { deviceId: 'phones' } }), { code: 'audio_route_invalid' });
  assert.throws(() => check({ monitorDevice: 'Headphones' }, { renders: [...renders, { id: 'phones2', name: 'Headphones' }] }), { code: 'audio_route_invalid' });
});
