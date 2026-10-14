/**
 * @file apps/frontend/src/screens/options.ts
 * @description The Options step: how the fan, the swing, the extra modes and the readings of a unit appear in Matter, one section each, and whether as one device.
 * @author Calvin Che
 * @license Apache-2.0
 */

import { goHome, saveDraft } from '../actions.js';
import type { AvailableControls, Exposure, FanSpeed, SpecialMode, SwingMode } from '../api.js';
import { button, notice, steps, unitHeader, unitStrip } from '../components.js';
import { type Child, h } from '../dom.js';
import { noControls } from '../exposure.js';
import { matchesPreset, presetExposure, type PresetName, presets } from '../presets.js';
import { render } from '../render.js';
import { currentDraft, type Draft } from '../state.js';

const fanSpeedLabels: Record<FanSpeed, string> = {
  auto: 'Auto',
  silent: 'Silent',
  level1: 'Level 1',
  level2: 'Level 2',
  level3: 'Level 3',
  level4: 'Level 4',
  level5: 'Level 5',
};

const swingModeLabels: Record<SwingMode, string> = {
  off: 'No swing',
  vertical: 'Up and down',
  horizontal: 'Left and right',
  both: 'Up, down, left and right',
};

const specialModeTexts: Record<SpecialMode, { title: string; text: string }> = {
  powerful: { title: 'Powerful', text: 'Runs the unit at full power for a while.' },
  econo: { title: 'Econo', text: 'Limits how much power the unit draws.' },
  streamer: { title: 'Streamer', text: 'Runs the air purifying of the unit.' },
};

// Static drawings, so innerHTML is safe for them. Everything that comes from the network goes through text nodes.
const glyphs = {
  steps:
    '<svg viewBox="0 0 48 28" aria-hidden="true"><rect x="2" y="20" width="8" height="6"/><rect x="14" y="14" width="8" height="12"/><rect x="26" y="8" width="8" height="18"/><rect x="38" y="2" width="8" height="24"/></svg>',
  percent: '<svg viewBox="0 0 48 28" aria-hidden="true"><path d="M2 26 L46 2 L46 26 Z"/></svg>',
  hidden: '<svg viewBox="0 0 48 28" aria-hidden="true"><path class="stroke" d="M6 14 H42" stroke-dasharray="3 5"/></svg>',
  switches:
    '<svg viewBox="0 0 48 28" aria-hidden="true"><path class="stroke" d="M12 4 V24 M7 9 L12 4 L17 9 M7 19 L12 24 L17 19"/><path class="stroke" d="M26 14 H46 M31 9 L26 14 L31 19 M41 9 L46 14 L41 19"/></svg>',
  select: '<svg viewBox="0 0 48 28" aria-hidden="true"><rect class="stroke" x="3" y="5" width="42" height="18" rx="4"/><path class="stroke" d="M31 12 L35 16 L39 12"/></svg>',
};

// Home Assistant is the one app known to show a mode select.
const selectSupport = 'Few apps show a mode select: Home Assistant does, Apple Home does not.';

function update(draft: Draft, change: Partial<Exposure>): void {
  Object.assign(draft, change);
  render();
}

function choice<T extends string>(group: string, value: T, current: T, title: string, text: string, glyph: string, onpick: (value: T) => void): HTMLElement {
  const id = `${group}-${value}`;
  const input = h('input', { type: 'radio', name: group, id, checked: value === current, onchange: () => onpick(value) });
  return h('label', { class: 'choice pictured', for: id }, input, h('span', { class: 'glyph', html: glyph }), h('span', {}, h('strong', {}, title), h('span', { class: 'meta' }, text)));
}

function toggle(id: string, isOn: boolean, title: string, text: string, onpick: (isOn: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', id, checked: isOn, onchange: () => onpick(input.checked) });
  return h('label', { class: 'choice', for: id }, input, h('span', {}, h('strong', {}, title), h('span', { class: 'meta' }, text)));
}

function presetSection(draft: Draft, controls: AvailableControls): HTMLElement {
  return h(
    'section',
    { class: 'presets' },
    h('h2', {}, 'Start from a preset'),
    h(
      'div',
      { class: 'preset-list' },
      ...(Object.keys(presets) as PresetName[]).map((name) =>
        h(
          'button',
          { 'type': 'button', 'class': 'preset', 'aria-pressed': String(matchesPreset(draft, name, controls)), 'onclick': () => update(draft, presetExposure(name, controls)) },
          h('strong', {}, presets[name].title),
          h('span', { class: 'meta' }, presets[name].text),
        ),
      ),
    ),
    h('p', { class: 'help' }, 'A preset fills in the choices below for what this unit can do. Change any of them afterwards.'),
  );
}

function fanSection(draft: Draft, controls: AvailableControls): HTMLElement {
  const fanSpeeds = draft.capabilities?.fanSpeeds ?? [];
  const stepCount = controls.fanSteps.length;
  if (stepCount === 0) return h('section', {}, h('h2', {}, 'Fan speed'), h('p', { class: 'help' }, 'This unit does not let apps set its fan speed, so there is nothing to choose.'));
  // A fixed fan speed is sent with every command, so a switch for auto would not hold.
  const canSwitchFanAuto = controls.hasFanAuto && !(draft.fanControl === 'hidden' && draft.fanSpeedWhenHidden !== 'keep');
  return h(
    'section',
    {},
    h('h2', {}, 'Fan speed'),
    h(
      'div',
      { class: 'choices' },
      choice('fan', 'steps', draft.fanControl, 'Steps', `${stepCount} speeds, one for each speed of the unit${fanSpeeds.includes('auto') ? ', and auto' : ''}.`, glyphs.steps, (fanControl) =>
        update(draft, { fanControl }),
      ),
      choice('fan', 'percent', draft.fanControl, 'Percentage', 'A slider from 0 to 100, which the plugin rounds to the nearest speed of the unit.', glyphs.percent, (fanControl) => update(draft, { fanControl })),
      choice('fan', 'hidden', draft.fanControl, 'Not shown in Matter', 'No fan control. Pick below what the plugin does with the fan speed instead.', glyphs.hidden, (fanControl) =>
        update(draft, { fanControl }),
      ),
    ),
    draft.fanControl === 'hidden'
      ? h(
          'div',
          { class: 'field' },
          h('label', { for: 'fan-fixed' }, 'When the plugin sends a command, the fan speed'),
          h(
            'select',
            { id: 'fan-fixed', onchange: (event: Event) => update(draft, { fanSpeedWhenHidden: (event.target as HTMLSelectElement).value as Exposure['fanSpeedWhenHidden'] }) },
            h('option', { value: 'keep', selected: draft.fanSpeedWhenHidden === 'keep' }, 'stays as it is'),
            ...fanSpeeds.map((speed) => h('option', { value: speed, selected: draft.fanSpeedWhenHidden === speed }, `is set to ${fanSpeedLabels[speed]}`)),
          ),
        )
      : null,
    draft.fanControl === 'hidden'
      ? null
      : toggle(
          'separate-fan',
          draft.hasSeparateFan,
          'Show the fan as a device of its own',
          `It appears as "${draft.name} Fan", and the air conditioner has no fan speed of its own. For apps that show no fan speed on an air conditioner. It always shows the speed the unit holds, also while the unit is off.`,
          (hasSeparateFan) => update(draft, { hasSeparateFan }),
        ),
    canSwitchFanAuto
      ? toggle(
          'fan-auto-switch',
          draft.hasFanAutoSwitch,
          'Add a switch for auto fan speed',
          `It appears as "${draft.name} Auto Fan". On sets the fan to auto, off puts it back at the speed it last ran at. For apps that show no auto fan mode.`,
          (hasFanAutoSwitch) => update(draft, { hasFanAutoSwitch }),
        )
      : null,
  );
}

function swingSection(draft: Draft): HTMLElement {
  const swingModes = draft.capabilities?.swingModes ?? [];
  if (swingModes.length === 0) return h('section', {}, h('h2', {}, 'Swing'), h('p', { class: 'help' }, 'This unit does not let apps move its louvers, so there is nothing to choose.'));
  const hasVertical = swingModes.includes('vertical');
  const hasHorizontal = swingModes.includes('horizontal');
  let switchText = 'One switch, for the up and down swing.';
  if (hasVertical && hasHorizontal) switchText = 'Two switches: one for the up and down swing, one for left and right.';
  else if (hasHorizontal) switchText = 'One switch, for the left and right swing.';
  return h(
    'section',
    {},
    h('h2', {}, 'Swing'),
    h(
      'div',
      { class: 'choices' },
      choice('swing', 'switches', draft.swingControl, 'Switches', switchText, glyphs.switches, (swingControl) => update(draft, { swingControl })),
      choice(
        'swing',
        'select',
        draft.swingControl,
        'A mode select',
        `It appears as "${draft.name} Swing", and picks one of: ${swingModes.map((mode) => swingModeLabels[mode].toLowerCase()).join(', ')}. ${selectSupport}`,
        glyphs.select,
        (swingControl) => update(draft, { swingControl }),
      ),
      choice('swing', 'hidden', draft.swingControl, 'Not shown in Matter', 'No swing control. Pick below what the plugin does with the swing instead.', glyphs.hidden, (swingControl) =>
        update(draft, { swingControl }),
      ),
    ),
    draft.swingControl === 'hidden'
      ? h(
          'div',
          { class: 'field' },
          h('label', { for: 'swing-fixed' }, 'When the plugin sends a command, the swing'),
          h(
            'select',
            { id: 'swing-fixed', onchange: (event: Event) => update(draft, { swingModeWhenHidden: (event.target as HTMLSelectElement).value as Exposure['swingModeWhenHidden'] }) },
            h('option', { value: 'keep', selected: draft.swingModeWhenHidden === 'keep' }, 'stays as it is'),
            ...swingModes.map((mode) => h('option', { value: mode, selected: draft.swingModeWhenHidden === mode }, `is set to: ${swingModeLabels[mode]}`)),
          ),
        )
      : null,
  );
}

function modeSection(draft: Draft, controls: AvailableControls): Child {
  if (!controls.hasDryMode && !controls.hasFanMode) return null;
  const modes = draft.capabilities?.modes ?? [];
  return h(
    'section',
    {},
    h('h2', {}, 'Dry and fan modes'),
    h(
      'p',
      { class: 'help' },
      `These are always among the modes of the air conditioner in Matter, but some apps, such as Apple Home, only offer cool, heat and auto. A switch makes the mode reachable there: on puts the unit in that mode, off puts it back in ${modes.includes('cool') ? 'cool' : 'heat'}. A mode select instead offers every mode in one control.`,
    ),
    h(
      'div',
      { class: 'choices' },
      toggle(
        'mode-select',
        draft.hasModeSelect,
        'Use a mode select instead of switches',
        `It appears as "${draft.name} Mode", with Off and every mode of the unit, as the thermostat mode has them. Picking a mode turns the unit on in it. ${selectSupport}`,
        // The select takes the place of the switches.
        (hasModeSelect) => update(draft, hasModeSelect ? { hasModeSelect, hasDryModeSwitch: false, hasFanModeSwitch: false } : { hasModeSelect }),
      ),
      controls.hasDryMode && !draft.hasModeSelect
        ? toggle('dry-mode-switch', draft.hasDryModeSwitch, 'Add a switch for dry mode', `It appears as "${draft.name} Dry Mode".`, (hasDryModeSwitch) => update(draft, { hasDryModeSwitch }))
        : null,
      controls.hasFanMode && !draft.hasModeSelect
        ? toggle('fan-mode-switch', draft.hasFanModeSwitch, 'Add a switch for fan mode', `It appears as "${draft.name} Fan Mode".`, (hasFanModeSwitch) => update(draft, { hasFanModeSwitch }))
        : null,
    ),
  );
}

function specialSection(draft: Draft, controls: AvailableControls): Child {
  if (controls.specialModes.length === 0) return null;
  return h(
    'section',
    {},
    h('h2', {}, 'Special modes'),
    h('p', { class: 'help' }, 'Matter has no control for these, so each can get a switch of its own. A switch only takes effect in the modes this unit offers that special mode in.'),
    h(
      'div',
      { class: 'choices' },
      ...controls.specialModes.map((mode) =>
        toggle(`special-${mode}`, draft.specialModeSwitches.includes(mode), `Add a switch for ${specialModeTexts[mode].title}`, specialModeTexts[mode].text, (isOn) =>
          update(draft, { specialModeSwitches: controls.specialModes.filter((other) => (other === mode ? isOn : draft.specialModeSwitches.includes(other))) }),
        ),
      ),
    ),
  );
}

function sensorSection(draft: Draft): HTMLElement {
  return h(
    'section',
    {},
    h('h2', {}, 'Humidity and outdoor temperature'),
    h(
      'p',
      { class: 'help' },
      'No adapter says which readings its unit has, so each of these takes effect once the unit gives that reading. The room temperature and the humidity are always on the air conditioner.',
    ),
    h(
      'div',
      { class: 'choices' },
      toggle(
        'separate-humidity',
        draft.hasSeparateHumiditySensor,
        'Also show the humidity on a sensor of its own',
        `It appears as "${draft.name} Humidity", and the air conditioner keeps its humidity. For apps that show no humidity on an air conditioner, which Apple Home is reported to be.`,
        (hasSeparateHumiditySensor) => update(draft, { hasSeparateHumiditySensor }),
      ),
      toggle(
        'outdoor-sensor',
        draft.hasOutdoorTemperatureSensor,
        'Add a sensor for the outdoor temperature',
        `It appears as "${draft.name} Outdoor Temperature". It is a device of its own, which you can put in another room, such as outside. Until you do, a Matter app may show the outdoor temperature as that of the room it put the sensor in. Some units give no outdoor temperature while they are idle: the sensor then shows no value.`,
        (hasOutdoorTemperatureSensor) => update(draft, { hasOutdoorTemperatureSensor }),
      ),
    ),
  );
}

function composedSection(draft: Draft): HTMLElement {
  return h(
    'section',
    {},
    h('h2', {}, 'One device or several'),
    h(
      'p',
      { class: 'help' },
      'The switches, a fan of its own and a humidity sensor of its own can be parts of the air conditioner in Matter, or devices of their own beside it. The outdoor temperature sensor is always a device of its own, so that you can put it in another room than the air conditioner.',
    ),
    h(
      'div',
      { class: 'choices' },
      toggle(
        'composed',
        draft.isComposed,
        'Make them parts of the air conditioner',
        `Your Matter app has one device, "${draft.name}", and they move between rooms with it. A part has no name of its own in Matter, so an app may show the switches as numbered outlets, and an app that shows no parts shows the air conditioner alone. Turned off, each is a device of its own with its own name, which your app puts in a room by itself.`,
        (isComposed) => update(draft, { isComposed }),
      ),
    ),
  );
}

export function optionsScreen(): Child[] {
  const draft = currentDraft();
  if (draft === undefined) return [notice()];
  const controls = draft.controls ?? noControls;
  return [
    steps(),
    unitStrip(),
    unitHeader(draft, `Options for the air conditioner at ${draft.adapter.host}. Power, mode and temperature always appear in Matter: choose how the rest appears.`),
    presetSection(draft, controls),
    fanSection(draft, controls),
    swingSection(draft),
    modeSection(draft, controls),
    specialSection(draft, controls),
    sensorSection(draft),
    composedSection(draft),
    draft.isNew ? null : h('p', { class: 'help' }, 'Changing any of these rebuilds this air conditioner in Matter. Your Matter app may take a moment to show the change.'),
    notice(),
    h('div', { class: 'footer' }, button('Cancel', goHome), button(draft.isNew ? `Add ${draft.name}` : 'Save options', () => void saveDraft(draft), 'primary')),
  ];
}
