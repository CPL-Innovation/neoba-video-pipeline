import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { RunClassification } from './views/RunClassification'
import { ReviewTable } from './views/ReviewTable'
import { ProposedThreads } from './views/ProposedThreads'
import { EntityBrowser } from './views/EntityBrowser'
import { ClusterExplorer } from './views/ClusterExplorer'
import { CrypticQueue } from './views/CrypticQueue'
import { Export } from './views/Export'

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
      </Routes>
    </Layout>
  )
}
