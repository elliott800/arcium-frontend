// Users (owner): accounts waiting for approval, and invitations.
import AdminAccessPanel from '@/legacy/control/AdminAccessPanel';
import '@/legacy/compat.css';

export default function ControlUsers() {
  return (
    <div className="m-page">
      <div className="m-head"><h1>Users</h1><p>Approvals and invitations.</p></div>
      <AdminAccessPanel />
    </div>
  );
}
