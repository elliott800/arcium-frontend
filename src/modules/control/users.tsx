// Users (owner): accounts waiting for approval, invitations, each account's access, and the simulated users.
import AdminAccessPanel from '@/legacy/control/AdminAccessPanel';
import AccessPanel from './AccessPanel';
import '@/legacy/compat.css';

export default function ControlUsers() {
  return (
    <div className="m-page">
      <div className="m-head"><h1>Users</h1><p>Approvals, invitations, access, and simulated users.</p></div>
      <AccessPanel />
      <AdminAccessPanel />
    </div>
  );
}
