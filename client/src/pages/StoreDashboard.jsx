import { useEffect, useState } from 'react';
import { useApp } from '../store/AppContext';
import { ACTIONS } from '../store/AppContext';
import api from '../services/api';

export default function StoreDashboard() {
  const { state, dispatch } = useApp();
  const { user, shipments } = state;
  const [loading, setLoading] = useState(false);
  const [showNewShipmentForm, setShowNewShipmentForm] = useState(false);

  const myShipments = shipments;
  const active = myShipments.filter(s => !['Delivered', 'Cancelled'].includes(s.status));
  const quotes = myShipments.filter(s => s.status === 'Quote ready');
  const inTransit = myShipments.filter(s => s.status === 'In transit');
  const delivered = myShipments.filter(s => s.status === 'Delivered');

  const handleLogout = async () => {
    try {
      await api.logout();
      dispatch({ type: ACTIONS.LOGOUT });
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const handleAcceptQuote = async (shipmentId) => {
    setLoading(true);
    try {
      const updated = await api.updateShipment(shipmentId, 'acceptQuote', { version: shipments.find(s => s.id === shipmentId)?.version });
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
          <h1>Store Dashboard</h1>
          <p>Welcome, {user?.name}</p>
        </div>
        <div>
          <button onClick={() => setShowNewShipmentForm(true)} className="btn btn-primary" style={{ marginRight: '1rem' }}>
            + New Delivery Request
          </button>
          <button onClick={handleLogout} className="btn btn-secondary">
            Logout
          </button>
        </div>
      </header>

      <div className="stats-grid">
        <div className="stat-card">
          <h3>Active Deliveries</h3>
          <div className="stat-number">{active.length}</div>
        </div>
        <div className="stat-card">
          <h3>Quotes to Review</h3>
          <div className="stat-number">{quotes.length}</div>
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

      {showNewShipmentForm && (
        <NewShipmentForm
          onClose={() => setShowNewShipmentForm(false)}
          onSuccess={(newShipment) => {
            dispatch({ type: ACTIONS.ADD_SHIPMENT, payload: newShipment });
            setShowNewShipmentForm(false);
          }}
        />
      )}

      {quotes.length > 0 && (
        <section className="dashboard-section">
          <h2>Quotes Ready for Review</h2>
          <div className="shipment-grid">
            {quotes.map(shipment => (
              <div key={shipment.id} className="shipment-card">
                <div className="shipment-header">
                  <h3>{shipment.id}</h3>
                  <span className="badge badge-warning">Quote Ready</span>
                </div>
                <div className="shipment-body">
                  <p><strong>Route:</strong> {shipment.pickup} → {shipment.destination}</p>
                  <p><strong>Date:</strong> {shipment.date}</p>
                  <p><strong>Quote:</strong> ${shipment.price}</p>
                  <p><strong>Cargo:</strong> {shipment.pallets} pallets, {shipment.kg}kg</p>
                </div>
                <div className="shipment-actions">
                  <button
                    onClick={() => handleAcceptQuote(shipment.id)}
                    className="btn btn-primary"
                    disabled={loading}
                  >
                    Accept Quote
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="dashboard-section">
        <h2>All Deliveries</h2>
        <div className="table-container">
          <table className="shipments-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Destination</th>
                <th>Date</th>
                <th>Status</th>
                <th>Quote</th>
              </tr>
            </thead>
            <tbody>
              {myShipments.map(shipment => (
                <tr key={shipment.id}>
                  <td>{shipment.id}</td>
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

function NewShipmentForm({ onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    pickup: '',
    destination: '',
    date: '',
    window: '09:00–12:00',
    goods: '',
    pallets: '',
    kg: '',
    type: 'Box truck',
    unloading: 'Store has a loading dock',
    pickupContact: '',
    receivingContact: '',
    notes: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const shipment = await api.createShipment({
        ...formData,
        pallets: Number(formData.pallets),
        kg: Number(formData.kg),
      });
      onSuccess(shipment);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Delivery Request</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>

        <form onSubmit={handleSubmit} className="form">
          <div className="form-field">
            <label>Pickup Address</label>
            <input
              name="pickup"
              required
              value={formData.pickup}
              onChange={handleChange}
              placeholder="Warehouse address"
            />
          </div>

          <div className="form-field">
            <label>Delivery Destination</label>
            <input
              name="destination"
              required
              value={formData.destination}
              onChange={handleChange}
              placeholder="Store address"
            />
          </div>

          <div className="form-row">
            <div className="form-field">
              <label>Pickup Date</label>
              <input
                name="date"
                type="date"
                required
                value={formData.date}
                onChange={handleChange}
              />
            </div>

            <div className="form-field">
              <label>Pickup Window</label>
              <select name="window" value={formData.window} onChange={handleChange}>
                <option value="09:00–12:00">09:00–12:00</option>
                <option value="13:00–16:00">13:00–16:00</option>
                <option value="Flexible">Flexible</option>
              </select>
            </div>
          </div>

          <div className="form-field">
            <label>Goods Description</label>
            <input
              name="goods"
              required
              value={formData.goods}
              onChange={handleChange}
              placeholder="e.g., boxed household supplies"
            />
          </div>

          <div className="form-row">
            <div className="form-field">
              <label>Pallets</label>
              <input
                name="pallets"
                type="number"
                required
                min="1"
                value={formData.pallets}
                onChange={handleChange}
              />
            </div>

            <div className="form-field">
              <label>Weight (kg)</label>
              <input
                name="kg"
                type="number"
                required
                min="1"
                value={formData.kg}
                onChange={handleChange}
              />
            </div>

            <div className="form-field">
              <label>Vehicle Type</label>
              <select name="type" value={formData.type} onChange={handleChange}>
                <option value="Box truck">Box truck</option>
                <option value="Dry van">Dry van</option>
              </select>
            </div>
          </div>

          <div className="form-field">
            <label>Unloading</label>
            <select name="unloading" value={formData.unloading} onChange={handleChange}>
              <option value="Store has a loading dock">Store has a loading dock</option>
              <option value="Liftgate required">Liftgate required</option>
              <option value="Confirm with store">Confirm with store</option>
            </select>
          </div>

          <div className="form-field">
            <label>Pickup Contact</label>
            <input
              name="pickupContact"
              required
              value={formData.pickupContact}
              onChange={handleChange}
            />
          </div>

          <div className="form-field">
            <label>Receiving Contact</label>
            <input
              name="receivingContact"
              required
              value={formData.receivingContact}
              onChange={handleChange}
            />
          </div>

          <div className="form-field">
            <label>Notes (optional)</label>
            <textarea
              name="notes"
              value={formData.notes}
              onChange={handleChange}
              placeholder="Special instructions"
            />
          </div>

          {error && (
            <div className="error-message">{error}</div>
          )}

          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Creating...' : 'Create Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
