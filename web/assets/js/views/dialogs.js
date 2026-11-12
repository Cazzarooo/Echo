import { createChannel, createSpace, deleteChannel, joinSpace, renameChannel } from '../actions.js';
import { canChooseSpeaker, chooseDevice, listDevices, voice } from '../voice.js';
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

export function promptCreateChannel(space, kind = 'text') {
  const voice = kind === 'voice';
  openFormDialog({
    title: voice ? 'Abrir um canal de voz' : 'Abrir um canal',
    text: voice
      ? `Num canal de voz o pessoal de ${space.name} conversa falando, com câmera e tela se quiser.`
      : `Um canal separa um assunto dentro de ${space.name}.`,
    label: 'Nome do canal',
    placeholder: voice ? 'bate-papo' : 'avisos',
    hint: 'Espaços viram hífen e tudo fica em minúsculas.',
    maxLength: 32,
    submitLabel: 'Abrir canal',
    onSubmit: (name) => createChannel(space.id, name, kind),
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

/** Editar um canal (de texto ou de voz): trocar o nome ou excluir. Só aparece para quem criou a roda. */
export function openChannelDialog(space, channel) {
  const isVoice = channel.kind === 'voice';
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const input = h('input', { class: 'input', required: true, autocomplete: 'off', maxLength: 32, value: channel.name });
  const save = h('button', { class: 'button', type: 'submit' }, 'Salvar');
  let confirming = false;

  const fail = (failure) => {
    error.textContent = failure.message;
    error.hidden = false;
  };

  // Excluir pede um segundo clique: apaga também as mensagens, e não tem volta.
  const remove = h(
    'button',
    {
      class: 'button button--danger',
      type: 'button',
      onclick: async () => {
        if (!confirming) {
          confirming = true;
          remove.replaceChildren(icon('trash', 16), 'Clique de novo para excluir');
          return;
        }
        remove.disabled = true;
        try {
          await deleteChannel(channel.id);
          dialog.close();
        } catch (failure) {
          fail(failure);
          remove.disabled = false;
        }
      },
    },
    icon('trash', 16),
    'Excluir canal',
  );

  const form = h(
    'form',
    {
      class: 'dialog__body',
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        save.disabled = true;
        try {
          await renameChannel(channel.id, input.value);
          dialog.close();
        } catch (failure) {
          fail(failure);
          input.focus();
        } finally {
          save.disabled = false;
        }
      },
    },
    h('h2', { class: 'dialog__title' }, isVoice ? 'Editar canal de voz' : 'Editar canal'),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Nome do canal'), input, h('span', { class: 'field__hint' }, 'Espaços viram hífen e tudo fica em minúsculas.')),
    error,
    h('div', { class: 'dialog__actions' }, h('button', { class: 'button button--quiet', type: 'button', onclick: () => dialog.close() }, 'Cancelar'), save),
    h(
      'div',
      { class: 'danger-zone' },
      h('p', { class: 'field__hint' }, isVoice ? 'Excluir encerra a chamada que estiver acontecendo neste canal.' : 'Excluir apaga também todas as mensagens deste canal. Não dá para desfazer.'),
      remove,
    ),
  );
  const dialog = mountDialog(form);
  input.focus();
  input.select();
}

/** Escolha de microfone, saída de áudio e câmera. Vale na hora, inclusive no meio de uma chamada. */
export async function openVoiceSettingsDialog() {
  const devices = await listDevices().catch(() => ({ microphone: [], speaker: [], camera: [] }));

  function chooser(kind, label) {
    const options = devices[kind];
    const select = h(
      'select',
      { class: 'input', onchange: () => chooseDevice(kind, select.value) },
      h('option', { value: '' }, 'Padrão do sistema'),
      options.map((device) => h('option', { value: device.id }, device.label)),
    );
    // Um dispositivo guardado que não está mais ligado volta a aparecer como "padrão".
    select.value = options.some((device) => device.id === voice.devices[kind]) ? voice.devices[kind] : '';
    return h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), select);
  }

  const named = [...devices.microphone, ...devices.speaker, ...devices.camera].some((device) => !device.label.startsWith('Dispositivo '));
  const dialog = mountDialog(
    h(
      'div',
      { class: 'dialog__body' },
      h('h2', { class: 'dialog__title' }, 'Áudio e vídeo'),
      !named && h('p', { class: 'dialog__text' }, 'Os nomes dos aparelhos só aparecem depois que você entra numa chamada e permite o microfone neste site.'),
      chooser('microphone', 'Microfone (entrada)'),
      canChooseSpeaker
        ? chooser('speaker', 'Fone ou caixa de som (saída)')
        : h('p', { class: 'field__hint' }, 'Este navegador não deixa escolher a saída de áudio por site; troque a saída nas configurações de som do sistema.'),
      chooser('camera', 'Câmera'),
      h('div', { class: 'dialog__actions' }, h('button', { class: 'button', type: 'button', onclick: () => dialog.close() }, 'Pronto')),
    ),
  );
}
