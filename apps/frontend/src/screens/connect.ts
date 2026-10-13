/**
 * @file apps/frontend/src/screens/connect.ts
 * @description The Connect step: the page checks an adapter and asks for what the adapter wants before it answers.
 * @author Calvin Che
 * @license Apache-2.0
 */

import { check, goHome, skipDraft } from '../actions.js';
import { button, notice, steps, unitHeader, unitStrip } from '../components.js';
import { type Child, h } from '../dom.js';
import { render } from '../render.js';
import { currentDraft, type Draft, view } from '../state.js';

/** Asks for the name of a unit whose adapter has none. */
function nameForm(draft: Draft): HTMLElement {
  const name = h('input', { type: 'text', id: 'device-name', maxLength: 32, autocomplete: 'off' });
  const submit = (): void => {
    const value = name.value.trim();
    if (value === '') return;
    if (view.setup?.devices.some((device) => device.name === value)) {
      view.error = `"${value}" is already the name of another air conditioner. Pick a different one.`;
      render();
      return;
    }
    draft.name = value;
    view.error = '';
    view.screen = 'options';
    render();
  };
  return h(
    'div',
    { class: 'field' },
    h('label', { for: 'device-name' }, 'Name this air conditioner'),
    h(
      'p',
      { class: 'help' },
      'Its adapter has no name of its own. This is the name it gets in Matter, up to 32 characters. Name the adapter in the DAIKIN Mobile Controller app later and the plugin takes that name instead.',
    ),
    h('div', { class: 'inline-form' }, name, button('Continue', submit, 'primary')),
  );
}

function lockCodeForm(draft: Draft, isRejected: boolean): HTMLElement {
  const code = h('input', { type: 'password', id: 'lock-code', inputMode: 'numeric', autocomplete: 'off', maxLength: 64 });
  return h(
    'div',
    { class: 'field' },
    h('label', { for: 'lock-code' }, 'Child lock code'),
    h('p', { class: 'help' }, 'The 4-digit code set under Child lock in the DAIKIN Mobile Controller app. It is not printed on the adapter.'),
    isRejected ? h('p', { class: 'problem-text' }, 'The adapter did not accept that code.') : null,
    h(
      'div',
      { class: 'inline-form' },
      code,
      button(
        'Check the code',
        () => {
          if (code.value === '') return;
          draft.localPassword = code.value;
          void check(draft);
        },
        'primary',
      ),
    ),
  );
}

function keyForm(draft: Draft, isRejected: boolean): HTMLElement {
  const key = h('input', { type: 'text', id: 'adapter-key', autocomplete: 'off', spellcheck: false, maxLength: 64 });
  return h(
    'div',
    { class: 'field' },
    h('label', { for: 'adapter-key' }, 'KEY on the adapter'),
    h(
      'p',
      { class: 'help' },
      'This adapter only answers apps it has registered. The KEY is printed on its label, next to the SSID, and in the operation manual. It is used once and not stored.',
    ),
    isRejected ? h('p', { class: 'problem-text' }, `The adapter did not accept that KEY. ${draft.probe?.message ?? ''}`) : null,
    h(
      'div',
      { class: 'inline-form' },
      key,
      button(
        'Register',
        () => {
          if (key.value.trim() !== '') void check(draft, key.value.trim());
        },
        'primary',
      ),
    ),
  );
}

/** What the adapter wants before the page can go on, or why the page cannot: nothing while the check has no answer. */
function credentialForm(draft: Draft): Child {
  const status = draft.probe?.status;
  if (status === 'ready' && draft.name === '') return nameForm(draft);
  if (status === 'localPasswordRequired' || status === 'localPasswordRejected') return lockCodeForm(draft, status === 'localPasswordRejected');
  if (status === 'registrationRequired' || status === 'registrationRejected') return keyForm(draft, status === 'registrationRejected');
  if (status === 'unreachable') {
    return h('p', { class: 'notice problem', role: 'alert' }, `${draft.name} did not answer at ${draft.adapter.host}. Check that it has power and is on the network, then try again.`);
  }
  if (status === 'failed') return h('p', { class: 'notice problem', role: 'alert' }, `${draft.name} answered with an error: ${draft.probe?.message ?? 'unknown'}`);
  return null;
}

export function connectScreen(): Child[] {
  const draft = currentDraft();
  if (draft === undefined) return [notice()];
  const canRetry = draft.probe?.status === 'unreachable' || draft.probe?.status === 'failed' || (view.error !== '' && draft.name !== '');
  return [
    steps(),
    unitStrip(),
    unitHeader(draft, `Connecting to its adapter at ${draft.adapter.host}.`),
    notice(),
    view.isBusy ? null : credentialForm(draft),
    h(
      'div',
      { class: 'footer' },
      canRetry ? button('Try again', () => void check(draft)) : null,
      button(draft.isNew && view.queue.length > 1 ? 'Skip this one' : 'Cancel', draft.isNew && view.queue.length > 1 ? skipDraft : goHome),
    ),
  ];
}
