// Chamadas de voz, vídeo e tela.
//
// A mídia vai direto de um navegador para o outro (WebRTC): cada participante
// mantém uma conexão com cada um dos demais. O servidor só diz quem está na
// chamada e repassa os sinais com que os navegadores combinam essas conexões.
//
// A negociação segue o padrão "perfect negotiation": qualquer lado pode propor
// uma mudança (ligar a câmera, por exemplo) a qualquer momento; se os dois
// propuserem juntos, o lado "educado" cede. Quem é educado sai da comparação
// dos identificadores, então os dois lados concordam sem precisar combinar.

import { toast } from './dom.js';
import { findChannel } from './state.js';

/** Identifica esta aba nas chamadas; continua o mesmo se a conexão com o servidor cair e voltar. */
const peerId = crypto.randomUUID();

const DEVICES_KEY = 'echo:dispositivos';
/** Volume (0 a 1) a partir do qual conta como "falando", e por quanto tempo o anel fica aceso depois. */
const SPEAKING_LEVEL = 0.018;
const SPEAKING_HOLD_MS = 350;
const LEVEL_INTERVAL_MS = 100;

const listeners = new Set();
let send = () => {};

export const voice = {
  peerId,
  /** 'idle' | 'joining' | 'connected' */
  status: 'idle',
  channelId: null,
  muted: false,
  /** Fluxos locais (MediaStream) ou null. */
  microphone: null,
  camera: null,
  screen: null,
  /** peerId -> { connection, streams: Map(id -> MediaStream) } */
  peers: new Map(),
  /** peerIds de quem está falando agora (inclui o meu). */
  speaking: new Set(),
  /** Dispositivos escolhidos: ids do navegador, ou '' para o padrão do sistema. */
  devices: { microphone: '', speaker: '', camera: '' },
};

try {
  const saved = JSON.parse(localStorage.getItem(DEVICES_KEY));
  for (const kind of ['microphone', 'speaker', 'camera']) if (typeof saved?.[kind] === 'string') voice.devices[kind] = saved[kind];
} catch {
  /* sem preferência guardada: usa os dispositivos padrão */
}

let iceServers = [];
/** Elementos <audio> que tocam o som de cada fluxo remoto: id do fluxo -> elemento. */
const players = new Map();

export function subscribeVoice(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed() {
  for (const listener of [...listeners]) listener();
}

export function initVoice({ sendToGateway }) {
  send = sendToGateway;
  // Fechar a aba avisa a chamada na hora, em vez de esperar o servidor notar.
  window.addEventListener('pagehide', () => {
    if (voice.status !== 'idle') send({ type: 'voice_leave' });
  });
}

const reportState = () =>
  send({ type: 'voice_update', muted: voice.muted, camera: voice.camera?.id ?? null, screen: voice.screen?.id ?? null });

// --- quem está falando ---------------------------------------------------------
//
// Mede o volume do meu microfone e do áudio de cada participante, algumas vezes
// por segundo. Só o volume é olhado, aqui mesmo no navegador; nada é gravado.

let audioContext = null;
let levelTimer = null;
/** chave -> { peerId, streamId, analyser, samples, lastLoud } */
const meters = new Map();

function watchLevel(key, ownerPeerId, stream) {
  if (meters.has(key) || stream.getAudioTracks().length === 0) return;
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    meters.set(key, { peerId: ownerPeerId, streamId: stream.id, source, analyser, samples: new Uint8Array(analyser.fftSize), lastLoud: 0 });
    levelTimer ??= setInterval(measureLevels, LEVEL_INTERVAL_MS);
  } catch {
    /* sem medidor de volume o resto da chamada funciona igual */
  }
}

function unwatchLevel(key) {
  const meter = meters.get(key);
  if (!meter) return;
  meter.source.disconnect();
  meters.delete(key);
  if (meters.size === 0) {
    clearInterval(levelTimer);
    levelTimer = null;
  }
}

function measureLevels() {
  const now = Date.now();
  const participants = findChannel(voice.channelId)?.channel.voice ?? [];
  const talking = new Set();
  for (const meter of meters.values()) {
    // O som de uma tela compartilhada (um jogo, um vídeo) não conta como a pessoa falando.
    if (participants.some((participant) => participant.peerId === meter.peerId && participant.screen === meter.streamId)) continue;
    meter.analyser.getByteTimeDomainData(meter.samples);
    let sum = 0;
    for (const sample of meter.samples) sum += ((sample - 128) / 128) ** 2;
    if (Math.sqrt(sum / meter.samples.length) > SPEAKING_LEVEL) meter.lastLoud = now;
    if (now - meter.lastLoud < SPEAKING_HOLD_MS) talking.add(meter.peerId);
  }
  if (talking.size === voice.speaking.size && [...talking].every((id) => voice.speaking.has(id))) return;
  voice.speaking = talking;
  changed();
}

// --- dispositivos ----------------------------------------------------------------

function rememberDevices() {
  try {
    localStorage.setItem(DEVICES_KEY, JSON.stringify(voice.devices));
  } catch {
    /* vale só para esta visita */
  }
}

/** Microfones, saídas de áudio e câmeras que o navegador enxerga. Os nomes só aparecem depois da permissão. */
export async function listDevices() {
  const found = { microphone: [], speaker: [], camera: [] };
  if (!navigator.mediaDevices?.enumerateDevices) return found;
  const kinds = { audioinput: 'microphone', audiooutput: 'speaker', videoinput: 'camera' };
  for (const device of await navigator.mediaDevices.enumerateDevices()) {
    const kind = kinds[device.kind];
    if (!kind || !device.deviceId || device.deviceId === 'default' || device.deviceId === 'communications') continue;
    found[kind].push({ id: device.deviceId, label: device.label || `Dispositivo ${found[kind].length + 1}` });
  }
  return found;
}

/** Trocar a saída de áudio depende do navegador (Chrome e Edge permitem). */
export const canChooseSpeaker = 'setSinkId' in HTMLMediaElement.prototype;

async function openMicrophone() {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (voice.devices.microphone) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: voice.devices.microphone } } });
    } catch {
      /* o microfone escolhido não está mais ligado: cai no padrão */
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base });
}

async function openCamera() {
  const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
  if (voice.devices.camera) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: voice.devices.camera } } });
    } catch {
      /* a câmera escolhida não está mais ligada: cai no padrão */
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: base });
}

function applySpeaker(player) {
  if (!canChooseSpeaker) return;
  player.setSinkId(voice.devices.speaker).catch(() => {});
}

/** Escolhe um dispositivo ('' volta ao padrão do sistema) e aplica na hora se houver chamada. */
export async function chooseDevice(kind, deviceId) {
  voice.devices[kind] = deviceId;
  rememberDevices();
  if (voice.status !== 'connected') return;

  if (kind === 'speaker') {
    for (const player of players.values()) applySpeaker(player);
  } else if (kind === 'microphone') {
    let next;
    try {
      next = await openMicrophone();
    } catch {
      toast('Não foi possível usar esse microfone. Confira a permissão no navegador.', 'error');
      return;
    }
    if (voice.status !== 'connected') return stopStream(next);
    const previous = voice.microphone;
    const [track] = next.getAudioTracks();
    if (previous) {
      // Troca o que está sendo enviado sem refazer a conexão com ninguém.
      const old = new Set(previous.getTracks());
      for (const { connection } of voice.peers.values()) {
        for (const sender of connection.getSenders()) if (old.has(sender.track)) sender.replaceTrack(track);
      }
      unwatchLevel('local');
      stopStream(previous);
    } else {
      // Tinha entrado só ouvindo: agora passa a enviar áudio.
      publish(next);
      voice.muted = false;
    }
    voice.microphone = next;
    track.enabled = !voice.muted;
    watchLevel('local', peerId, next);
    reportState();
  } else if (kind === 'camera' && voice.camera) {
    await toggleCamera();
    await toggleCamera();
  }
  changed();
}

// --- entrar e sair -----------------------------------------------------------

export async function joinVoice(channelId) {
  if (voice.status !== 'idle') {
    if (voice.channelId === channelId) return;
    leaveVoice();
  }
  if (!window.RTCPeerConnection || !navigator.mediaDevices) {
    toast('Este navegador não tem suporte a chamadas.', 'error');
    return;
  }
  voice.status = 'joining';
  voice.channelId = channelId;
  voice.muted = false;
  changed();

  try {
    voice.microphone = await openMicrophone();
  } catch {
    // Sem microfone (ou sem permissão) ainda dá para entrar e ouvir.
    voice.microphone = null;
    voice.muted = true;
    toast('Sem acesso ao microfone: você entrou só ouvindo. Libere o microfone no navegador para falar.', 'error');
  }
  if (voice.status !== 'joining' || voice.channelId !== channelId) {
    // A pessoa desistiu enquanto o navegador pedia permissão.
    stopStream(voice.microphone);
    voice.microphone = null;
    return;
  }
  if (voice.microphone) watchLevel('local', peerId, voice.microphone);
  send({ type: 'voice_join', channelId, peerId });
}

export function leaveVoice() {
  if (voice.status === 'idle') return;
  send({ type: 'voice_leave' });
  reset();
}

function reset() {
  for (const id of [...voice.peers.keys()]) dropPeer(id);
  for (const key of [...meters.keys()]) unwatchLevel(key);
  for (const stream of [voice.microphone, voice.camera, voice.screen]) stopStream(stream);
  voice.microphone = null;
  voice.camera = null;
  voice.screen = null;
  voice.status = 'idle';
  voice.channelId = null;
  voice.muted = false;
  voice.speaking = new Set();
  changed();
}

function stopStream(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** A conexão com o servidor voltou: retoma o lugar na chamada (as conexões entre navegadores seguiram de pé). */
export function resumeVoice() {
  if (voice.status === 'idle') return;
  send({ type: 'voice_join', channelId: voice.channelId, peerId });
}

/** O canal da chamada foi excluído: encerra do lado de cá, sem ter a quem avisar. */
export function endVoiceIfIn(channelId) {
  if (voice.status !== 'idle' && voice.channelId === channelId) reset();
}

// --- microfone, câmera e tela ------------------------------------------------

export function toggleMute() {
  if (voice.status !== 'connected') return;
  if (!voice.microphone) {
    toast('O microfone não está liberado para este site.', 'error');
    return;
  }
  voice.muted = !voice.muted;
  for (const track of voice.microphone.getAudioTracks()) track.enabled = !voice.muted;
  reportState();
  changed();
}

function publish(stream) {
  for (const { connection } of voice.peers.values()) {
    for (const track of stream.getTracks()) connection.addTrack(track, stream);
  }
}

function unpublish(stream) {
  const tracks = new Set(stream.getTracks());
  for (const { connection } of voice.peers.values()) {
    for (const sender of connection.getSenders()) if (tracks.has(sender.track)) connection.removeTrack(sender);
  }
  stopStream(stream);
}

export async function toggleCamera() {
  if (voice.status !== 'connected') return;
  if (voice.camera) {
    unpublish(voice.camera);
    voice.camera = null;
  } else {
    try {
      voice.camera = await openCamera();
    } catch {
      toast('Não foi possível ligar a câmera. Confira a permissão no navegador.', 'error');
      return;
    }
    if (voice.status !== 'connected') return stopStream(voice.camera);
    publish(voice.camera);
  }
  reportState();
  changed();
}

function stopScreen() {
  if (!voice.screen) return;
  unpublish(voice.screen);
  voice.screen = null;
  reportState();
  changed();
}

export async function toggleScreen() {
  if (voice.status !== 'connected') return;
  if (voice.screen) return stopScreen();
  if (!navigator.mediaDevices.getDisplayMedia) {
    toast('Este navegador não compartilha a tela.', 'error');
    return;
  }
  let stream;
  try {
    // O navegador abre a própria janela de escolha: uma aba, a janela de um
    // aplicativo (um jogo, por exemplo) ou a tela inteira, com a opção de
    // mandar o som junto quando o sistema permite.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
      systemAudio: 'include',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
    });
  } catch {
    return; // a pessoa cancelou a escolha
  }
  if (voice.status !== 'connected') return stopStream(stream);
  voice.screen = stream;
  // O navegador tem o próprio botão de "parar de compartilhar".
  stream.getVideoTracks()[0]?.addEventListener('ended', stopScreen);
  publish(stream);
  reportState();
  changed();
}

// --- conexões com os outros participantes --------------------------------------

function signal(to, data) {
  send({ type: 'voice_signal', to, data });
}

function playAudio(remoteId, stream) {
  if (players.has(stream.id) || stream.getAudioTracks().length === 0) return;
  const player = new Audio();
  player.autoplay = true;
  player.srcObject = stream;
  applySpeaker(player);
  player.play().catch(() => {});
  players.set(stream.id, player);
  watchLevel(stream.id, remoteId, stream);
}

function stopAudio(streamId) {
  unwatchLevel(streamId);
  const player = players.get(streamId);
  if (!player) return;
  player.srcObject = null;
  players.delete(streamId);
}

/** `calling`: fui eu quem chegou e estou procurando o outro (em vez de responder a um sinal dele). */
function ensurePeer(remoteId, calling = false) {
  let peer = voice.peers.get(remoteId);
  if (peer) return peer;

  const connection = new RTCPeerConnection({ iceServers });
  peer = { connection, streams: new Map(), makingOffer: false, ignoreOffer: false, polite: peerId > remoteId, queue: Promise.resolve() };
  voice.peers.set(remoteId, peer);

  connection.addEventListener('negotiationneeded', async () => {
    try {
      peer.makingOffer = true;
      await connection.setLocalDescription();
      signal(remoteId, { description: connection.localDescription });
    } catch {
      /* a conexão foi fechada no meio do caminho */
    } finally {
      peer.makingOffer = false;
    }
  });
  connection.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate) signal(remoteId, { candidate });
  });
  connection.addEventListener('track', ({ streams }) => {
    const [stream] = streams;
    if (!stream) return;
    if (!peer.streams.has(stream.id)) {
      peer.streams.set(stream.id, stream);
      stream.addEventListener('removetrack', () => {
        if (stream.getTracks().length > 0) return;
        peer.streams.delete(stream.id);
        stopAudio(stream.id);
        changed();
      });
    }
    playAudio(remoteId, stream);
    changed();
  });
  connection.addEventListener('connectionstatechange', () => {
    // Se a rota entre os dois navegadores cair, tenta achar outra.
    if (connection.connectionState === 'failed') connection.restartIce();
    changed();
  });

  let sending = false;
  for (const stream of [voice.microphone, voice.camera, voice.screen]) {
    for (const track of stream?.getTracks() ?? []) {
      connection.addTrack(track, stream);
      sending = true;
    }
  }
  // Quem chega sem nada para enviar (entrou só ouvindo) ainda assim abre a conversa, pedindo para receber áudio.
  if (calling && !sending) connection.addTransceiver('audio', { direction: 'recvonly' });
  return peer;
}

function dropPeer(remoteId) {
  const peer = voice.peers.get(remoteId);
  if (!peer) return;
  for (const streamId of peer.streams.keys()) stopAudio(streamId);
  peer.connection.close();
  voice.peers.delete(remoteId);
}

// Os sinais de um mesmo participante são tratados um de cada vez, na ordem de chegada:
// uma resposta e uma nova oferta que cheguem juntas não podem se atropelar.
function onSignal(remoteId, data) {
  const peer = ensurePeer(remoteId);
  peer.queue = peer.queue.then(() => applySignal(remoteId, peer, data));
}

async function applySignal(remoteId, peer, { description, candidate }) {
  const { connection } = peer;
  try {
    if (description) {
      const collision = description.type === 'offer' && (peer.makingOffer || connection.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await connection.setRemoteDescription(description);
      if (description.type === 'offer') {
        await connection.setLocalDescription();
        signal(remoteId, { description: connection.localDescription });
      }
    } else if (candidate) {
      try {
        await connection.addIceCandidate(candidate);
      } catch (error) {
        if (!peer.ignoreOffer) throw error;
      }
    }
  } catch (error) {
    console.warn('[echo] falha ao combinar a chamada com um participante:', error);
  }
}

/** A lista de quem está na chamada mudou: fecha as conexões com quem saiu. */
export function syncVoicePeers() {
  if (voice.status !== 'connected') return;
  const present = new Set((findChannel(voice.channelId)?.channel.voice ?? []).map((participant) => participant.peerId));
  if (!present.has(peerId)) return; // a lista ainda não me inclui (ou estou voltando): não mexe em nada
  let dropped = false;
  for (const remoteId of [...voice.peers.keys()]) {
    if (present.has(remoteId)) continue;
    dropPeer(remoteId);
    dropped = true;
  }
  if (dropped) changed();
}

const ERRORS = {
  full: 'Essa chamada está cheia.',
  not_found: 'Não foi possível entrar nesse canal de voz.',
  taken: 'Não foi possível entrar na chamada. Recarregue a página e tente de novo.',
};

/** Eventos do gateway que dizem respeito às chamadas. */
export function handleVoiceEvent(event) {
  switch (event.type) {
    case 'voice_ready': {
      if (voice.status === 'idle' || event.channelId !== voice.channelId) break;
      iceServers = event.iceServers;
      const resuming = voice.status === 'connected';
      voice.status = 'connected';
      // Quem chega procura quem já estava; os outros respondem.
      for (const participant of event.participants) if (participant.peerId !== peerId) ensurePeer(participant.peerId, true);
      if (resuming || voice.muted) reportState();
      changed();
      break;
    }
    case 'voice_error':
      if (voice.status === 'idle') break;
      toast(ERRORS[event.reason] ?? 'Não foi possível entrar na chamada.', 'error');
      reset();
      break;
    case 'voice_signal':
      if (voice.status === 'connected' && event.data) onSignal(event.from, event.data);
      break;
    case 'channel_delete':
      endVoiceIfIn(event.channelId);
      break;
    default:
      break;
  }
}
