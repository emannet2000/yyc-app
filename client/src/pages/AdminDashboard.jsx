import { useEffect, useState } from 'react';
import { useApp } from '../store/AppContext';
import { ACTIONS } from '../store/AppContext';
import api from '../services/api';

export default function AdminDashboard() {
  const { state, dispatch } = useApp();
  const { user, shipments } = state;
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    // Load all users for admin
    api.getAllUsers()
      .then(data => setUsers(data.users || []))
      .catch(err => console.error('Failed to load users:', err));
  }, []);

  const needsAttention = shipments.filter(s => ['Awaiting quote', 'Ready to assign'].includes(s.status));
  const active = shipments.filter(s => !['Delivered', 'Cancelled'].includes(s.status));
  const inTransit = shipments.filter(s => s.status === 'In transit');
  const delivered = shipments.filter(s => s.status === 'Delivered');

  const handleLogout = async () => {
    try {
      await api.logout();
      dispatch({ type: ACTIONS.LOGOUT });
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const handleSendQuote = async (shipmentId) => {
    const price = prompt('Enter customer quote (CAD):');
    const rate = prompt('Enter driver rate (CAD):');

    if (!price || !rate) return;

    setLoading(true);
    try {
      const updated = await api.updateShipment(shipmentId, 'quote', {
        version: shipments.find(s => s.id === shipmentId)?.version,
        price: Number(price),
        rate: Number(rate),
        expiryHours: 72,
      });
      dispatch({ type: ACTIONS.UPDATE_SHIPMENT, payload: updated });
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleOfferToDriver = async (shipmentId) => {
    const driverId = prompt('Enter driver ID (from pending drivers list):');
    if (!driverId) return;

    setLoading(true);
    try {
      const updated = await api.updateShipment(shipmentId, 'offer', {
        version: shipments.find(s => s.id === shipmentId)?.version,
        driverId,
        expiryHours: 24,
      });
      dispatch({ type: ACTIONS.UPDATE_SHIPMENT, payload: updated });
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleApproveDriver = async (driverId) => {
    setLoading(true);
    try {
      await api.approveDriver(driverId);
      // Refresh users list
      const data = await api.getAllUsers();
      setUsers(data.users || []);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const pendingDrivers = users.filter(u => u.role === 'driver' && !u.approved);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Broker Dashboard</h1>
          <p>YYC Operations - {user?.name}</p>
        </div>
        <button onClick={handleLogout} className="btn btn-secondary">
          Logout
        </button>
      </header>

      <div className="stats-grid">
        <div className="stat-card">
          <h3>Needs Attention</h3>
          <div className="stat-number">{needsAttention.length}</div>
        </div>
        <div className="stat-card">
          <h3>Active Deliveries</h3>
          <div className="stat-number">{active.length}</div>
        </div>
        <div className="stat-card">
          <h3>In Transit</h3>
          <div className="stat-number">{inTransit.length}</div>
        </div>
        <div className="stat-card">
          <h3>Delivered</h3>
          <div className="stat-number">{delivered.length}</div>
        </div>
      </div>

      {pendingDrivers.length > 0 && (
        <section className="dashboard-section">
          <h2>Pending Driver Approvals</h2>
          <div className="table-container">
            <table className="shipments-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Truck</th>
                  <th>Registered</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingDrivers.map(driver => (
                  <tr key={driver.id}>
                    <td>{driver.name}</td>
                    <td>{driver.email}</td>
                    <td>{driver.truck?.plate || 'N/A'}</td>
                    <td>{new Date(driver.created_at).toLocaleDateString()}</td>
                    <td>
                      <button
                        onClick={() => handleApproveDriver(driver.id)}
                        className="btn btn-sm btn-primary"
                        disabled={loading}
                      >
                        Approve
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {needsAttention.length > 0 && (
        <section className="dashboard-section">
          <h2>Deliveries Needing Action</h2>
          <div className="shipment-grid">
            {needsAttention.map(shipment => (
              <div key={shipment.id} className="shipment-card">
                <div className="shipment-header">
                  <h3>{shipment.id}</h3>
                  <span className={`badge badge-${shipment.status === 'Awaiting quote' ? 'warning' : 'info'}`}>
                    {shipment.status}
                  </span>
                </div>
                <div className="shipment-body">
                  <p><strong>Customer:</strong> {shipment.customer}</p>
                  <p><strong>Route:</strong> {shipment.pickup} → {shipment.destination}</p>
                  <p><strong>Date:</strong> {shipment.date}</p>
                  <p><strong>Cargo:</strong> {shipment.pallets} pallets, {shipment.kg}kg</p>
                </div>
                <div className="shipment-actions">
                  {shipment.status === 'Awaiting quote' && (
                    <button
                      onClick={() => handleSendQuote(shipment.id)}
                      className="btn btn-primary"
                      disabled={loading}
                    >
                      Send Quote
                    </button>
                  )}
                  {shipment.status === 'Ready to assign' && (
                    <button
                      onClick={() => handleOfferToDriver(shipment.id)}
                      className="btn btn-primary"
                      disabled={loading}
                    >
                      Offer to Driver
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="dashboard-section">
        <h2>All Shipments</h2>
        <div className="table-container">
          <table className="shipments-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Customer</th>
                <th>Destination</th>
                <th>Date</th>
                <th>Status</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map(shipment => (
                <tr key={shipment.id}>
                  <td>{shipment.id}</td>
                  <td>{shipment.customer}</td>
                  <td>{shipment.destination}</td>
                  <td>{shipment.date}</td>
                  <td>
                    <span className={`badge badge-${getStatusColor(shipment.status)}`}>
                      {shipment.status}
                    </span>
                  </td>
                  <td>{shipment.price ? `$${shipment.price}` : 'Pending'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function getStatusColor(status) {
  const colors = {
    'Awaiting quote': 'secondary',
    'Quote ready': 'warning',
    'Ready to assign': 'info',
    'Offered': 'info',
    'Assigned': 'success',
    'In transit': 'primary',
    'Delivered': 'success',
    'Cancelled': 'danger',
  };
  return colors[status] || 'secondary';
}
