// Hub services (owner): the Data Hub's background services (source manager, tick recorder, seed warehouse...),
// with their state and start / stop / restart.
import HubServicesPanel from '@/legacy/control/HubServicesPanel';
import '@/legacy/compat.css';

export default function ControlServices() {
  return (
    <div className="m-page">
      <div className="m-head"><h1>Hub services</h1><p>The Data Hub&apos;s background services and their controls.</p></div>
      <HubServicesPanel />
    </div>
  );
}
