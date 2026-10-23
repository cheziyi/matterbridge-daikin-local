/**
 * @file apps/frontend/src/screens/home.ts
 * @description The home screen: the air conditioners that are set up, and the way to add more.
 * @author Calvin Che
 * @created 2026-10-13
 * @version 1.1.0
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

import { loadState, removeDevice, search, startQueue } from '../actions.js';
import type { StoredDevice, SwitchedMode } from '../api.js';
import { button, notice } from '../components.js';
import { type Child, h } from '../dom.js';
import { draftFromStored } from '../exposure.js';
import { render } from '../render.js';
import { view } from '../state.js';

const modeNames: Record<SwitchedMode, string> = { auto: 'auto mode', cool: 'cool mode', heat: 'heat mode', dehumidify: 'dry mode', fan: 'fan mode' };

function describeExposure(device: StoredDevice): string {
  // What the unit cannot do is left out, whatever is stored for it. A unit the plugin has not asked yet is described as stored.
  const hasFan = device.controls === undefined || device.controls.fanSteps.length > 0;
  const hasSwing = device.controls === undefined || device.controls.hasSwing;
  const fanPlace = device.hasSeparateFan ? ' on a fan of its own' : '';
  const autoStep = { native: '', switch: '', firstStep: ' with auto first', lastStep: ' with auto last' }[device.fanAutoControl];
  const fan = device.fanControl === 'hidden' ? 'fan speed not shown' : `fan speed as ${device.fanControl === 'steps' ? 'steps' : 'a percentage'}${autoStep}${fanPlace}`;
  const swingAxes = { both: '', vertical: ' up and down', horizontal: ' left and right' }[device.swingAxes];
  const swing = { native: `swing as native rocking${swingAxes}`, switches: `swing as switches${swingAxes}`, select: 'swing as a mode select', hidden: 'swing not shown' }[
    device.swingControl
  ];
  const controls = [hasFan ? fan : '', hasSwing ? swing : ''].filter((text) => text !== '').join(', ');
  const modeSwitches = device.modeControl === 'switches' ? device.modeSwitches.map((mode) => modeNames[mode]) : [];
  // Such as "dry mode as heat".
  const replacements = (Object.keys(modeNames) as SwitchedMode[]).flatMap((mode) => {
    const replacement = device.modeReplacements[mode];
    return replacement === undefined ? [] : [`${modeNames[mode]} as ${modeNames[replacement].replace(' mode', '')}`];
  });
  const switches = [...modeSwitches, device.fanAutoControl === 'switch' ? 'auto fan' : '', ...device.specialModeSwitches].filter((name) => name !== '');
  const extra = [switches.length === 0 ? '' : `a switch for ${switches.join(', ')}`, device.modeControl === 'select' ? 'a mode select' : '', replacements.join(' and ')]
    .filter((text) => text !== '')
    .join(' and ');
  const place = device.isComposed ? ', all as one device' : '';
  if (controls === '') return `${extra === '' ? 'power, mode and temperature' : extra}${place}`;
  return `${extra === '' ? controls : `${controls}, and ${extra}`}${place}`;
}

function deviceRow(device: StoredDevice): HTMLElement {
  const statusText = { online: 'Online', offline: 'Not answering', stopped: 'Not started' }[device.status];
  const isConfirming = view.confirmingRemoval === device.macAddress;
  return h(
    'li',
    { class: 'device' },
    h(
      'div',
      { class: 'device-main' },
      h('h3', {}, device.name),
      h('p', { class: 'meta' }, h('span', { class: `status ${device.status}` }, statusText), ` at ${device.host}. In Matter: ${describeExposure(device)}.`),
      device.status !== 'online' && device.error ? h('p', { class: 'meta problem-text' }, device.error) : null,
      device.needsRestart
        ? h('p', { class: 'meta' }, h('strong', {}, 'Restart Matterbridge'), ' to apply the new options in Matter. Until then it keeps its current controls.')
        : null,
    ),
    isConfirming
      ? h(
          'div',
          { class: 'actions' },
          h('span', { class: 'meta' }, 'Remove it from Matter too?'),
          button('Remove', () => void removeDevice(device), 'danger'),
          button('Keep', () => {
            view.confirmingRemoval = '';
            render();
          }),
        )
      : h(
          'div',
          { class: 'actions' },
          // Either way the unit is asked first what it accepts now, so the options offered are the ones it has today.
          button(device.status === 'online' ? 'Options' : 'Reconnect', () => startQueue([draftFromStored(device)])),
          button('Remove', () => {
            view.confirmingRemoval = device.macAddress;
            render();
          }),
        ),
  );
}

export function homeScreen(): Child[] {
  const devices = view.setup?.devices ?? [];
  return [
    h('header', {}, h('h1', {}, 'Daikin air conditioners'), view.setup ? button('Add air conditioners', () => void search(), 'primary') : null),
    notice(),
    devices.length === 0 && view.setup
      ? h('p', { class: 'empty' }, 'No air conditioner is set up yet. Add one to control it from Matter.')
      : h('ul', { class: 'devices' }, ...devices.map(deviceRow)),
    view.setup ? null : button('Try again', () => void loadState(), 'primary'),
  ];
}
