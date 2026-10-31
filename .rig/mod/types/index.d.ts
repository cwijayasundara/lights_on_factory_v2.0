export type JourneyStep = { id: string; label: string; command: string; state: 'done' | 'current' | 'gate' | 'todo'; by: 'model' | 'person'; auto?: true; detail?: string }
export type Journey = {
  agents: { agent: string; model: string; at: string }[]
  initialised: boolean; kind: 'greenfield' | 'brownfield'; show: ('outer' | 'inner')[]; sprint: number | null
  outer: JourneyStep[]; inner: { slug: string; type: string; steps: JourneyStep[] } | null
  next: { command: string; by: 'model' | 'person'; why: string }; ready: string[]
  sensors?: { blocks: number } | null
}
export type Spend = { contextTokens: number; contextWindow: number; usd: number; turnUsd?: number }

declare module 'claude-code' {
  interface PluginState {
    rig: { journey: Journey | null; spend: Spend; isHidden: boolean }
  }
}
