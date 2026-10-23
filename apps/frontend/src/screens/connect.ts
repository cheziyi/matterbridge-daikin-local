/**
 * @file apps/frontend/src/screens/connect.ts
 * @description The Connect step: the page checks an adapter and asks for what the adapter wants before it answers.
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

import { check, goHome, skipDraft } from '../actions.js';
import { button, notice, steps, unitHeader, unitStrip } from '../components.js';
import { type Child, h } from '../dom.js';
import { currentDraft, type Draft, view } from '../state.js';

function lockCodeForm(draft: Draft, isRejected: boolean): HTMLElement {
  const code = h('input', { type: 'password', id: 'lock-code', inputMode: 'numeric', autocomplete: 'off', maxLength: 64 });
  return h(
    'div',
    { class: 'field' },
    h('label', { for: 'lock-code' }, 'Child lock code'),
    h('p', { class: 'help' }, 'The 4-digit code set under Child lock in the Daikin app the adapter was set up with. It is not printed on the adapter.'),
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
    isRejected ? h('p', { class: 'problem-text' }, 'The adapter did not accept that KEY.') : null,
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
  if (status === 'localPasswordRequired' || status === 'localPasswordRejected') return lockCodeForm(draft, status === 'localPasswordRejected');
  if (status === 'registrationRequired' || status === 'registrationRejected') return keyForm(draft, status === 'registrationRejected');
  if (status === 'unreachable') {
    return h(
      'p',
      { class: 'notice problem', role: 'alert' },
      `${draft.name} did not answer at ${draft.adapter.host}. Check that it has power and is on the network, then try again.`,
    );
  }
  if (status === 'failed') return h('p', { class: 'notice problem', role: 'alert' }, `${draft.name} answered with an error: ${draft.probe?.message ?? 'unknown'}`);
  return null;
}

export function connectScreen(): Child[] {
  const draft = currentDraft();
  if (draft === undefined) return [notice()];
  const canRetry = draft.probe?.status === 'unreachable' || draft.probe?.status === 'failed' || view.error !== '';
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
