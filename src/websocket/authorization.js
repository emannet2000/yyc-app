/** Recheck the live session and ownership before subscribing to private updates. */
export async function authorizeShipment(token, shipmentId, { session, getShipment }) {
  if (typeof shipmentId !== 'string' || !/^YYC-[0-9]+$/.test(shipmentId)) {
    throw new Error('Shipment access denied');
  }
  const authenticated = await session(token);
  if (!authenticated) throw new Error('Authentication required');
  const user = authenticated.user;
  const shipment = await getShipment(shipmentId);
  if (!shipment || !(user.role === 'admin' ||
      (user.role === 'store' && shipment.store_id === user.id) ||
      (user.role === 'driver' && (shipment.driver_id === user.id || shipment.offered_to === user.id)))) {
    throw new Error('Shipment access denied');
  }
  return user;
}
