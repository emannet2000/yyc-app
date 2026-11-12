/** Recheck the live session and ownership before subscribing to private updates. */
export async function authorizeShipment(token, shipmentId, { session, getShipment, hasStorePermission }) {
  if (typeof shipmentId !== 'string' || !/^YYC-[0-9]+$/.test(shipmentId)) {
    throw new Error('Shipment access denied');
  }
  const authenticated = await session(token);
  if (!authenticated) throw new Error('Authentication required');
  const user = authenticated.user;
  const shipment = await getShipment(shipmentId);
  // Store team members with shipment read access get the same live view as the owner.
  const storeAllowed = user.role === 'store' && shipment && (shipment.store_id === user.id ||
    (hasStorePermission && await hasStorePermission(user, shipment.store_id, 'shipments.read')));
  if (!shipment || !(user.role === 'admin' || storeAllowed ||
      (user.role === 'driver' && (shipment.driver_id === user.id || shipment.offered_to === user.id)))) {
    throw new Error('Shipment access denied');
  }
  return user;
}
