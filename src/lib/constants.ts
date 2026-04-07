export const THREADS = [
  'Crime & Safety',
  'Sports',
  'Weather',
  'Politics & Government',
  'Economy & Labor',
  'Schools & Education',
  'Health & Medicine',
  'Culture & Arts',
  'Community & Neighborhoods',
  'Daily Life & Human Interest',
  'Media & Broadcasting',
] as const

export type ThreadName = (typeof THREADS)[number]

export const THREAD_COLORS: Record<string, string> = {
  'Crime & Safety': 'var(--color-thread-crime)',
  'Sports': 'var(--color-thread-sports)',
  'Weather': 'var(--color-thread-weather)',
  'Politics & Government': 'var(--color-thread-politics)',
  'Economy & Labor': 'var(--color-thread-economy)',
  'Schools & Education': 'var(--color-thread-education)',
  'Health & Medicine': 'var(--color-thread-health)',
  'Culture & Arts': 'var(--color-thread-culture)',
  'Community & Neighborhoods': 'var(--color-thread-community)',
  'Daily Life & Human Interest': 'var(--color-thread-daily-life)',
  'Media & Broadcasting': 'var(--color-thread-media)',
}

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const
export type Confidence = (typeof CONFIDENCE_LEVELS)[number]

export const GENRES = [
  'reporter_package',
  'b_roll',
  'interview',
  'anchor_read',
  'live_shot',
  'closer',
  'sports_highlight',
  'weather_segment',
  'editorial',
  'unknown',
] as const
export type Genre = (typeof GENRES)[number]

export const EVENT_TYPES = [
  'press_conference',
  'protest',
  'trial',
  'interview',
  'ceremony',
  'disaster',
  'sports_event',
  'meeting',
  'investigation',
  'performance',
  'holiday',
  'weather_event',
  'human_interest',
  'consumer_report',
  'hostage_negotiation',
  'other',
] as const
export type EventType = (typeof EVENT_TYPES)[number]
