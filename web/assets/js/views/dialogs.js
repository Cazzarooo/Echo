import { createChannel, createSpace, joinSpace } from '../actions.js';
import { desktop } from '../desktop.js';
import { h, icon, toast } from '../dom.js';

function mountDialog(body) {
  const dialog = h('dialog', { class: 'dialog' }, body);
  dialog.addEventListener('close', () => dialog.remove());
  // Clique fora do conteúdo (no fundo escurecido) fecha.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** Diálogo de um campo só. `onSubmit` recebe o texto; se lançar erro, a mensagem aparece no próprio diálogo. */
function openFormDialog({ title, text, label, placeholder = '', hint, maxLength, submitLabel, onSubmit }) {
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const input = h('input', { class: 'input', required: true, autocomplete: 'off', placeholder, maxLength });
  const submit = h('button', { class: 'button', type: 'submit' }, submitLabel);

  const form = h(
    'form',
    {
      class: 'dialog__body',
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          await onSubmit(input.value);
          dialog.close();
        } catch (failure) {
          error.textContent = failure.message;
          error.hidden = false;
          input.focus();
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('h2', { class: 'dialog__title' }, title),
    text && h('p', { class: 'dialog__text' }, text),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input, hint && h('span', { class: 'field__hint' }, hint)),
    error,
    h(
      'div',
      { class: 'dialog__actions' },
      h('button', { class: 'button button--quiet', type: 'button', onclick: () => dialog.close() }, 'Cancelar'),
      submit,
    ),
  );
  const dialog = mountDialog(form);
  input.focus();
}

export function promptCreateSpace() {
  openFormDialog({
    title: 'Criar uma roda',
    text: 'Uma roda junta as pessoas e os canais de um grupo: a família, o time, a turma.',
    label: 'Nome da roda',
    placeholder: 'Vizinhos da rua',
    maxLength: 40,
    submitLabel: 'Criar roda',
    onSubmit: createSpace,
  });
}

export function promptJoinSpace() {
  openFormDialog({
    title: 'Entrar com convite',
    text: 'Digite o código que alguém da roda te passou.',
    label: 'Código de convite',
    placeholder: 'ABCD2345',
    maxLength: 16,
    submitLabel: 'Entrar na roda',
    onSubmit: joinSpace,
  });
}

export function promptCreateChannel(space) {
  openFormDialog({
    title: 'Abrir um canal',
    text: `Um canal separa um assunto dentro de ${space.name}.`,
    label: 'Nome do canal',
    placeholder: 'avisos',
    hint: 'Espaços viram hífen e tudo fica em minúsculas.',
    maxLength: 32,
    submitLabel: 'Abrir canal',
    onSubmit: (name) => createChannel(space.id, name),
  });
}

export function openInviteDialog(space) {
  const copy = h(
    'button',
    {
      class: 'button button--quiet',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(space.inviteCode);
          copy.replaceChildren(icon('check', 16), 'Copiado');
        } catch {
          toast('Não deu para copiar sozinho. Selecione o código e copie.', 'error');
        }
      },
    },
    icon('copy', 16),
    'Copiar',
  );

  const dialog = mountDialog(
    h(
      'div',
      { class: 'dialog__body' },
      h('h2', { class: 'dialog__title' }, `Convidar para ${space.name}`),
      h('p', { class: 'dialog__text' }, 'Passe este código para quem você quer na roda. A pessoa escolhe "Entrar com convite" e digita o código.'),
      h('div', { class: 'invite-code' }, h('span', { class: 'invite-code__value' }, space.inviteCode), copy),
      h('div', { class: 'dialog__actions' }, h('button', { class: 'button', type: 'button', onclick: () => dialog.close() }, 'Pronto')),
    ),
  );
}

/** Opções que só existem na casca desktop. */
export async function openDesktopSettingsDialog() {
  let settings;
  let info;
  try {
    [settings, info] = await Promise.all([desktop.getSettings(), desktop.getInfo()]);
  } catch {
    toast('Não foi possível abrir as opções do aplicativo.', 'error');
    return;
  }

  function toggle(key, title, hint) {
    const input = h('input', {
      type: 'checkbox',
      checked: settings[key] === true,
      onchange: async () => {
        try {
          const updated = await desktop.setSetting(key, input.checked);
          input.checked = updated[key] === true;
        } catch {
          input.checked = !input.checked;
          toast('Não foi possível salvar essa opção.', 'error');
        }
      },
    });
    return h(
      'label',
      { class: 'toggle' },
      input,
      h('span', {}, h('span', { class: 'toggle__title' }, title), h('br'), h('span', { class: 'toggle__hint' }, hint)),
    );
  }

  const dialog = mountDialog(
    h(
      'div',
      { class: 'dialog__body' },
      h('h2', { class: 'dialog__title' }, 'Opções do aplicativo'),
      h(
        'div',
        {},
        toggle('minimizeToTray', 'Continuar aberto ao fechar a janela', 'O Echo fica na bandeja do sistema e segue avisando das mensagens.'),
        toggle('openAtLogin', 'Abrir junto com o computador', 'Inicia o Echo quando você entra na sua conta do sistema.'),
      ),
      h('p', { class: 'field__hint' }, `Echo para desktop, versão ${info.version}.`),
      h('div', { class: 'dialog__actions' }, h('button', { class: 'button', type: 'button', onclick: () => dialog.close() }, 'Pronto')),
    ),
  );
}
