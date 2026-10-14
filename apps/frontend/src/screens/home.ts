/**
 * @file apps/frontend/src/screens/home.ts
 * @description The home screen: the air conditioners that are set up, and the way to add more.
 * @author Calvin Che
 * @license Apache-2.0
 */

import { loadState, removeDevice, search, startQueue } from '../actions.js';
import type { StoredDevice } from '../api.js';
import { button, notice } from '../components.js';
import { type Child, h } from '../dom.js';
import { draftFromStored } from '../exposure.js';
import { render } from '../render.js';
import { view } from '../state.js';

function describeExposure(device: StoredDevice): string {
  // What the unit cannot do is left out, whatever is stored for it. A unit the plugin has not asked yet is described as stored.
  const hasFan = device.controls === undefined || device.controls.fanSteps.length > 0;
  const hasSwing = device.controls === undefined || device.controls.hasSwing;
  const fanPlace = device.hasSeparateFan ? ' on a fan of its own' : '';
  const fan = device.fanControl === 'hidden' ? 'fan speed not shown' : `fan speed as ${device.fanControl === 'steps' ? 'steps' : 'a percentage'}${fanPlace}`;
  const swing = { switches: 'swing as switches', select: 'swing as a mode select', switchesAndSelect: 'swing as switches and a mode select', hidden: 'swing not shown' }[device.swingControl];
  const controls = [hasFan ? fan : '', hasSwing ? swing : ''].filter((text) => text !== '').join(', ');
  const switches = [device.hasDryModeSwitch ? 'dry mode' : '', device.hasFanModeSwitch ? 'fan mode' : '', device.hasFanAutoSwitch ? 'auto fan' : '', ...device.specialModeSwitches].filter(
    (name) => name !== '',
  );
  const extra = [switches.length === 0 ? '' : `a switch for ${switches.join(', ')}`, device.hasModeSelect ? 'a mode select' : ''].filter((text) => text !== '').join(' and ');
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
