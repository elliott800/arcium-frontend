// The Release 1 schedule (owner): key events with their tasks folded; tick a task or give it a date.
import SchedulePanel from '@/legacy/control/schedule/page';
import '@/legacy/compat.css';

export default function ControlSchedule() {
  return (
    <div className="m-page">
      <div className="m-head"><h1>Schedule</h1><p>Key events, with their tasks folded.</p></div>
      <SchedulePanel />
    </div>
  );
}
