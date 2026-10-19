/**
 * @file apps/frontend/src/state.ts
 * @description What the setup page knows at any moment, and what it reads from that.
 * @author Calvin Che
 * @license Apache-2.0
 */

import type { Adapter, AvailableControls, Capabilities, Exposure, FoundAdapter, ProbeResult, SetupState } from './api.js';

/** One air conditioner on its way through Connect and Options. */
export interface Draft extends Exposure {
  adapter: Adapter;
  name: string;
  isNew: boolean;
  localPassword?: string;
  capabilities?: Capabilities;
  /** What the plugin says the unit leaves to choose in Options. */
  controls?: AvailableControls;
  probe?: ProbeResult;
}

export type ScreenName = 'loading' | 'home' | 'find' | 'connect' | 'options' | 'done';

export const view = {
  screen: 'loading' as ScreenName,
  setup: undefined as SetupState | undefined,
  found: [] as FoundAdapter[],
  selected: new Set<string>(),
  queue: [] as Draft[],
  saved: [] as string[],
  /** The units this run is done with, in the order it went through them. */
  handled: [] as { label: string; isSaved: boolean }[],
  isBusy: false,
  busyText: '',
  error: '',
  /** A note for the user that is no problem, such as what to do after a change. */
  info: '',
  confirmingRemoval: '',
};

export function currentDraft(): Draft | undefined {
  return view.queue[0];
}

/** What a unit is called on the page: its name, or its address until it has one. */
export function draftLabel(draft: Draft): string {
  return draft.name === '' ? draft.adapter.host : draft.name;
}

/** Whether an adapter is that of a stored device, which is known by its MAC address. */
export function isStored(adapter: Adapter): boolean {
  return (view.setup?.devices ?? []).some((device) => device.macAddress === adapter.macAddress);
}
