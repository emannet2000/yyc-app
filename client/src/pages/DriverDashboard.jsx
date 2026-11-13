import { useEffect, useState } from 'react';
import { useApp } from '../store/AppContext';
import { ACTIONS } from '../store/AppContext';
import api from '../services/api';

export default function DriverDashboard() {
  const { state, dispatch } = useApp();
  const { user, shipments } = state;
  const [loading, setLoading] = useState(false);

  const myShipments = shipments.filter(s => s.driver || s.offeredTo === user?.id);
  const activeJobs = myShipments.filter(s => ['Assigned', 'In transit'].includes(s.status));
  const offers = myShipments.filter(s => s.status === 'Offered');
  const completed = myShipments.filter(s => s.status === 'Delivered');

  const handleLogout = async () => {
    try {
      await api.logout();
      dispatch({ type: ACTIONS.LOGOUT });
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const handleAcceptJob = async (shipmentId) => {
    setLoading(true);
    try {
      const updated = await api.updateShipment(shipmentId, 'acceptJob', { version: shipments.find(s => s.id === shipmentId)?.version });
      dispatch({ type: ACTIONS.UPDATE_SHIPMENT, payload: updated });
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeclineJob = async (shipmentId) => {
    setLoading(true);
    try {
      const updated = await api.updateShipment(shipmentId, 'decline', { version: shipments.find(s => s.id === shipmentId)?.version });
      dispatch({ type: ACTIONS.UPDATE_SHIPMENT, payload: updated });
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePickup = async (shipmentId) => {
    setLoading(true);
    try {
      const updated = await api.updateShipment(shipmentId, 'pickup', {
        version: shipments.find(s => s.id === shipmentId)?.version,
        recipient: 'Warehouse staff',
        reference: 'PICKUP-' + Date.now(),
      });
      dispatch({ type: ACTIONS.UPDATE_SHIPMENT, payload: updated });
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeliver = async (shipmentId) => {
    const pod = prompt('Enter proof of delivery reference:');
    const recipient = prompt('Enter recipient name:');

    if (!pod || !recipient) return;

    setLoading(true);
    try {
      const updated = await api.updateShipment(shipmentId, 'deliver', {
        version: shipments.find(s => s.id === shipmentId)?.version,
        pod,
        recipient,
      });
      dispatch({ type: ACTIONS.UPDATE_SHIPMENT, payload: updated });
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Driver Dashboard</h1>
          <p>Welcome back, {user?.name}</p>
        </div>
        <button onClick={handleLogout} className="btn btn-secondary">
          Logout
        </button>
      </header>

      <div className="stats-grid">
        <div className="stat-card">
          <h3>Active Jobs</h3>
          <div className="stat-number">{activeJobs.length}</div>
        </div>
        <div className="stat-card">
          <h3>Job Offers</h3>
          <div className="stat-number">{offers.length}</div>
        </div>
        <div className="stat-card">
          <h3>Completed</h3>
          <div className="stat-number">{completed.length}</div>
        </div>
        <div className="stat-card">
          <h3>Total Earnings</h3>
          <div className="stat-number">
            ${completed.reduce((sum, s) => sum + (s.rate || 0), 0).toFixed(0)}
          </div>
        </div>
      </div>

      {offers.length > 0 && (
        <section className="dashboard-section">
          <h2>Job Offers</h2>
          <div className="shipment-grid">
            {offers.map(shipment => (
              <div key={shipment.id} className="shipment-card">
                <div className="shipment-header">
                  <h3>{shipment.id}</h3>
                  <span className="badge badge-warning">Offered</span>
                </div>
                <div className="shipment-body">
                  <p><strong>Route:</strong> {shipment.pickup} → {shipment.destination}</p>
                  <p><strong>Date:</strong> {shipment.date}</p>
                  <p><strong>Rate:</strong> ${shipment.rate}</p>
                  <p><strong>Cargo:</strong> {shipment.pallets} pallets, {shipment.kg}kg</p>
                </div>
                <div className="shipment-actions">
                  <button
                    onClick={() => handleAcceptJob(shipment.id)}
                    className="btn btn-primary"
                    disabled={loading}
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleDeclineJob(shipment.id)}
                    className="btn btn-secondary"
                    disabled={loading}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeJobs.length > 0 && (
        <section className="dashboard-section">
          <h2>Active Jobs</h2>
          <div className="shipment-grid">
            {activeJobs.map(shipment => (
              <div key={shipment.id} className="shipment-card">
                <div className="shipment-header">
                  <h3>{shipment.id}</h3>
                  <span className={`badge ${shipment.status === 'In transit' ? 'badge-info' : 'badge-success'}`}>
                    {shipment.status}
                  </span>
                </div>
                <div className="shipment-body">
                  <p><strong>Route:</strong> {shipment.pickup} → {shipment.destination}</p>
                  <p><strong>Date:</strong> {shipment.date}</p>
                  <p><strong>Rate:</strong> ${shipment.rate}</p>
                </div>
                <div className="shipment-actions">
                  {shipment.status === 'Assigned' && (
                    <button
                      onClick={() => handlePickup(shipment.id)}
                      className="btn btn-primary"
                      disabled={loading}
                    >
                      Confirm Pickup
                    </button>
                  )}
                  {shipment.status === 'In transit' && (
                    <button
                      onClick={() => handleDeliver(shipment.id)}
                      className="btn btn-primary"
                      disabled={loading}
                    >
                      Complete Delivery
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="dashboard-section">
        <h2>Truck Profile</h2>
        <div className="profile-card">
          <p><strong>Name:</strong> {user?.name}</p>
          <p><strong>Email:</strong> {user?.email}</p>
          <p><strong>Truck:</strong> {user?.truck?.plate}</p>
          <p><strong>Status:</strong> {user?.approved ? '✓ Approved' : '⏳ Pending Approval'}</p>
        </div>
      </section>
    </div>
  );
}
