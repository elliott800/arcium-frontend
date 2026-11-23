// The live controllers (owner): each machine's launcher with its update and heartbeat controls, as the
// launcher last reported. The Factory's Machine dashboard shows the same machines for day-to-day work.
import LiveControllerPanel from '@/legacy/control/LiveControllerPanel';
import '@/legacy/compat.css';

export default function ControlMachines() {
  return (
    <div className="m-page">
      <div className="m-head"><h1>Live controller</h1><p>Each machine&apos;s launcher, and the commands the site can send it.</p></div>
      <LiveControllerPanel />
    </div>
  );
}
