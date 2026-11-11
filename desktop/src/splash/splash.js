// Página da tela de abertura: mostra o que o processo principal informa e deixa
// tentar de novo ou apontar para outro servidor.

const byId = (id) => document.getElementById(id);
const progress = byId('progress');
const status = byId('status');
const detail = byId('detail');
const actions = byId('actions');
const form = byId('server-form');
const input = byId('server-url');
const formError = byId('server-error');

let serverUrl = '';

function showForm(visible) {
  form.hidden = !visible;
  progress.hidden = visible;
  formError.hidden = true;
  window.EchoSplash.setEditing(visible);
  if (visible) {
    input.value = serverUrl;
    input.focus();
    input.select();
  }
}

window.EchoSplash.onState((state) => {
  serverUrl = state.serverUrl;
  detail.textContent = state.serverUrl;
  actions.hidden = state.phase !== 'error';
  if (state.phase === 'checking') status.textContent = 'Procurando o servidor…';
  else if (state.phase === 'starting') status.textContent = 'Iniciando o servidor local…';
  else if (state.phase === 'loading') status.textContent = 'Abrindo as conversas…';
  else status.textContent = state.message;
});

byId('retry').addEventListener('click', () => window.EchoSplash.retry());
byId('change').addEventListener('click', () => showForm(true));
byId('cancel').addEventListener('click', () => showForm(false));
byId('quit').addEventListener('click', () => window.EchoSplash.quit());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const accepted = await window.EchoSplash.setServer(input.value);
  if (accepted) {
    showForm(false);
  } else {
    formError.textContent = 'Esse endereço não parece válido. Exemplo: https://echo.exemplo.com';
    formError.hidden = false;
  }
});
