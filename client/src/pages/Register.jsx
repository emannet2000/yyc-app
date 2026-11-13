import { useState } from 'react';
import { useApp } from '../store/AppContext';
import { ACTIONS } from '../store/AppContext';
import api from '../services/api';

export default function Register() {
  const { dispatch } = useApp();
  const [step, setStep] = useState(1); // 1: role selection, 2: form, 3: verification
  const [role, setRole] = useState(''); // driver, store, admin - LOCKED to account
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    phone: '',
    // Driver fields
    truck: '',
    plate: '',
    type: 'Box truck',
    kg: '',
    pallets: '',
    area: '',
    liftgate: false,
    // Store fields
    address: '',
    contact: '',
    // Admin fields
    brokerCode: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState('');

  const handleChange = (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setFormData({
      ...formData,
      [e.target.name]: value,
    });
    setError('');
  };

  const handleRoleSelect = (selectedRole) => {
    setRole(selectedRole);
    setStep(2);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Validate password match
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    // Validate password length
    if (formData.password.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }

    setLoading(true);

    try {
      const userData = {
        role, // This role is now LOCKED to the account
        name: formData.name,
        email: formData.email,
        password: formData.password,
        phone: formData.phone,
      };

      // Add role-specific fields
      if (role === 'driver') {
        Object.assign(userData, {
          truck: formData.truck,
          plate: formData.plate,
          type: formData.type,
          kg: Number(formData.kg),
          pallets: Number(formData.pallets),
          area: formData.area,
          liftgate: formData.liftgate,
        });
      } else if (role === 'store') {
        Object.assign(userData, {
          address: formData.address,
          contact: formData.contact,
        });
      } else if (role === 'admin') {
        userData.brokerCode = formData.brokerCode;
      }

      const response = await api.register(userData);

      if (response.verificationSkipped) {
        // Testing mode (SKIP_EMAIL_VERIFICATION): no code needed, go straight to login.
        window.location.hash = '/login';
        alert(response.message);
      } else if (role !== 'admin') {
        // For driver and store, email verification is required
        setVerificationEmail(formData.email);
        setStep(3);
      } else {
        // Admin accounts can login immediately
        dispatch({ type: ACTIONS.SET_USER, payload: response.user });
        const state = await api.fetchState();
        dispatch({ type: ACTIONS.SET_SHIPMENTS, payload: state.shipments || [] });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (step === 1) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-header">
            <h1>Join YYC Brokers</h1>
            <p>Choose your account type</p>
          </div>

          <div className="role-selection">
            <button
              className="role-card"
              onClick={() => handleRoleSelect('store')}
            >
              <div className="role-icon">🏪</div>
              <h3>Store Owner</h3>
              <p>I need goods delivered to my store</p>
            </button>

            <button
              className="role-card"
              onClick={() => handleRoleSelect('driver')}
            >
              <div className="role-icon">🚚</div>
              <h3>Driver</h3>
              <p>I have a truck for deliveries</p>
            </button>

            <button
              className="role-card"
              onClick={() => handleRoleSelect('admin')}
            >
              <div className="role-icon">⚙️</div>
              <h3>YYC Broker</h3>
              <p>I manage operations</p>
            </button>
          </div>

          <div className="auth-footer">
            <p>
              Already have an account?{' '}
              <a href="/login" onClick={(e) => {
                e.preventDefault();
                window.location.hash = '/login';
              }}>
                Sign In
              </a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (step === 3) {
    return (
      <EmailVerification
        email={verificationEmail}
        dispatch={dispatch}
      />
    );
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1>Create {role === 'store' ? 'Store Owner' : role === 'driver' ? 'Driver' : 'Broker'} Account</h1>
          <p>Fill in your details to get started</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {/* Common fields */}
          <div className="form-field">
            <label htmlFor="name">
              {role === 'store' ? 'Store / Business Name' : 'Full Name'}
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              value={formData.name}
              onChange={handleChange}
              disabled={loading}
            />
          </div>

          <div className="form-field">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              value={formData.email}
              onChange={handleChange}
              disabled={loading}
            />
          </div>

          <div className="form-field">
            <label htmlFor="phone">Phone Number</label>
            <input
              id="phone"
              name="phone"
              type="tel"
              required
              value={formData.phone}
              onChange={handleChange}
              disabled={loading}
            />
          </div>

          <div className="form-field">
            <label htmlFor="password">Password (min 12 characters)</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              value={formData.password}
              onChange={handleChange}
              disabled={loading}
              minLength={12}
            />
          </div>

          <div className="form-field">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              required
              value={formData.confirmPassword}
              onChange={handleChange}
              disabled={loading}
              minLength={12}
            />
          </div>

          {/* Driver-specific fields */}
          {role === 'driver' && (
            <>
              <div className="form-field">
                <label htmlFor="truck">Truck Make & Model</label>
                <input
                  id="truck"
                  name="truck"
                  type="text"
                  required
                  value={formData.truck}
                  onChange={handleChange}
                  disabled={loading}
                  placeholder="e.g. Freightliner M2"
                />
              </div>

              <div className="form-field">
                <label htmlFor="plate">License Plate</label>
                <input
                  id="plate"
                  name="plate"
                  type="text"
                  required
                  value={formData.plate}
                  onChange={handleChange}
                  disabled={loading}
                />
              </div>

              <div className="form-field">
                <label htmlFor="type">Truck Type</label>
                <select
                  id="type"
                  name="type"
                  value={formData.type}
                  onChange={handleChange}
                  disabled={loading}
                >
                  <option value="Box truck">Box truck</option>
                  <option value="Dry van">Dry van</option>
                </select>
              </div>

              <div className="form-field">
                <label htmlFor="kg">Payload Capacity (kg)</label>
                <input
                  id="kg"
                  name="kg"
                  type="number"
                  required
                  value={formData.kg}
                  onChange={handleChange}
                  disabled={loading}
                  min="1"
                />
              </div>

              <div className="form-field">
                <label htmlFor="pallets">Pallet Capacity</label>
                <input
                  id="pallets"
                  name="pallets"
                  type="number"
                  required
                  value={formData.pallets}
                  onChange={handleChange}
                  disabled={loading}
                  min="1"
                />
              </div>

              <div className="form-field">
                <label htmlFor="area">Service Area</label>
                <input
                  id="area"
                  name="area"
                  type="text"
                  required
                  value={formData.area}
                  onChange={handleChange}
                  disabled={loading}
                  placeholder="Calgary & surrounding areas"
                />
              </div>

              <div className="form-field">
                <label>
                  <input
                    name="liftgate"
                    type="checkbox"
                    checked={formData.liftgate}
                    onChange={handleChange}
                    disabled={loading}
                  />
                  {' '}Truck has a liftgate
                </label>
              </div>
            </>
          )}

          {/* Store-specific fields */}
          {role === 'store' && (
            <>
              <div className="form-field">
                <label htmlFor="address">Store Delivery Address</label>
                <input
                  id="address"
                  name="address"
                  type="text"
                  required
                  value={formData.address}
                  onChange={handleChange}
                  disabled={loading}
                  placeholder="Street, city, province"
                />
              </div>

              <div className="form-field">
                <label htmlFor="contact">Receiving Contact Person</label>
                <input
                  id="contact"
                  name="contact"
                  type="text"
                  required
                  value={formData.contact}
                  onChange={handleChange}
                  disabled={loading}
                />
              </div>
            </>
          )}

          {/* Admin-specific fields */}
          {role === 'admin' && (
            <div className="form-field">
              <label htmlFor="brokerCode">Broker Registration Code</label>
              <input
                id="brokerCode"
                name="brokerCode"
                type="text"
                required
                value={formData.brokerCode}
                onChange={handleChange}
                disabled={loading}
                placeholder="Contact YYC for registration code"
              />
            </div>
          )}

          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setStep(1)}
              disabled={loading}
            >
              Back
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? 'Creating Account...' : 'Create Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Email Verification Component
function EmailVerification({ email, dispatch }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  const handleVerify = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await api.verifyEmail(email, code);

      // After verification, log the user in
      const state = await api.fetchState();
      dispatch({ type: ACTIONS.SET_USER, payload: state.user });
      dispatch({ type: ACTIONS.SET_SHIPMENTS, payload: state.shipments || [] });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError('');
    setResending(true);

    try {
      await api.resendVerificationCode(email);
      setError(''); // Clear any previous errors
      alert('Verification code resent! Check your email.');
    } catch (err) {
      setError(err.message);
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1>Verify Your Email</h1>
          <p>We sent a 6-digit code to {email}</p>
        </div>

        <form onSubmit={handleVerify} className="auth-form">
          <div className="form-field">
            <label htmlFor="code">Verification Code</label>
            <input
              id="code"
              name="code"
              type="text"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={loading}
              placeholder="Enter 6-digit code"
              maxLength={6}
              pattern="[0-9]{6}"
            />
          </div>

          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
          >
            {loading ? 'Verifying...' : 'Verify Email'}
          </button>

          <div className="text-center" style={{ marginTop: '1rem' }}>
            <button
              type="button"
              className="btn-link"
              onClick={handleResend}
              disabled={resending}
            >
              {resending ? 'Resending...' : 'Resend Code'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
