// The Data Hub: Home, Sources, Recorder (with the Recorder Registry and the Source Bundle Maker) and
// Warehouse, each a drill table over its own tree (src/lib/drillTree.ts). Talks to /api/admin/datahub/*.
import DataHubPanel from './view/DataHubPanel';
import './view/datahub.css';
import './view/datahub-layout.css';

export default function DataHubModule() {
  return (
    <div className="m-page dh-module">
      <div className="m-head"><h1>Data Hub</h1><p>What is recorded, from which sources, and what is stored.</p></div>
      <DataHubPanel />
    </div>
  );
}
