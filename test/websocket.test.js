import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeShipment } from '../src/websocket/authorization.js';

const shipment = { store_id: 'store1', driver_id: 'driver1', offered_to: 'driver2' };
function dependencies(user) {
  return { session: async () => user ? { user } : null, getShipment: async () => shipment };
}
test('shipment subscriptions permit only broker, owner, assigned or offered driver', async () => {
  for (const [role, id] of [['admin', 'broker'], ['store', 'store1'], ['driver', 'driver1'], ['driver', 'driver2']]) {
    assert.equal((await authorizeShipment('token', 'YYC-1001', dependencies({ role, id }))).id, id);
  }
  for (const [role, id] of [['store', 'other'], ['driver', 'other'], ['unknown', 'store1']]) {
    await assert.rejects(authorizeShipment('token', 'YYC-1001', dependencies({ role, id })));
  }
});
test('subscriptions reject revoked sessions, missing shipments and invalid room names', async () => {
  await assert.rejects(authorizeShipment('token', 'YYC-1001', dependencies(null)));
  const deps = dependencies({ role: 'admin', id: 'broker' });
  for (const id of [null, {}, '', 'role:admin', 'YYC-1001:private']) {
    await assert.rejects(authorizeShipment('token', id, deps));
  }
  await assert.rejects(authorizeShipment('token', 'YYC-1001', { ...deps, getShipment: async () => null }));
});
