// Hub reviews (owner): versions submitted to the Data, Broker and Seed hubs waiting for approval.
import HubReviewsPanel from '@/legacy/control/HubReviewsPanel';
import '@/legacy/compat.css';

export default function ControlHubReviews() {
  return (
    <div className="m-page">
      <div className="m-head"><h1>Hub reviews</h1><p>Submitted versions waiting for approval.</p></div>
      <HubReviewsPanel />
    </div>
  );
}
