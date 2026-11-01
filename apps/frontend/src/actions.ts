/**
 * @file apps/frontend/src/actions.ts
 * @description What the setup page does: each action calls the plugin, changes the state of the page and redraws it.
 * @author Calvin Che
 * @created 2026-10-13
 * @version 1.2.0
 * @license Apache-2.0
 *
 * Copyright 2026 Calvin Che.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { api, type StoredDevice } from './api.js';
import { pickExposure, takenNames, uniqueName } from './exposure.js';
import { presetExposure } from './presets.js';
import { render } from './render.js';
import { currentDraft, type Draft, draftLabel, isStored, view } from './state.js';

/**
 * Run a call while the page shows that it is working
 *
 * @param {string} text What the page says meanwhile.
 * @param {() => Promise<T>} task The call.
 * @returns {Promise<T>} What the call returned.
 */
async function busy<T>(text: string, task: () => Promise<T>): Promise<T> {
  view.isBusy = true;
  view.busyText = text;
  view.error = '';
  view.info = '';
  render();
  try {
    return await task();
  } finally {
    view.isBusy = false;
    render();
  }
}

/**
 * Read the stored devices from the plugin and show the home screen, or go straight to the search when none is set up yet
 *
 * @returns {Promise<void>} Resolves once the page is drawn.
 */
export async function loadState(): Promise<void> {
  const reply = await api('GET state');
  if (!reply.ok) {
    view.error = reply.error;
    view.screen = 'home';
    render();
    return;
  }
  view.setup = reply.state;
  // With nothing set up yet, the page goes straight to finding the air conditioners.
  if (reply.state.devices.length === 0) {
    await search();
    return;
  }
  view.screen = 'home';
  render();
}

/**
 * Read the stored devices from the plugin again, keeping those the page has when the plugin does not answer
 *
 * @returns {Promise<void>} Resolves once the state is read.
 */
async function refreshState(): Promise<void> {
  const reply = await api('GET state');
  if (reply.ok) view.setup = reply.state;
}

/**
 * Go back to the home screen, dropping the run in progress, and read the stored devices again
 *
 * @returns {void}
 */
export function goHome(): void {
  view.queue = [];
  view.saved = [];
  view.handled = [];
  view.error = '';
  view.info = '';
  view.screen = 'home';
  void refreshState().then(render);
  render();
}

/**
 * Search the network for adapters and show them in the Find step, with the new ones selected
 *
 * @returns {Promise<void>} Resolves once the adapters are shown.
 */
export async function search(): Promise<void> {
  view.screen = 'find';
  const reply = await busy('Searching your network. This takes about three seconds…', async () => api('POST discover'));
  if (!reply.ok) {
    view.error = `The search did not run: ${reply.error}`;
    render();
    return;
  }
  // Keep the adapters added by address: a search does not find them. One of them may have been set up since.
  await refreshState();
  const byAddress = view.found
    .filter((adapter) => !reply.devices.some((device) => device.host === adapter.host) && view.selected.has(adapter.host))
    .map((adapter) => ({ ...adapter, isConfigured: isStored(adapter) }));
  view.found = [...reply.devices, ...byAddress];
  for (const adapter of reply.devices) {
    if (!adapter.isConfigured) view.selected.add(adapter.host);
  }
  render();
}

/**
 * Look up an adapter by its address and add it to the Find step, selected unless it is set up already
 *
 * @param {string} host The IP address or the host name of the adapter.
 * @returns {Promise<void>} Resolves once the adapter is shown, or the reason it was not.
 */
export async function lookUp(host: string): Promise<void> {
  const reply = await busy(`Looking for an adapter at ${host}…`, async () => api('POST identify', { host }));
  if (!reply.ok) {
    view.error = reply.error;
    render();
    return;
  }
  const isConfigured = isStored(reply.device);
  // Whether the adapter knows this plugin already shows in the Connect step: an address alone does not tell.
  const needsRegistration = reply.device.requiresRegistration === true;
  view.found = [...view.found.filter((adapter) => adapter.host !== reply.device.host), { ...reply.device, isConfigured, needsRegistration }];
  if (!isConfigured) view.selected.add(reply.device.host);
  render();
}

/**
 * Start a run through Connect and Options for one or more air conditioners
 *
 * @param {Draft[]} drafts The air conditioners, in the order the run takes them.
 * @returns {void}
 */
export function startQueue(drafts: Draft[]): void {
  view.queue = drafts;
  view.saved = [];
  view.handled = [];
  void enterConnect();
}

/**
 * Show the Connect step for the next air conditioner of the run, or end the run when there is none left
 *
 * @returns {Promise<void>} Resolves once the next step is shown.
 */
async function enterConnect(): Promise<void> {
  const draft = currentDraft();
  if (draft === undefined) {
    view.screen = view.saved.length > 0 ? 'done' : 'home';
    await refreshState();
    render();
    return;
  }
  view.screen = 'connect';
  view.error = '';
  view.info = '';
  draft.probe = undefined;
  render();
  await check(draft);
}

/**
 * Check that the adapter of an air conditioner answers, registering with it when a KEY is given, and go on to the
 * Options step once it is ready
 *
 * @param {Draft} draft The air conditioner.
 * @param {string} [key] The KEY printed on the adapter, for an adapter that asks for a registration.
 * @returns {Promise<void>} Resolves once the answer is shown.
 */
export async function check(draft: Draft, key?: string): Promise<void> {
  // The adapter as it announced itself: an adapter whose name is not known yet is asked for it.
  const body = { device: draft.adapter, localPassword: draft.localPassword, key };
  const text = key === undefined ? `Checking ${draftLabel(draft)}…` : `Registering with ${draftLabel(draft)}…`;
  const reply = await busy(text, async () => api(key === undefined ? 'POST probe' : 'POST register', body));
  if (!reply.ok) {
    view.error = reply.error;
    render();
    return;
  }
  draft.probe = reply.result;
  draft.adapter = reply.result.device;
  if (reply.result.status === 'ready') {
    const isFirstReading = draft.controls === undefined;
    draft.capabilities = reply.result.capabilities;
    draft.controls = reply.result.controls;
    // A new unit starts with the Apple Home preset, once what it can do is known. A later check, such as after a
    // registration, keeps what was chosen since.
    if (draft.isNew && isFirstReading && draft.controls !== undefined) Object.assign(draft, presetExposure('apple', draft.controls));
    // A unit that has no name yet starts with the one its adapter tells, which is its own from then on.
    const told = reply.result.device.name ?? '';
    if (draft.name === '' && told !== '') draft.name = uniqueName(told, takenNames(draft));
    view.screen = 'options';
  }
  render();
}

/**
 * Leave the current air conditioner of the run out and go on to the next
 *
 * @returns {void}
 */
export function skipDraft(): void {
  const skipped = view.queue.shift();
  if (skipped !== undefined) view.handled.push({ label: draftLabel(skipped), isSaved: false });
  void enterConnect();
}

/**
 * Store an air conditioner with its options and go on to the next of the run
 *
 * @param {Draft} draft The air conditioner, with its name and its options chosen.
 * @returns {Promise<void>} Resolves once the next step is shown, or the reason the device was not stored.
 */
export async function saveDraft(draft: Draft): Promise<void> {
  const name = draft.name.trim();
  const problem = checkName(draft, name);
  if (problem !== '') {
    view.error = problem;
    render();
    return;
  }
  const { adapter, localPassword } = draft;
  const device = { ...adapter, name, localPassword, ...pickExposure(draft) };
  const reply = await busy(`Saving ${name}…`, async () => api('POST device', { device }));
  if (!reply.ok) {
    view.error = reply.error;
    render();
    return;
  }
  view.setup = reply.state;
  view.saved.push(name);
  view.handled.push({ label: name, isSaved: true });
  view.queue.shift();
  await enterConnect();
}

/**
 * Get what is wrong with the name of a draft: the plugin refuses a name another device has
 *
 * @param {Draft} draft The air conditioner.
 * @param {string} name The name, trimmed.
 * @returns {string} What is wrong, in words the page can show, or nothing.
 */
function checkName(draft: Draft, name: string): string {
  if (name === '') return 'Give the air conditioner a name: it is the name it gets in Matter.';
  const isTaken = (view.setup?.devices ?? []).some((device) => device.name === name && device.macAddress !== draft.adapter.macAddress);
  return isTaken ? `"${name}" is already the name of another air conditioner. Pick a different one.` : '';
}

/** Matterbridge does not tell its own page when a plugin adds or removes a device, so its device list waits for a reload. */
export const reloadNote = "Matterbridge's own list of devices shows the change once you reload its page.";

/** A change of how an air conditioner appears in Matter waits for a restart, which the plugin asks Matterbridge for as well. */
export const restartNote = 'Restart Matterbridge to apply the new options in Matter: until then the air conditioner keeps its current controls.';

/**
 * Remove a stored air conditioner from the plugin and from Matter
 *
 * @param {StoredDevice} device The air conditioner.
 * @returns {Promise<void>} Resolves once the result is shown.
 */
export async function removeDevice(device: StoredDevice): Promise<void> {
  const reply = await busy(`Removing ${device.name}…`, async () => api('POST remove-device', { macAddress: device.macAddress }));
  view.confirmingRemoval = '';
  if (reply.ok) view.info = `${device.name} is removed. ${reloadNote}`;
  else view.error = reply.error;
  await refreshState();
  render();
}
