import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { RunClassification } from './views/RunClassification'
import { ReviewTable } from './views/ReviewTable'
import { ProposedThreads } from './views/ProposedThreads'
import { EntityBrowser } from './views/EntityBrowser'
import { ClusterExplorer } from './views/ClusterExplorer'
import { CrypticQueue } from './views/CrypticQueue'
import { Export } from './views/Export'
import { Ingest } from './views/VideoPipeline/Ingest'
import { Extract } from './views/VideoPipeline/Extract'
import { VideoCluster } from './views/VideoPipeline/Cluster'
import { Synthesize } from './views/VideoPipeline/Synthesize'
import { VideoReview } from './views/VideoPipeline/Review'
import { ModelCompare } from './views/ModelCompare'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/run" replace />} />
        <Route path="/run" element={<RunClassification />} />
        <Route path="/review" element={<ReviewTable />} />
        <Route path="/proposed-threads" element={<ProposedThreads />} />
        <Route path="/entities" element={<EntityBrowser />} />
        <Route path="/clusters" element={<ClusterExplorer />} />
        <Route path="/cryptic" element={<CrypticQueue />} />
        <Route path="/export" element={<Export />} />
        <Route path="/video/ingest" element={<Ingest />} />
        <Route path="/video/extract" element={<Extract />} />
        <Route path="/video/cluster" element={<VideoCluster />} />
        <Route path="/video/synthesize" element={<Synthesize />} />
        <Route path="/video/review" element={<VideoReview />} />
        <Route path="/model-compare" element={<ModelCompare />} />
      </Routes>
    </Layout>
  )
}
