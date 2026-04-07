import { useState, useEffect, useRef } from 'react'
import * as d3 from 'd3'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import type { ClusterData, ClusterInfo, ClassifiedItem, SourceItem } from '../../lib/types'

interface PointWithMeta {
  item_id: string
  x: number
  y: number
  cluster_id: number
  description?: string
  classification?: ClassifiedItem
}

export function ClusterExplorer() {
  const [data, setData] = useState<ClusterData | null>(null)
  const [points, setPoints] = useState<PointWithMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCluster, setSelectedCluster] = useState<ClusterInfo | null>(null)
  const [hoveredPoint, setHoveredPoint] = useState<{ point: PointWithMeta; x: number; y: number } | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<PointWithMeta | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // Load all data on mount
  useEffect(() => {
    Promise.all([
      fetch('/api/run/latest/clusters').then((r) => r.json()).catch(() => null),
      fetch('/api/run/latest/classifications').then((r) => r.json()).catch(() => []),
      fetch('/api/source/items').then((r) => r.json()).catch(() => []),
    ]).then(([clusterData, classifications, sourceItems]: [ClusterData | null, ClassifiedItem[], SourceItem[]]) => {
      setData(clusterData)

      if (clusterData) {
        const classMap = new Map<string, ClassifiedItem>()
        for (const c of classifications) classMap.set(c.item_id, c)

        const sourceMap = new Map<string, SourceItem>()
        for (const s of sourceItems) sourceMap.set(`${s.container}-${s.item}`, s)

        const enriched: PointWithMeta[] = clusterData.points.map((p) => ({
          ...p,
          description: sourceMap.get(p.item_id)?.description,
          classification: classMap.get(p.item_id),
        }))
        setPoints(enriched)
      }
      setLoading(false)
    })
  }, [])

  // Draw D3 scatter plot with zoom/pan
  useEffect(() => {
    if (!data || !svgRef.current || points.length === 0) return

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

    // Container group that will be transformed by zoom
    const g = svg.append('g').attr('class', 'plot')

    g.selectAll('circle')
      .data(points)
      .join('circle')
      .attr('cx', (d) => xScale(d.x))
      .attr('cy', (d) => yScale(d.y))
      .attr('r', 2)
      .attr('fill', (d) => (d.cluster_id === -1 ? '#555a66' : d3.schemeTableau10[d.cluster_id % 10]))
      .attr('opacity', 0.6)
      .style('cursor', 'pointer')
      .on('mouseenter', (event, d) => {
        const svgRect = svgRef.current!.getBoundingClientRect()
        setHoveredPoint({ point: d, x: event.clientX - svgRect.left, y: event.clientY - svgRect.top })
      })
      .on('mouseleave', () => setHoveredPoint(null))
      .on('click', (_event, d) => {
        setSelectedPoint(d)
        setHoveredPoint(null)
      })

    // Zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 20])
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
        // Dismiss hover during zoom/pan
        setHoveredPoint(null)
      })

    svg.call(zoom)
    // Prevent double-click zoom from interfering with dot clicks
    svg.on('dblclick.zoom', null)
  }, [data, points])

  // Update dot styles and cluster label when selection changes
  useEffect(() => {
    if (!svgRef.current || !data) return
    const svg = d3.select(svgRef.current)
    const plotG = svg.select<SVGGElement>('g.plot')
    if (plotG.empty()) return

    // Remove previous label
    plotG.selectAll('.cluster-label').remove()

    if (selectedCluster) {
      plotG.selectAll<SVGCircleElement, PointWithMeta>('circle')
        .attr('opacity', (d) => (d.cluster_id === selectedCluster.cluster_id ? 1.0 : 0.08))
        .attr('r', (d) => (d.cluster_id === selectedCluster.cluster_id ? 3 : 2))

      // Compute centroid of selected cluster's points
      const clusterPoints = points.filter((p) => p.cluster_id === selectedCluster.cluster_id)
      if (clusterPoints.length > 0) {
        const width = svgRef.current.clientWidth
        const height = svgRef.current.clientHeight
        const xScale = d3.scaleLinear()
          .domain(d3.extent(data.points, (d) => d.x) as [number, number])
          .range([20, width - 20])
        const yScale = d3.scaleLinear()
          .domain(d3.extent(data.points, (d) => d.y) as [number, number])
          .range([height - 20, 20])

        const cx = d3.mean(clusterPoints, (d) => xScale(d.x))!
        const cy = d3.mean(clusterPoints, (d) => yScale(d.y))!

        const label = `Cluster ${selectedCluster.cluster_id}: ${selectedCluster.top_terms.slice(0, 3).join(', ')}`

        // Background rect + text — inside plot group so it zooms/pans with dots
        const labelG = plotG.append('g').attr('class', 'cluster-label')
        const text = labelG.append('text')
          .attr('x', cx)
          .attr('y', cy - 12)
          .attr('text-anchor', 'middle')
          .attr('fill', '#fff')
          .attr('font-size', '11px')
          .attr('font-weight', '500')
          .text(label)

        const bbox = (text.node() as SVGTextElement).getBBox()
        labelG.insert('rect', 'text')
          .attr('x', bbox.x - 6)
          .attr('y', bbox.y - 3)
          .attr('width', bbox.width + 12)
          .attr('height', bbox.height + 6)
          .attr('rx', 4)
          .attr('fill', 'rgba(0,0,0,0.75)')
      }
    } else {
      plotG.selectAll<SVGCircleElement, PointWithMeta>('circle')
        .attr('opacity', 0.6)
        .attr('r', 2)
    }
  }, [selectedCluster, data, points])

  const deselectCluster = () => setSelectedCluster(null)

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

            {/* Hover tooltip */}
            {hoveredPoint && !selectedPoint && (
              <div
                className="absolute bg-surface text-xs text-text-primary px-3 py-2.5 rounded-lg shadow-lg pointer-events-none border border-white/10 max-w-xs z-10"
                style={{
                  left: Math.min(hoveredPoint.x + 12, (svgRef.current?.clientWidth ?? 600) - 280),
                  top: Math.max(hoveredPoint.y - 10, 10),
                }}
              >
                <div className="font-mono text-text-dim mb-1">{hoveredPoint.point.item_id}</div>
                {hoveredPoint.point.description && (
                  <div className="text-text-primary mb-1.5 leading-snug">
                    {hoveredPoint.point.description.length > 120
                      ? hoveredPoint.point.description.slice(0, 120) + '...'
                      : hoveredPoint.point.description}
                  </div>
                )}
                {hoveredPoint.point.classification && (
                  <>
                    {hoveredPoint.point.classification.threads.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {hoveredPoint.point.classification.threads.map((t) => (
                          <span key={t.name} className="bg-maize/15 text-maize px-1.5 py-0.5 rounded text-[10px]">
                            {t.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {(hoveredPoint.point.classification.entities.people.length > 0 ||
                      hoveredPoint.point.classification.entities.places.length > 0) && (
                      <div className="text-text-dim text-[10px]">
                        {hoveredPoint.point.classification.entities.people.slice(0, 3).join(', ')}
                        {hoveredPoint.point.classification.entities.people.length > 0 &&
                          hoveredPoint.point.classification.entities.places.length > 0 && ' · '}
                        {hoveredPoint.point.classification.entities.places.slice(0, 2).join(', ')}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Pinned point detail */}
            {selectedPoint && (
              <div className="absolute top-3 left-3 bg-surface border border-white/10 rounded-lg shadow-xl p-4 max-w-sm z-20">
                <div className="flex items-start justify-between mb-2">
                  <span className="font-mono text-xs text-text-dim">{selectedPoint.item_id}</span>
                  <button
                    onClick={() => setSelectedPoint(null)}
                    className="text-text-dim hover:text-text-primary text-sm leading-none cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
                {selectedPoint.description && (
                  <p className="text-sm text-text-primary mb-3 leading-snug">{selectedPoint.description}</p>
                )}
                {selectedPoint.classification && (
                  <div className="space-y-2.5">
                    {selectedPoint.classification.threads.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1">Threads</div>
                        <div className="flex flex-wrap gap-1">
                          {selectedPoint.classification.threads.map((t) => (
                            <span key={t.name} className="bg-maize/15 text-maize px-1.5 py-0.5 rounded text-xs">
                              {t.name} <span className="text-maize/60">{t.confidence}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedPoint.classification.proposed_thread && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1">Proposed Thread</div>
                        <span className="bg-teal/15 text-teal px-1.5 py-0.5 rounded text-xs">
                          {selectedPoint.classification.proposed_thread}
                        </span>
                      </div>
                    )}
                    {(selectedPoint.classification.entities.people.length > 0 ||
                      selectedPoint.classification.entities.places.length > 0 ||
                      selectedPoint.classification.entities.organizations.length > 0) && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1">Entities</div>
                        <div className="text-xs text-text-muted space-y-0.5">
                          {selectedPoint.classification.entities.people.length > 0 && (
                            <div><span className="text-text-dim">People:</span> {selectedPoint.classification.entities.people.join(', ')}</div>
                          )}
                          {selectedPoint.classification.entities.places.length > 0 && (
                            <div><span className="text-text-dim">Places:</span> {selectedPoint.classification.entities.places.join(', ')}</div>
                          )}
                          {selectedPoint.classification.entities.organizations.length > 0 && (
                            <div><span className="text-text-dim">Orgs:</span> {selectedPoint.classification.entities.organizations.join(', ')}</div>
                          )}
                        </div>
                      </div>
                    )}
                    {selectedPoint.classification.genre && (
                      <div className="text-xs text-text-dim">
                        Genre: <span className="text-text-muted">{selectedPoint.classification.genre}</span>
                        {selectedPoint.classification.entities.event_type && (
                          <> · Event: <span className="text-text-muted">{selectedPoint.classification.entities.event_type}</span></>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Sidebar: cluster list or detail panel */}
          <Card className="w-80 shrink-0 overflow-y-auto">
            {selectedCluster ? (
              /* Cluster detail panel */
              <div>
                <button
                  onClick={deselectCluster}
                  className="text-xs text-text-dim hover:text-text-primary mb-3 flex items-center gap-1 cursor-pointer"
                >
                  ← Back to list
                </button>

                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-text-primary">Cluster {selectedCluster.cluster_id}</h3>
                  <span className="text-xs text-text-dim font-mono">{selectedCluster.item_count} items</span>
                </div>

                {/* Top terms */}
                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">Defining Terms</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedCluster.top_terms.map((term) => (
                      <span key={term} className="text-xs bg-white/6 text-text-muted px-1.5 py-0.5 rounded">
                        {term}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Thread overlap */}
                {Object.keys(selectedCluster.thread_overlap).length > 0 && (
                  <div className="mb-4">
                    <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">Thread Overlap</div>
                    <div className="space-y-1">
                      {Object.entries(selectedCluster.thread_overlap)
                        .sort(([, a], [, b]) => b - a)
                        .map(([thread, count]) => {
                          const pct = Math.round((count / selectedCluster.item_count) * 100)
                          return (
                            <div key={thread} className="flex items-center gap-2 text-xs">
                              <div className="flex-1 truncate text-text-muted">{thread}</div>
                              <div className="w-16 h-1.5 bg-white/6 rounded-full overflow-hidden shrink-0">
                                <div className="h-full bg-maize/40 rounded-full" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-text-dim font-mono w-8 text-right">{count}</span>
                            </div>
                          )
                        })}
                    </div>
                  </div>
                )}

                {/* Temporal distribution */}
                {Object.keys(selectedCluster.temporal_distribution).length > 0 && (
                  <div className="mb-4">
                    <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">Years</div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                      {Object.entries(selectedCluster.temporal_distribution)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([year, count]) => (
                          <span key={year} className="text-text-dim">
                            <span className="text-text-muted">{year}</span> ({count})
                          </span>
                        ))}
                    </div>
                  </div>
                )}

                {/* Sample descriptions */}
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">
                    Sample Descriptions
                  </div>
                  <div className="space-y-2">
                    {selectedCluster.sample_descriptions.map((desc, i) => (
                      <p key={i} className="text-xs text-text-muted leading-snug border-l-2 border-white/6 pl-2">
                        {desc}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              /* Cluster list */
              <div>
                <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
                  Clusters ({data.clusters.length})
                </h3>
                <div className="space-y-1">
                  {[...data.clusters].sort((a, b) => b.item_count - a.item_count).map((cluster) => (
                    <button
                      key={cluster.cluster_id}
                      onClick={() => setSelectedCluster(cluster)}
                      className="w-full text-left p-2.5 rounded-lg transition-colors cursor-pointer hover:bg-white/4"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-text-primary">
                          Cluster {cluster.cluster_id}
                        </span>
                        <span className="text-xs text-text-dim font-mono">
                          {cluster.item_count}
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
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
