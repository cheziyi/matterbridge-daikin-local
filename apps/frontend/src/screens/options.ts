/**
 * @file apps/frontend/src/screens/options.ts
 * @description The Options step: how the fan, the swing, the modes and the readings of a unit appear in Matter, one section each, and whether as one device.
 * @author Calvin Che
 * @license Apache-2.0
 */

import { goHome, saveDraft } from '../actions.js';
import type { AvailableControls, Exposure, FanSpeed, ModeReplacements, SpecialMode, SwingMode, SwitchedMode } from '../api.js';
import { button, notice, steps, unitHeader, unitStrip } from '../components.js';
import { type Child, h } from '../dom.js';
import { canReplace, fitModeReplacements, noControls } from '../exposure.js';
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
  both: '3D swing',
};

const modeLabels: Record<SwitchedMode, string> = { auto: 'Auto', cool: 'Cool', heat: 'Heat', dehumidify: 'Dry', fan: 'Fan' };

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

// A part of the air conditioner has no name of its own in Matter: a switch or a mode select is tagged with what it is.
function placement(draft: Draft, label: string, isTagged: boolean): string {
  if (!draft.isComposed) return `It appears as "${draft.name} ${label}"`;
  return isTagged ? `It appears as a part of "${draft.name}", tagged "${label}"` : `It appears as a part of "${draft.name}"`;
}

function update(draft: Draft, change: Partial<Exposure>): void {
  Object.assign(draft, change);
  render();
}

function choice<T extends string>(group: string, value: T, current: T, title: string, text: string, glyph: string, onpick: (value: T) => void): HTMLElement {
  const id = `${group}-${value}`;
  const input = h('input', { type: 'radio', name: group, id, checked: value === current, onchange: () => onpick(value) });
  return h('label', { class: 'choice pictured', for: id }, input, h('span', { class: 'glyph', html: glyph }), h('span', {}, h('strong', {}, title), h('span', { class: 'meta' }, text)));
}

function radio<T extends string>(group: string, value: T, current: T, title: string, text: string, onpick: (value: T) => void): HTMLElement {
  const id = `${group}-${value}`;
  const input = h('input', { type: 'radio', name: group, id, checked: value === current, onchange: () => onpick(value) });
  return h('label', { class: 'choice', for: id }, input, h('span', {}, h('strong', {}, title), h('span', { class: 'meta' }, text)));
}

function toggle(id: string, isOn: boolean, title: string, text: string, onpick: (isOn: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', id, checked: isOn, onchange: () => onpick(input.checked) });
  return h('label', { class: 'choice', for: id }, input, h('span', {}, h('strong', {}, title), h('span', { class: 'meta' }, text)));
}

// A compact multi-select, one chip for each value: for a list that full sized choices would make too long.
function chips<T extends string>(group: string, label: string, values: readonly T[], picked: readonly T[], labels: Record<T, string>, onpick: (picked: T[]) => void): HTMLElement {
  return h(
    'div',
    { 'class': 'chips', 'role': 'group', 'aria-label': label },
    ...values.map((value) => {
      const id = `${group}-${value}`;
      const input = h('input', { type: 'checkbox', id, checked: picked.includes(value), onchange: () => onpick(values.filter((other) => (other === value ? input.checked : picked.includes(other)))) });
      return h('label', { class: 'chip', for: id }, input, labels[value]);
    }),
  );
}

// The air conditioner as its adapter tells it apart from the others: by the name of its Daikin app, then by its address.
function adapterText(draft: Draft): string {
  const told = draft.adapter.name;
  const address = `at ${draft.adapter.host}`;
  return told === undefined || told === '' ? `the air conditioner ${address}` : `the air conditioner named "${told}" in its Daikin app, ${address}`;
}

// Redrawn as it is typed, so that the texts that name the device follow. A redraw when the field is left instead would
// replace the button the click leaving it is on, and lose that click.
function nameSection(draft: Draft): HTMLElement {
  const input = h('input', { type: 'text', id: 'device-name', value: draft.name, maxLength: 32, autocomplete: 'off', spellcheck: false });
  input.addEventListener('input', (event) => {
    draft.name = input.value.trim();
    // A redraw in the middle of a composition, such as of Japanese text, would end it.
    if (!(event as InputEvent).isComposing) render();
  });
  const told = draft.adapter.name;
  const toldText = told === undefined || told === '' ? 'Its adapter has no name of its own.' : `Its adapter is named "${told}" in its Daikin app, which other adapters can share.`;
  return h(
    'section',
    {},
    h('h2', {}, h('label', { for: 'device-name' }, 'Name in Matter')),
    h('p', { class: 'help' }, `${toldText} The name here is what your Matter apps show, up to 32 characters, and no two air conditioners of this plugin share one. A new name of the adapter does not change it.`),
    h('div', { class: 'inline-form' }, input),
  );
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

// Such as "Silent, Level 1 and Level 2".
function listSpeeds(speeds: readonly FanSpeed[]): string {
  const labels = speeds.map((speed) => fanSpeedLabels[speed]);
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

type FanAutoControl = Exposure['fanAutoControl'];

function fanAutoSection(draft: Draft, controls: AvailableControls, current: FanAutoControl): Child {
  // A fixed fan speed is sent with every command, so auto would not hold.
  if (!controls.hasFanAuto || (draft.fanControl === 'hidden' && draft.fanSpeedWhenHidden !== 'keep')) return null;
  const pick = (fanAutoControl: FanAutoControl): void => update(draft, { fanAutoControl });
  const isFanHidden = draft.fanControl === 'hidden';
  const switchText = `${placement(draft, 'Auto Fan', true)}. On sets the fan to auto, off puts it back at the speed it last ran at.`;
  const slowest = fanSpeedLabels[controls.fanSteps[0]];
  const fastest = fanSpeedLabels[controls.fanSteps[controls.fanSteps.length - 1]];
  const choices = isFanHidden
    ? [
        radio('fan-auto', 'native', current, 'Not shown in Matter', 'Without a fan speed in Matter, auto has no place there either.', pick),
        radio('fan-auto', 'switch', current, 'A switch', switchText, pick),
      ]
    : [
        radio('fan-auto', 'native', current, 'Native fan mode only', 'Auto is a mode of the fan speed, beside its speeds, as Matter has it.', pick),
        radio('fan-auto', 'switch', current, 'A switch', `${switchText} Auto stays a fan mode as well.`, pick),
        radio('fan-auto', 'firstStep', current, 'The first step', `Auto comes below ${slowest}: step 1, or the bottom of the slider.`, pick),
        radio('fan-auto', 'lastStep', current, 'The last step', `Auto comes above ${fastest}: the top step, or 100 %.`, pick),
      ];
  return h(
    'div',
    { class: 'field' },
    h('h3', { id: 'fan-auto-title' }, 'Auto fan speed'),
    isFanHidden ? null : h('p', { class: 'help' }, 'Matter has auto as a fan mode, which not every app shows. A switch makes it reachable there too, and a step takes its place.'),
    h('div', { 'class': 'choices', 'role': 'radiogroup', 'aria-labelledby': 'fan-auto-title' }, ...choices),
  );
}

function fanSection(draft: Draft, controls: AvailableControls): HTMLElement {
  const fanSpeeds = draft.capabilities?.fanSpeeds ?? [];
  const stepCount = controls.fanSteps.length;
  if (stepCount === 0) return h('section', {}, h('h2', {}, 'Fan speed'), h('p', { class: 'help' }, 'This unit does not let apps set its fan speed, so there is nothing to choose.'));
  const isFanHidden = draft.fanControl === 'hidden';
  // Auto is a step only of a fan control that is shown, and the step takes the place of the switch.
  const hasAutoStep = controls.hasFanAuto && !isFanHidden && (draft.fanAutoControl === 'firstStep' || draft.fanAutoControl === 'lastStep');
  const hasAutoSwitch = controls.hasFanAuto && draft.fanAutoControl === 'switch';
  let positions = controls.fanSteps;
  if (hasAutoStep) positions = draft.fanAutoControl === 'firstStep' ? ['auto', ...controls.fanSteps] : [...controls.fanSteps, 'auto'];
  // A step takes the place of the fan mode Auto.
  const hasAutoMode = controls.hasFanAuto && !hasAutoStep;
  const autoMode = hasAutoMode ? ' Auto is not among them: it is a fan mode of its own.' : '';
  // Such as "6 speeds, slowest first: Silent, Level 1 … and Level 5. Auto is not among them: it is a fan mode of its own."
  const speedList = `${positions.length} ${positions.length === 1 ? 'speed' : 'speeds'}, ${hasAutoStep ? 'in order' : 'slowest first'}: ${listSpeeds(positions)}.${autoMode}`;
  return h(
    'section',
    {},
    h('h2', {}, 'Fan speed'),
    h(
      'div',
      { class: 'choices' },
      choice('fan', 'steps', draft.fanControl, 'Steps', speedList, glyphs.steps, (fanControl) => update(draft, { fanControl })),
      choice('fan', 'percent', draft.fanControl, 'Percentage', `A slider from 0 to 100, which the plugin rounds to the nearest of ${speedList}`, glyphs.percent, (fanControl) => update(draft, { fanControl })),
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
          `${placement(draft, 'Fan', false)}, and the air conditioner has no fan speed of its own. For apps that show no fan speed on an air conditioner, or do not show it well. It always shows the speed the unit holds, also while the unit is off.`,
          (hasSeparateFan) => update(draft, { hasSeparateFan }),
        ),
    // A step of a fan that is hidden is no step.
    fanAutoSection(draft, controls, isFanHidden && !hasAutoSwitch ? 'native' : draft.fanAutoControl),
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
        `${placement(draft, 'Swing', true)}, and picks one of: ${swingModes.map((mode) => (mode === 'both' ? swingModeLabels[mode] : swingModeLabels[mode].toLowerCase())).join(', ')}. ${selectSupport}`,
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

// One row for each thermostat mode the unit lacks: which of its modes, if any, an app picking that mode runs.
function replacementFields(draft: Draft, controls: AvailableControls): HTMLElement {
  const replacements = fitModeReplacements(draft.modeReplacements, controls);
  return h(
    'div',
    { class: 'replacements' },
    ...controls.lackingModes.flatMap((shown) => {
      const id = `mode-replacement-${shown}`;
      const current = controls.switchableModes.find((mode) => replacements[mode] === shown);
      // What the other rows hold, which this one picks among.
      const others: ModeReplacements = Object.fromEntries(Object.entries(replacements).filter(([, replacement]) => replacement !== shown));
      const onchange = (event: Event): void => {
        const value = (event.target as HTMLSelectElement).value as SwitchedMode | '';
        const next: ModeReplacements = { ...others };
        if (value !== '') next[value] = shown;
        update(draft, { modeReplacements: fitModeReplacements(next, controls) });
      };
      return [
        h('label', { for: id }, modeLabels[shown]),
        h(
          'select',
          { id, onchange },
          h('option', { value: '', selected: current === undefined }, 'is not offered'),
          ...controls.switchableModes.map((mode) =>
            h(
              'option',
              { value: mode, selected: current === mode, disabled: others[mode] !== undefined || !canReplace(mode, shown, others, controls) },
              `runs ${modeLabels[mode].toLowerCase()}`,
            ),
          ),
        ),
      ];
    }),
  );
}

function modeSection(draft: Draft, controls: AvailableControls): Child {
  const { switchableModes, lackingModes } = controls;
  if (switchableModes.length === 0) return null;
  const modeSwitches = switchableModes.filter((mode) => draft.modeSwitches.includes(mode));
  const extraModes = switchableModes.filter((mode) => mode === 'dehumidify' || mode === 'fan');
  const hasSelect = extraModes.length > 0;
  // A mode select is only of use for a dry or a fan mode.
  const current = draft.modeControl === 'select' && !hasSelect ? 'native' : draft.modeControl;
  // Switches with none picked would add nothing, so picking them starts with one for each of dry and fan.
  const pick = (modeControl: Exposure['modeControl']): void => {
    if (modeControl === 'switches' && modeSwitches.length === 0) update(draft, { modeControl, modeSwitches: hasSelect ? extraModes : [...switchableModes] });
    else update(draft, { modeControl });
  };
  const fallback = switchableModes.includes('cool') ? 'cool' : 'heat';
  const extra = extraModes.map((mode) => modeLabels[mode].toLowerCase()).join(' and ');
  const switchOff = hasSelect ? `Off turns the unit off, or from ${extra} puts it back in ${fallback}.` : 'Off turns the unit off.';
  const example = `${modeLabels[modeSwitches.length > 0 ? modeSwitches[0] : switchableModes[0]]} Mode`;
  const switchPlace = draft.isComposed ? `Each appears as a part of "${draft.name}", tagged with its mode, such as "${example}".` : `Each appears as "${draft.name} ${example}", and so on.`;
  // Such as "auto, dry or heat".
  const lackingLabels = lackingModes.map((mode) => modeLabels[mode].toLowerCase());
  const lacking = lackingLabels.length === 1 ? lackingLabels[0] : `${lackingLabels.slice(0, -1).join(', ')} or ${lackingLabels[lackingLabels.length - 1]}`;
  return h(
    'section',
    {},
    h('h2', {}, 'Modes'),
    h('p', { class: 'help' }, 'Every mode of the unit is a mode of the air conditioner in Matter, but some apps, such as Apple Home and Google Home, only offer off, cool, heat and auto.'),
    h(
      'div',
      { 'class': 'choices', 'role': 'radiogroup', 'aria-label': 'Modes' },
      radio('mode-control', 'native', current, 'Native modes only', 'The modes of the unit are those of the air conditioner, as Matter has them, and nothing more is added.', pick),
      hasSelect
        ? radio('mode-control', 'select', current, 'A mode select', `${placement(draft, 'Mode', true)}, with Off and every mode of the unit, as the air conditioner has them. Picking a mode turns the unit on in it. ${selectSupport}`, pick)
        : null,
      radio('mode-control', 'switches', current, 'Switches', `A switch for each mode picked below. On turns the unit on in that mode. ${switchOff}`, pick),
      current === 'switches'
        ? h(
            'div',
            { class: 'sub' },
            chips('mode-switch', 'Modes that get a switch', switchableModes, modeSwitches, modeLabels, (picked) => update(draft, { modeSwitches: picked })),
            h('p', { class: 'help' }, switchPlace),
          )
        : null,
    ),
    // The replacements are on the thermostat, so they go with any of the choices above.
    lackingModes.length > 0
      ? h(
          'div',
          { class: 'field' },
          h('h3', {}, 'Modes the unit lacks'),
          h(
            'p',
            { class: 'help' },
            `This unit has no ${lacking}. Each can run one of its modes instead, such as heat running dry on a unit that only cools: an app then reaches that mode from the modes it offers, and nothing is added to Matter. The air conditioner shows the mode picked while the unit is in it, with its setpoint. Auto is offered once the air conditioner both cools and heats, counting these.`,
          ),
          replacementFields(draft, controls),
        )
      : null,
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
        `${placement(draft, 'Humidity', false)}, and the air conditioner keeps its humidity. For apps that show no humidity on an air conditioner, which Apple Home is reported to be.`,
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
    unitHeader(draft, `Options for ${adapterText(draft)}. Power, mode and temperature always appear in Matter: choose how the rest appears.`),
    nameSection(draft),
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
