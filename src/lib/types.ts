import type { Confidence, Genre, EventType } from './constants'

export interface SourceItem {
  container: number
  item: number
  collection: string
  date: string | null
  year: number | null
  month: number | null
  description: string
  notes: string
  duration: number
  durationStr: string
  sound: string
  color: string
  hdd: string
  filename: string
  thread: string
}

export interface ThreadAssignment {
  name: string
  confidence: Confidence
}

export interface Entities {
  people: string[]
  places: string[]
  organizations: string[]
  event_type: EventType | null
}

export interface ClassifiedItem {
  item_id: string
  threads: ThreadAssignment[]
  proposed_thread: string | null
  entities: Entities
  genre: Genre
  is_cryptic: boolean
  decode_note: string | null
}

export interface ClusterInfo {
  cluster_id: number
  top_terms: string[]
  sample_descriptions: string[]
  item_count: number
  temporal_distribution: Record<string, number>
  thread_overlap: Record<string, number>
}

export interface ClusterData {
  points: Array<{
    item_id: string
    x: number
    y: number
    cluster_id: number
  }>
  clusters: ClusterInfo[]
}

export interface EntityEntry {
  name: string
  type: 'people' | 'places' | 'organizations'
  count: number
  item_ids: string[]
}

export interface ProposedThread {
  name: string
  count: number
  sample_descriptions: string[]
  similar_proposals: string[]
  status: 'pending' | 'accepted' | 'rejected' | 'merged'
  merged_into?: string
}

export interface RunInfo {
  run_id: string
  date: string
  model: string
  status: 'running' | 'completed' | 'failed'
  total_items: number
  classified_items: number
  batches_total: number
  batches_completed: number
  errors: number
}

export interface Edit {
  item_id: string
  field: string
  old_value: unknown
  new_value: unknown
  timestamp: string
}

export interface EntityMergeSuggestion {
  entities: string[]
  counts: Record<string, number>
  suggested_canonical: string
  match_type: 'substring' | 'abbreviation' | 'prefix' | 'normalized' | 'mixed'
  total_count: number
  entity_type: 'people' | 'places' | 'organizations'
}

export interface SingleNameEntity {
  name: string
  count: number
  type: string
  item_ids: string[]
  sample_descriptions: string[]
}
