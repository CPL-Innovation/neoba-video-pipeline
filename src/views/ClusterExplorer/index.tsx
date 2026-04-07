import { useState, useEffect, useRef } from 'react'
import * as d3 from 'd3'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import type { ClusterData, ClusterInfo } from '../../lib/types'

export function ClusterExplorer() {
  const [data, setData] = useState<ClusterData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedCluster, setSelectedCluster] = useState<ClusterInfo | null>(null)
  const [hoveredPoint, setHoveredPoint] = useState<{ item_id: string; x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    fetch('/api/run/latest/clusters')
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!data || !svgRef.current) return

    const svg = d3.select(svgRef.current)
    const width = svgRef.current.clientWidth
    const height = svgRef.current.clientHeight

    svg.selectAll('*').remove()

    const xScale = d3
      .scaleLinear()
      .domain(d3.extent(data.points, (d) => d.x) as [number, number])
      .range([20, width - 20])

    const yScale = d3
      .scaleLinear()
      .domain(d3.extent(data.points, (d) => d.y) as [number, number])
      .range([height - 20, 20])

    svg
      .selectAll('circle')
      .data(data.points)
      .join('circle')
      .attr('cx', (d) => xScale(d.x))
      .attr('cy', (d) => yScale(d.y))
      .attr('r', 2)
      .attr('fill', (d) => (d.cluster_id === -1 ? '#555a66' : d3.schemeTableau10[d.cluster_id % 10]))
      .attr('opacity', 0.6)
      .style('cursor', 'pointer')
      .on('mouseenter', (event, d) => {
        setHoveredPoint({ item_id: d.item_id, x: event.offsetX, y: event.offsetY })
      })
      .on('mouseleave', () => setHoveredPoint(null))
  }, [data])

  return (
    <div>
      <PageHeader
        title="Cluster Explorer"
        description="Visualize Tier 3 semantic clusters. Discover narrative threads the archive 'knows about' that weren't defined."
      />

      {loading ? (
        <p className="text-sm text-text-dim">Loading cluster data...</p>
      ) : !data ? (
        <Card>
          <p className="text-sm text-text-dim">
            No cluster data yet. Run Tier 3 clustering from the Run Classification view first.
          </p>
        </Card>
      ) : (
        <div className="flex gap-5 h-[calc(100vh-10rem)]">
          {/* Scatter plot */}
          <Card className="flex-1 relative" padding={false}>
            <svg ref={svgRef} className="w-full h-full" />
            {hoveredPoint && (
              <div
                className="absolute bg-surface text-xs text-text-primary px-3 py-2 rounded-lg shadow-lg pointer-events-none border border-white/10"
                style={{ left: hoveredPoint.x + 10, top: hoveredPoint.y - 30 }}
              >
                {hoveredPoint.item_id}
              </div>
            )}
          </Card>

          {/* Cluster detail panel */}
          <Card className="w-72 shrink-0 overflow-y-auto">
            <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
              Clusters ({data.clusters.length})
            </h3>
            <div className="space-y-3">
              {data.clusters.map((cluster) => (
                <button
                  key={cluster.cluster_id}
                  onClick={() => setSelectedCluster(cluster)}
                  className={`w-full text-left p-3 rounded-lg transition-colors cursor-pointer ${
                    selectedCluster?.cluster_id === cluster.cluster_id
                      ? 'bg-white/8'
                      : 'hover:bg-white/4'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-text-primary">
                      Cluster {cluster.cluster_id}
                    </span>
                    <span className="text-xs text-text-dim font-mono">
                      {cluster.item_count} items
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {cluster.top_terms.slice(0, 3).map((term) => (
                      <span
                        key={term}
                        className="text-xs bg-white/5 text-text-muted px-1.5 py-0.5 rounded"
                      >
                        {term}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
