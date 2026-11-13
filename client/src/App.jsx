import { useApp } from './store/AppContext';
import Login from './pages/Login';
import Register from './pages/Register';
import DriverDashboard from './pages/DriverDashboard';
import StoreDashboard from './pages/StoreDashboard';
import AdminDashboard from './pages/AdminDashboard';
import { useState, useEffect } from 'react';

export default function App() {
  const { state } = useApp();
  const { isAuthenticated, role } = state;
  const [route, setRoute] = useState(window.location.hash.slice(1) || '/');

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(window.location.hash.slice(1) || '/');
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Routing logic - simple hash-based routing
  if (!isAuthenticated) {
    if (route === '/register') {
      return <Register />;
    }
    return <Login />;
  }

  // Role-based dashboard - NO ROLE SWITCHING
  // Each account is locked to its registered role
  switch (role) {
    case 'driver':
      return <DriverDashboard />;
    case 'store':
      return <StoreDashboard />;
    case 'admin':
      return <AdminDashboard />;
    default:
      return (
        <div className="error-container">
          <h1>Invalid Role</h1>
          <p>Your account role is not recognized. Please contact support.</p>
        </div>
      );
  }
}
