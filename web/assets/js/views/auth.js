import { api } from '../api.js';
import { h } from '../dom.js';

function field(label, input, hint) {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field__label' }, label),
    input,
    hint && h('span', { class: 'field__hint' }, hint),
  );
}

/** Tela de entrada: login e cadastro no mesmo formulário. */
export function renderAuth(root, { onAuthenticated }) {
  let mode = 'login';

  const username = h('input', {
    class: 'input',
    name: 'username',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: false,
    required: true,
    maxLength: 24,
  });
  const displayName = h('input', { class: 'input', name: 'displayName', autocomplete: 'name', maxLength: 32 });
  const password = h('input', { class: 'input', name: 'password', type: 'password', required: true, maxLength: 200 });

  const displayNameField = field('Como quer ser chamado', displayName, 'É o nome que aparece nas conversas. Pode ter acento e espaço.');
  const passwordHint = h('span', { class: 'field__hint' }, 'Pelo menos 8 caracteres.');
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const title = h('h1', { class: 'auth__title' });
  const submit = h('button', { class: 'button', type: 'submit' });
  const switchLead = h('span');
  const switchButton = h('button', {
    class: 'link-button',
    type: 'button',
    onclick: () => setMode(mode === 'login' ? 'register' : 'login'),
  });

  function setMode(next) {
    mode = next;
    const registering = mode === 'register';
    error.hidden = true;
    title.textContent = registering ? 'Criar conta' : 'Entrar';
    submit.textContent = registering ? 'Criar conta' : 'Entrar';
    displayNameField.hidden = !registering;
    passwordHint.hidden = !registering;
    password.autocomplete = registering ? 'new-password' : 'current-password';
    password.minLength = registering ? 8 : 0;
    switchLead.textContent = registering ? 'Já tem conta? ' : 'Primeira vez por aqui? ';
    switchButton.textContent = registering ? 'Entrar' : 'Criar conta';
  }

  async function onSubmit(event) {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    try {
      if (mode === 'register') {
        await api.register({ username: username.value, displayName: displayName.value, password: password.value });
      } else {
        await api.login({ username: username.value, password: password.value });
      }
      await onAuthenticated();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      ({ username, displayName, password })[failure.field]?.focus();
    } finally {
      submit.disabled = false;
    }
  }

  setMode('login');
  root.replaceChildren(
    h(
      'div',
      { class: 'auth' },
      h(
        'section',
        { class: 'auth__brand' },
        h('img', { class: 'auth__mark', src: '/app/assets/icon.svg', alt: '' }),
        h('p', { class: 'auth__wordmark' }, 'Echo', h('em', {}, '.')),
        h('p', { class: 'auth__tagline' }, 'Conversa boa, em tempo real, nas suas rodas.'),
      ),
      h(
        'section',
        { class: 'auth__panel' },
        h(
          'form',
          { class: 'auth__form', onsubmit: onSubmit },
          title,
          field('Nome de usuário', username),
          displayNameField,
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Senha'), password, passwordHint),
          error,
          submit,
          h('p', { class: 'auth__switch' }, switchLead, switchButton),
        ),
      ),
    ),
  );
  username.focus();
}
