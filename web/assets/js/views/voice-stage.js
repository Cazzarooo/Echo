import { avatar, h, icon } from '../dom.js';
import { activeChannel, activeSpace, state, subscribe } from '../state.js';
import { openVoiceSettingsDialog } from './dialogs.js';
import { joinVoice, leaveVoice, subscribeVoice, toggleCamera, toggleMute, toggleScreen, voice } from '../voice.js';

/**
 * Palco de um canal de voz: um quadro por pessoa (a câmera, ou o avatar),
 * um quadro extra para cada tela compartilhada e os controles da chamada.
 */
export function createVoiceStage() {
  const grid = h('div', { class: 'stage__grid' });
  const empty = h('p', { class: 'stage__empty' });
  const controls = h('div', { class: 'stage__controls' });
  const element = h('section', { class: 'stage', 'aria-label': 'Chamada de voz', hidden: true }, grid, empty, controls);
  /** chave do quadro -> { tile, video } (os vídeos são reaproveitados para não piscarem a cada atualização). */
  const tiles = new Map();

  function streamOf(participant, streamId) {
    if (!streamId) return null;
    if (participant.peerId === voice.peerId) return [voice.camera, voice.screen].find((stream) => stream?.id === streamId) ?? null;
    return voice.peers.get(participant.peerId)?.streams.get(streamId) ?? null;
  }

  function tileFor(key) {
    let entry = tiles.get(key);
    if (!entry) {
      // Sempre mudo: o som de cada pessoa é tocado à parte (voice.js), o quadro só mostra a imagem.
      const video = h('video', { class: 'tile__video', autoplay: true, playsInline: true, muted: true });
      const face = h('div', { class: 'tile__face' });
      const label = h('div', { class: 'tile__label' });
      entry = { tile: h('div', { class: 'tile' }, video, face, label), video, face, label };
      tiles.set(key, entry);
    }
    return entry;
  }

  function fill(entry, { person, text, stream, muted, mirrored, wide, speaking }) {
    entry.tile.classList.toggle('tile--wide', wide);
    entry.tile.classList.toggle('is-speaking', speaking);
    entry.tile.classList.toggle('has-video', stream !== null);
    entry.video.classList.toggle('is-mirrored', mirrored);
    if (entry.video.srcObject !== stream) entry.video.srcObject = stream;
    entry.face.replaceChildren(avatar(person));
    entry.label.replaceChildren(...[muted && icon('micOff', 14), text].filter(Boolean));
  }

  function controlButton(iconName, label, active, onClick, danger = false) {
    return h(
      'button',
      {
        class: ['stage__button', active && 'is-active', danger && 'is-danger'].filter(Boolean).join(' '),
        type: 'button',
        title: label,
        'aria-label': label,
        'aria-pressed': danger || iconName === 'sliders' ? null : String(active),
        onclick: onClick,
      },
      icon(iconName, 20),
    );
  }

  function render() {
    const channel = activeChannel();
    const space = activeSpace();
    const isVoice = channel?.kind === 'voice';
    element.hidden = !isVoice;
    if (!isVoice) {
      for (const { video } of tiles.values()) video.srcObject = null;
      tiles.clear();
      grid.replaceChildren();
      return;
    }

    const here = voice.status === 'connected' && voice.channelId === channel.id;
    const participants = channel.voice ?? [];
    const wanted = [];
    for (const participant of participants) {
      const person = space.members.find((member) => member.id === participant.userId);
      if (!person) continue;
      const mine = participant.peerId === voice.peerId;
      const name = mine ? `${person.displayName} (você)` : person.displayName;
      const camera = here ? streamOf(participant, participant.camera) : null;
      wanted.push([`${participant.peerId}:pessoa`, { person, text: name, stream: camera, muted: participant.muted, mirrored: mine, wide: false, speaking: voice.speaking.has(participant.peerId) }]);
      const screen = here ? streamOf(participant, participant.screen) : null;
      if (screen) wanted.push([`${participant.peerId}:tela`, { person, text: `Tela de ${person.displayName}`, stream: screen, muted: false, mirrored: false, wide: true, speaking: false }]);
    }

    const keep = new Set(wanted.map(([key]) => key));
    for (const [key, entry] of tiles) {
      if (keep.has(key)) continue;
      entry.video.srcObject = null;
      tiles.delete(key);
    }
    grid.replaceChildren(
      ...wanted.map(([key, content]) => {
        const entry = tileFor(key);
        fill(entry, content);
        return entry.tile;
      }),
    );

    empty.hidden = participants.length > 0;
    empty.textContent = 'Ninguém na chamada ainda. Entre e chame o pessoal.';

    if (here) {
      controls.replaceChildren(
        controlButton(voice.muted ? 'micOff' : 'mic', voice.muted ? 'Ligar o microfone' : 'Desligar o microfone', !voice.muted, toggleMute),
        controlButton(voice.camera ? 'camera' : 'cameraOff', voice.camera ? 'Desligar a câmera' : 'Ligar a câmera', voice.camera !== null, toggleCamera),
        controlButton('screen', voice.screen ? 'Parar de compartilhar a tela' : 'Compartilhar a tela', voice.screen !== null, toggleScreen),
        controlButton('sliders', 'Microfone, saída de áudio e câmera', false, openVoiceSettingsDialog),
        controlButton('hangup', 'Sair da chamada', false, leaveVoice, true),
      );
    } else {
      const joining = voice.status === 'joining' && voice.channelId === channel.id;
      controls.replaceChildren(
        h(
          'button',
          { class: 'button', type: 'button', disabled: joining, onclick: () => joinVoice(channel.id) },
          icon('speaker', 18),
          joining ? 'Entrando…' : 'Entrar na chamada',
        ),
        h('button', { class: 'button button--quiet', type: 'button', onclick: openVoiceSettingsDialog }, icon('sliders', 18), 'Áudio e vídeo'),
      );
    }
  }

  const unsubscribeState = subscribe((topic) => {
    if (topic === 'active' || topic === 'spaces' || topic === 'voice' || topic === 'members') render();
  });
  const unsubscribeVoice = subscribeVoice(render);
  render();

  return {
    element,
    destroy() {
      unsubscribeState();
      unsubscribeVoice();
      for (const { video } of tiles.values()) video.srcObject = null;
    },
  };
}

/** Faixa "em chamada" da barra lateral: aparece em qualquer tela enquanto a pessoa está numa chamada. */
export function createVoiceBar({ onOpen }) {
  const element = h('div', { class: 'voice-bar', hidden: true });

  function render() {
    const found = voice.status === 'idle' ? null : state.spaces.flatMap((space) => space.channels).find((channel) => channel.id === voice.channelId);
    element.hidden = !found;
    if (!found) return;
    element.replaceChildren(
      h(
        'button',
        { class: 'voice-bar__where', type: 'button', title: 'Abrir a chamada', onclick: () => onOpen(found.id) },
        h('span', { class: 'voice-bar__status' }, voice.status === 'connected' ? 'Em chamada' : 'Entrando…'),
        h('span', { class: 'voice-bar__channel' }, found.name),
      ),
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          title: voice.muted ? 'Ligar o microfone' : 'Desligar o microfone',
          'aria-label': voice.muted ? 'Ligar o microfone' : 'Desligar o microfone',
          onclick: toggleMute,
        },
        icon(voice.muted ? 'micOff' : 'mic'),
      ),
      h('button', { class: 'icon-button voice-bar__leave', type: 'button', title: 'Sair da chamada', 'aria-label': 'Sair da chamada', onclick: leaveVoice }, icon('hangup')),
    );
  }

  const unsubscribeState = subscribe((topic) => {
    if (topic === 'spaces') render();
  });
  const unsubscribeVoice = subscribeVoice(render);
  render();

  return {
    element,
    destroy() {
      unsubscribeState();
      unsubscribeVoice();
    },
  };
}
