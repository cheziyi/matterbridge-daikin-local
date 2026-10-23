/**
 * @file apps/frontend/src/screens/find.ts
 * @description The Find step: the adapters a search found or an address led to, and which of them to set up.
 * @author Calvin Che
 * @created 2026-10-13
 * @version 1.0.0
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

import { goHome, lookUp, search, startQueue } from '../actions.js';
import type { FoundAdapter } from '../api.js';
import { button, notice, steps } from '../components.js';
import { type Child, h } from '../dom.js';
import { draftsFromAdapters } from '../exposure.js';
import { render } from '../render.js';
import { view } from '../state.js';

function foundRow(adapter: FoundAdapter): HTMLElement {
  const isSelectable = !adapter.isConfigured;
  const notes: string[] = [];
  if (adapter.isConfigured) notes.push('Already set up.');
  if (adapter.name === undefined) notes.push('It has not told its name yet: you will name it in its options.');
  if (isSelectable && adapter.needsRegistration) notes.push('Asks for the KEY printed on its label.');
  else if (isSelectable && adapter.requiresRegistration) notes.push('Already registered with this plugin, so it will not ask for its KEY.');
  if (isSelectable && adapter.requiresLocalPassword) notes.push('Asks for its child lock code.');
  const checkbox = h('input', {
    type: 'checkbox',
    id: `found-${adapter.host}`,
    checked: isSelectable && view.selected.has(adapter.host),
    disabled: !isSelectable,
    onchange: () => {
      if (checkbox.checked) view.selected.add(adapter.host);
      else view.selected.delete(adapter.host);
      render();
    },
  });
  return h(
    'li',
    { class: isSelectable ? 'found' : 'found unavailable' },
    h(
      'label',
      { for: `found-${adapter.host}` },
      checkbox,
      h('span', {}, h('strong', {}, adapter.name ?? 'Unnamed adapter'), h('span', { class: 'meta' }, ` ${adapter.host}`), ...notes.map((note) => h('span', { class: 'meta note' }, note))),
    ),
  );
}

export function findScreen(): Child[] {
  const chosen = view.found.filter((adapter) => view.selected.has(adapter.host) && !adapter.isConfigured);
  const host = h('input', { type: 'text', id: 'host', placeholder: '192.168.1.50', spellcheck: false, autocomplete: 'off' });
  const lookUpHost = (): void => {
    if (host.value.trim() !== '') void lookUp(host.value.trim());
  };
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') lookUpHost();
  });
  const continueLabel = chosen.length === 1 ? 'Set up 1 air conditioner' : `Set up ${chosen.length} air conditioners`;
  return [
    steps(),
    h('header', {}, h('h1', {}, 'Find your air conditioners')),
    notice(),
    view.found.length > 0 ? h('ul', { class: 'found-list' }, ...view.found.map(foundRow)) : null,
    !view.isBusy && view.found.length === 0
      ? h('p', { class: 'empty' }, 'No adapter answered. A search only reaches adapters on the same network segment as Matterbridge: add the others by address below.')
      : null,
    h(
      'details',
      { class: 'manual', open: !view.isBusy && view.found.length === 0 },
      h('summary', {}, "Can't see your air conditioner?"),
      h('p', { class: 'help' }, 'Enter the address of its adapter. The plugin reads the name of the adapter there and follows it to a new address like any other, as long as a search can reach it. An adapter on another subnet or VLAN keeps this address.'),
      h('div', { class: 'inline-form' }, h('label', { for: 'host', class: 'visually-hidden' }, 'Adapter address'), host, button('Look it up', lookUpHost)),
    ),
    h(
      'div',
      { class: 'footer' },
      button('Search again', () => void search()),
      button('Cancel', goHome),
      button(continueLabel, () => startQueue(draftsFromAdapters(chosen)), 'primary', chosen.length === 0),
    ),
  ];
}
